# Deployment and operations

This guide covers the repository's Azure Container Apps deployment. Read the
[safety model](../README.md#safety-model) and the [threat model](threat-model.md) before granting
the server access to real resources.

## Contents

- [What gets deployed](#what-gets-deployed)
- [Configuration is the parameter file](#configuration-is-the-parameter-file)
- [Prerequisites](#prerequisites)
- [First deployment](#first-deployment)
- [Releasing a new image](#releasing-a-new-image)
- [Enabling guarded operations](#enabling-guarded-operations)
- [Enabling generic Bicep deployment](#enabling-generic-bicep-deployment)
- [Permissions: caller versus managed identity](#permissions-caller-versus-managed-identity)
- [GitHub OIDC for a fork](#github-oidc-for-a-fork)
- [Rotating the API key](#rotating-the-api-key)
- [Monitoring and observability](#monitoring-and-observability)
- [Cost and scale](#cost-and-scale)
- [Recovery](#recovery)
- [Troubleshooting](#troubleshooting)
- [Teardown](#teardown)

## What gets deployed

The subscription-scoped Bicep template creates:

- a resource group;
- a user-assigned managed identity for reads and the four guarded operations;
- a **second** user-assigned managed identity used only for deployments, when
  `enableDeployments=true`;
- custom RBAC role definitions limited to the verbs the server actually issues;
- an Azure Container Registry;
- a Key Vault containing the API key callers present;
- a Log Analytics workspace and a Container Apps environment;
- a storage account with two tables for deployment records, when `enableDeployments=true`;
- a Container App with external HTTPS ingress; and
- optional availability monitoring and alerts.

The operator identity receives `Reader` and `Monitoring Reader`. The custom operator role is only
assigned when `enableMutations=true`, and the deployment runner role only when
`enableDeployments=true`.

## Configuration is the parameter file

Each environment has an authoritative parameter file at
`infra/parameters/<environment>.parameters.json`. **Both** provisioning and release pass that file
on every deployment.

This matters. A deployment that specifies only some parameters silently resets the rest to the
template's defaults — which is how an image-only release used to wipe out resource group
restrictions, mutation state, alert configuration, replica counts and tags. The release script
therefore overrides exactly four values, all of which are genuinely computed at release time:
`image`, `gitSha`, `serviceVersion` and `publicBaseUrl`.

To change how an environment is configured, edit its parameter file, commit it, and run a release.
Never pass one-off `--parameters` on the command line to make a change stick.

Two things are deliberately _not_ in the parameter files, so the repository stays account-neutral:

- **Region.** Passed as an argument to the scripts and picked up by `deployment().location`.
- **`allowedSubscriptionIds`.** Omitted, so it defaults to the subscription being deployed into. Set
  it explicitly in your fork's parameter file if the server should see more than one subscription.

## Prerequisites

Install locally:

- Azure CLI, authenticated with `az login`;
- `jq`;
- Git;
- Node.js 22 or newer; and
- OpenSSL.

The deploying principal must be able to create subscription deployments, resource groups, **role
definitions and role assignments**, and the resources above, and to read Microsoft Entra user
details. In practice `Owner` at the target subscription is sufficient for bootstrap; organisation
policy may require a narrower custom role or an administrator to create the role assignments.

Confirm the target and register the providers:

```bash
az account show --query '{name:name, subscription:id, tenant:tenantId}' -o table
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights
az provider register --namespace Microsoft.Storage
```

## First deployment

From the repository root:

```bash
./scripts/bootstrap/provision.sh <subscription-id> <environment> <region>
./scripts/bootstrap/deploy.sh    <subscription-id> <environment> <region>
```

Both scripts:

1. verify you are signed in, and that the CLI resolved the subscription you asked for;
2. print the subscription, tenant, signed-in user and parameter file;
3. validate the template;
4. run what-if and summarise the changes by type;
5. list any resource that would be **deleted** and require an extra confirmation; and
6. only then deploy.

Set `ASSUME_YES=true` to skip the interactive prompts in automation. Do that only where the
what-if output is being captured and reviewed somewhere else.

`provision.sh` runs two passes because the Container App mounts the API key from Key Vault, which
cannot exist before the vault does. It generates a key only if one is not already present, and never
prints it.

After the first provision the app runs a placeholder image and `PUBLIC_BASE_URL` is unset, because
the ingress hostname does not exist until the app does. Run a release before registering the server
with any client.

## Releasing a new image

```bash
./scripts/bootstrap/deploy.sh <subscription-id> <environment> <region>
```

The release:

- warns if the working tree is dirty, because the recorded git SHA would then describe nothing;
- builds in ACR with an immutable tag derived from the commit (`sha-<12 hex>`);
- resolves the manifest **digest** and deploys `registry/repository@sha256:…`, so what runs cannot
  change underneath a tag;
- passes the environment's parameter file, preserving every setting;
- verifies `/health`, then `/ready`, then that `/version` reports the git SHA that was just built.

If `/ready` reports a component as `unavailable` the release fails and prints the component report.

## Enabling guarded operations

1. Set `"enableMutations": { "value": true }` in the environment's parameter file.
2. Commit and run a release.

This assigns the custom operator role — restart a VM, start a VM, restart a site, write tags — and
sets `MUTATIONS_ENABLED=true`. Callers must still pass `confirm: true` on every state-changing call.

## Enabling generic Bicep deployment

This is the highest-privilege capability the server has. Enable it deliberately.

1. Build an image with a verified compiler and record its digest:

   ```bash
   # Look up the release you want at https://github.com/Azure/bicep/releases and its checksum
   docker build -t atsa \
     --build-arg BICEP_VERSION=v0.30.23 \
     --build-arg BICEP_SHA256=<sha256 of bicep-linux-musl-x64> .

   docker run --rm --entrypoint cat atsa /usr/local/share/bicep.sha256
   ```

2. In the parameter file set:

   ```jsonc
   "enableDeployments": { "value": true },
   "bicepCliSha256":    { "value": "<the digest from step 1>" }
   ```

3. Run a release. This creates the deployment identity, the record storage account, and the
   deployment runner role.

4. **Grant the deployment identity the write permissions you actually intend.** The runner role only
   allows it to create ARM deployments and read resources; it cannot create anything. The provision
   script prints the principal id and an example command. Assign the narrowest role that covers the
   resource types you intend to deploy, at the narrowest scope:

   ```bash
   az role assignment create \
     --assignee-object-id <deploymentIdentityPrincipalId> \
     --assignee-principal-type ServicePrincipal \
     --role "<role covering only the resource types you intend to deploy>" \
     --scope "/subscriptions/<sub>/resourceGroups/<target-rg>"
   ```

   Templates that create role assignments additionally require a privileged role such as
   _Role Based Access Control Administrator_. **Do not grant Owner.**

Startup validation refuses to run in production with deployments enabled unless there is a pinned
compiler digest, a separate deployment identity, `azure-table` record storage and an explicit
subscription allow-list.

### Remote modules

Off by default. If you enable `bicepRemoteModulesEnabled`, you must also list the OCI registries the
compiler may pull from, or enable Template Specs. Read the
[threat model](threat-model.md#residual-risk-and-non-goals) first: you are trusting that registry,
its tags and its transport.

## Permissions: caller versus managed identity

Two different questions, answered in two different places.

| Question                            | Decided by              | Configured with                                        |
| ----------------------------------- | ----------------------- | ------------------------------------------------------ |
| May this caller talk to the server? | The server              | `AUTH_MODE`, `API_KEYS` or the Entra settings          |
| May this action happen in Azure?    | ARM                     | RBAC on the operator and deployment managed identities |
| Is this action in scope at all?     | The server's guardrails | The allow-lists and the enablement switches            |

A caller never supplies Azure credentials and cannot escalate by presenting different ones. Widening
what the server can do in Azure is always an RBAC change, made by a human, in Azure.

`azure_list_subscriptions` reports `readable` and `deployable` per subscription by asking ARM for the
effective permissions of each identity. If a subscription appears with `deployable: false`, the
deployment identity has no write access there — assign a role rather than expecting the tool to try.

## GitHub OIDC for a fork

To let a fork's workflows deploy without storing a secret:

```bash
# 1. Create an app registration and service principal in your own tenant
az ad app create --display-name "agent-tool-server-azure-<environment>"
APP_ID=$(az ad app list --display-name "agent-tool-server-azure-<environment>" --query '[0].appId' -o tsv)
az ad sp create --id "$APP_ID"

# 2. Trust GitHub's OIDC issuer for one branch or environment of YOUR fork
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<your-org>/<your-fork>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# 3. Grant it only what a deployment needs, at the narrowest scope that works
az role assignment create --assignee "$APP_ID" --role <role> --scope /subscriptions/<sub>
```

Then set `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` as repository _variables_
(not secrets — they are identifiers, not credentials), give the job
`permissions: { id-token: write, contents: read }`, and use `azure/login@v2` with
`enable-AzPSSession: false`.

Nothing in this repository assumes a particular tenant, subscription or region: every fork
configures its own.

## Rotating the API key

```bash
az keyvault secret set --vault-name <kv> --name connector-api-key --value "$(openssl rand -hex 32)"
az containerapp revision restart --name <app> --resource-group <rg> --revision <latest-revision>
```

Update every client before restarting; the old key stops working immediately. `API_KEYS` accepts a
comma-separated list, so you can run two keys briefly to make a zero-downtime rotation possible.

## Monitoring and observability

- `/health` — liveness. Used by the liveness and startup probes.
- `/ready` — readiness. Reports the registry, the record store, the pinned compiler, identity
  configuration, scopes and capabilities. Returns `503` when a required component is unavailable.
  Used by the readiness probe, so a dependency failure drains traffic without restarting a healthy
  container.
- `/metrics` — authenticated. Counters and latency summaries for tool invocations, compiler work,
  ARM what-if and deploy calls, deployments started and completed, authentication and rate limiting.
- Structured logs go to Log Analytics. Useful queries:

  ```kusto
  ContainerAppConsoleLogs_CL
  | where Log_s has 'azure.mutation'
  | project TimeGenerated, Log_s

  ContainerAppConsoleLogs_CL
  | where Log_s has 'deployment.started' or Log_s has 'deployment.state'
  | project TimeGenerated, Log_s
  ```

Set `enableHealthAlerts` with `alertEmails` or `alertSmsPhone` at deployment time to get an
availability test and alert. Do not commit personal contact details to a parameter file.

## Cost and scale

`minReplicas: 0` keeps an idle deployment nearly free: Container Apps bills per second of running
replica, so a permanently warm replica costs money around the clock whether or not anyone calls it.
The trade is a cold start of a few seconds on the first request after an idle period.

The other cost drivers are Log Analytics ingestion (capped by the workspace daily quota), ACR
storage, and — if you enable deployments — whatever those deployments create. Use Azure budgets and
policy for the last one; this server bounds what and where, not how much.

Scale out is driven by concurrent HTTP requests (`httpConcurrentRequests`). Deployment records live
outside the container, so several replicas share one view of what was approved, and per-scope locks
prevent two replicas deploying to the same scope at once.

## Recovery

**A failed deployment.** `azure_get_deployment` gives the top-level error;
`azure_list_deployment_operations` gives the specific resource and status code. Fix the template and
run a new preview — a forward fix is usually safer than a rollback.

**A bad but successful deployment.** `azure_rollback_deployment` without `confirm` produces a fresh
preview of redeploying the previous successful template, and a new confirmation hash. Review it,
then call again with `confirm: true` and that hash. Remember that this is a redeploy: deleted
resources do not come back and data-plane changes are not reverted.

**A lost preview.** Previews expire and are per principal. Re-run `azure_what_if_bicep`.

**A wedged server.** `az containerapp revision restart`. Deployment records survive, because they are
in table storage, not in the container.

**A compromised API key.** Rotate it (above) and restart the revision. Review
`ContainerAppConsoleLogs_CL` for `azure.mutation` and `deployment.*` events in the exposure window;
every one names its principal, scope and reason.

## Troubleshooting

| Symptom                                                  | Cause and fix                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container exits at startup                               | Configuration validation failed. The reason is on stderr as `invalid configuration`.                                                                                                                                                                                                                                                                        |
| `/ready` returns 503 with `bicepCompiler: unavailable`   | `BICEP_CLI_PATH` is wrong, the binary's digest does not match `BICEP_CLI_SHA256`, or the image is missing the compiler's native dependencies. The Bicep CLI is a self-contained .NET binary: on a musl base it needs `icu-libs`, `icu-data-full`, `libstdc++` and `libgcc`, and without them it aborts on startup with "Couldn't find a valid ICU package". |
| `/ready` returns 503 with `deploymentStore: unavailable` | The deployment identity lacks _Storage Table Data Contributor_, or the endpoint is wrong.                                                                                                                                                                                                                                                                   |
| `403` from a read tool                                   | The subscription or resource group is outside the allow-list, or the operator identity has no RBAC there.                                                                                                                                                                                                                                                   |
| `403` mentioning `MUTATIONS_ENABLED`                     | The environment was deployed read-only. Change the parameter file and release.                                                                                                                                                                                                                                                                              |
| `conflict` on deploy                                     | Source, parameters, scope or mode differ from the preview. Re-run what-if and get approval again.                                                                                                                                                                                                                                                           |
| `bad_request` about an expired preview                   | The confirmation hash is older than `DEPLOYMENT_PREVIEW_TTL_MS`. Re-run what-if.                                                                                                                                                                                                                                                                            |
| `conflict` about a deployment in progress                | Another deployment holds the scope lock. Wait for it.                                                                                                                                                                                                                                                                                                       |
| A subscription shows `deployable: false`                 | The deployment identity has no write RBAC there. Assign a role.                                                                                                                                                                                                                                                                                             |
| OpenAPI advertises `localhost`                           | `PUBLIC_BASE_URL` is unset. Run a release, which supplies the real hostname.                                                                                                                                                                                                                                                                                |

## Teardown

```bash
az group delete --name rg-agent-tool-server-azure-<environment> --yes
az role assignment list --assignee <identityPrincipalId> --all -o table   # then delete each
az role definition delete --name "<the custom role names from the deployment outputs>"
```

The Key Vault has purge protection enabled, so it remains recoverable for its soft-delete retention
period and its name cannot be reused until then. Custom role definitions are subscription-scoped and
are not removed with the resource group.
