# Deployment and operations

This guide covers the repository's Azure Container Apps deployment. Read the
[safety model](../README.md#safety-model) before granting the connector access to real resources.

## What gets deployed

The subscription-scoped Bicep template creates:

- a resource group;
- a user-assigned managed identity;
- an Azure Container Registry;
- a Key Vault containing the connector API key;
- a Log Analytics workspace and Container Apps environment;
- a Container App with external HTTPS ingress; and
- optional availability monitoring and alerts.

The managed identity receives `Reader` and `Monitoring Reader` by default. Operator roles are only
assigned when `enableMutations=true`.

## Prerequisites

Install the following locally:

- Azure CLI, authenticated with `az login`;
- Git;
- Node.js 22 or newer; and
- OpenSSL.

The deploying principal must be able to create subscription deployments, resource groups, role
assignments, and the resources listed above. It must also be able to read Microsoft Entra user
details. In practice, `Owner` at the target subscription is sufficient for the bootstrap flow.
Organization policies may require a narrower custom role or an administrator to create the role
assignments.

Confirm the target before proceeding:

```bash
az account show --query '{name:name, subscription:id, tenant:tenantId}' -o table
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights
```

## First deployment

From the repository root:

```bash
./scripts/bootstrap/provision.sh <subscription-id> [environment] [location]
./scripts/bootstrap/deploy.sh <subscription-id> [environment] [location]
```

The optional environment and location default to `prod` and `westeurope`. Environment names must
be 2–10 characters and should contain only characters accepted by the generated Azure resource
names.

Provisioning intentionally happens in two passes. The first pass creates the identity, registry,
vault, logs, and role assignments. The script grants the current user `Key Vault Secrets Officer`,
waits for propagation, and stores a generated API key. The second pass creates the Container App,
which reads that key directly from Key Vault.

The initial app uses a placeholder image. `deploy.sh` builds the current commit in ACR, updates the
Container App, sets its public URL, and verifies `/health`. Do not register the connector before
this step: until the real hostname is supplied, the generated OpenAPI document advertises
localhost.

## Verify the deployment

The scripts print the app and vault names. You can also discover them from the environment name:

```bash
RESOURCE_GROUP="rg-chatgpt-azure-prod"
APP_NAME="ca-chatgpt-azure-prod"
FQDN="$(az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query properties.configuration.ingress.fqdn -o tsv)"

curl -fsS "https://$FQDN/health"
curl -fsS "https://$FQDN/version"
curl -fsS "https://$FQDN/openapi.json"
```

Retrieve the connector key without printing it into shared logs:

```bash
KEY_VAULT="$(az keyvault list \
  --resource-group "$RESOURCE_GROUP" \
  --query '[0].name' -o tsv)"
API_KEY="$(az keyvault secret show \
  --vault-name "$KEY_VAULT" \
  --name connector-api-key \
  --query value -o tsv)"
curl -fsS -H "x-api-key: $API_KEY" "https://$FQDN/tools"
unset API_KEY
```

Before registration, verify that:

- the OpenAPI `servers` URL uses the public HTTPS hostname;
- `/tools` rejects requests without authentication;
- subscription and resource-group allow-lists match the intended scope;
- `mutationsEnabled` is `false` in `/version`, unless writes were explicitly approved; and
- Azure activity and application logs reach the intended workspace.

## Limit the Azure scope

`allowedSubscriptionIds` defaults to the deployment subscription. An empty
`allowedResourceGroups` list permits every resource group in the allowed subscriptions. For a
smaller blast radius, pass both values during deployment:

```bash
az deployment sub create \
  --location westeurope \
  --template-file infra/main.bicep \
  --parameters \
    environmentName=prod \
    allowedSubscriptionIds='["00000000-0000-0000-0000-000000000000"]' \
    allowedResourceGroups='["rg-app-prod","rg-observability-prod"]'
```

These application allow-lists are defense in depth; Azure RBAC remains the authorization boundary.
Review role assignments after every scope change.

## Enable state-changing tools

Enabling mutations both assigns operator roles and changes the application configuration:

```bash
az deployment sub create \
  --location westeurope \
  --template-file infra/main.bicep \
  --parameters environmentName=prod enableMutations=true
```

Keep `mutationConfirmationRequired=true`. Test each operation with `dryRun: true` first and retain
the structured mutation logs. To disable writes, redeploy with `enableMutations=false`; this
removes the operator role assignments managed by the template and disables mutation handlers.

## Updates and rollback

`deploy.sh` tags images with the current Git commit, builds them in ACR, and redeploys the app:

```bash
git checkout <reviewed-commit>
./scripts/bootstrap/deploy.sh <subscription-id> prod westeurope
```

To roll back, check out a previously reviewed commit and run the same command. Each deployment
performs a health check after the update. Confirm `/version` reports the expected commit before
closing an incident.

Infrastructure changes should be previewed before deployment:

```bash
az deployment sub what-if \
  --location westeurope \
  --template-file infra/main.bicep \
  --parameters environmentName=prod
```

## Rotate the connector API key

Generate and store a new value:

```bash
NEW_API_KEY="$(openssl rand -hex 32)"
az keyvault secret set \
  --vault-name "$KEY_VAULT" \
  --name connector-api-key \
  --value "$NEW_API_KEY" \
  --output none
unset NEW_API_KEY
```

Create a new Container App revision or restart the active revision so the Key Vault-backed secret
is re-read, then update the credential configured in ChatGPT. Verify the old key is rejected and
the new key succeeds. Avoid passing keys in command history, CI output, issue reports, or screenshots.

## Monitoring and logs

Container logs are structured JSON in Log Analytics. Tail them during an investigation:

```bash
az containerapp logs show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --follow
```

The Bicep template can create an availability test and action group. Set
`enableHealthAlerts=true` and provide `alertEmails` or `alertSmsPhone` at deployment time. Do not
commit personal contact details to a parameter file.

Monitor at least:

- `/health` availability and latency;
- HTTP 401, 403, 429, and 5xx rates;
- Azure SDK timeouts and throttling;
- mutation audit events; and
- Container App restarts and failed revisions.

## Troubleshooting

### Role assignments fail

Confirm the deploying principal can create role assignments at subscription scope. Azure Policy or
privileged identity management may also block deployment. Activate the required role and rerun the
script; Bicep deployments are incremental.

### Key Vault rejects the secret write

The bootstrap script grants `Key Vault Secrets Officer`, but RBAC propagation can take longer than
its initial wait. Confirm the assignment exists at the vault scope, wait, and rerun
`provision.sh`. An existing connector key is preserved.

### The image cannot be pulled

Confirm the managed identity has `AcrPull` on the generated registry and that the image tag exists.
Inspect the failed Container App revision and ACR build logs.

### OpenAPI advertises localhost

Run `deploy.sh`. It reads the Container App hostname and redeploys with `PUBLIC_BASE_URL`. An empty
URL is invalid configuration and should not be passed explicitly.

### Azure calls return 403

Check the managed identity's role assignments, the connector's subscription and resource-group
allow-lists, and whether the requested operation needs an operator role. Azure role changes can
take several minutes to propagate.

### The service returns 429 or 504

429 means the per-principal connector rate limit or an Azure upstream limit was reached. 504 means
the configured `REQUEST_TIMEOUT_MS` elapsed. Reduce request volume, retry with backoff, and inspect
the logs before raising limits or timeouts.

## Remove an environment

Export any required logs first. Deleting the generated resource group removes the app, registry,
vault, and workspace:

```bash
az group delete --name rg-chatgpt-azure-prod
```

Review subscription-level role assignments after deletion and remove any orphaned assignments.
Also remove the connector registration from ChatGPT and revoke any copied API key.
