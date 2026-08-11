# Azure Agent Tool Server

A secure, backend-only MCP and OpenAPI server for Azure operations. It gives AI clients a small,
typed tool surface for inventory, diagnostics, metrics, health triage, and deliberately constrained
operational actions. The hosted server authenticates to Azure with managed identity rather than
storing Azure credentials in application configuration.

There is no frontend. ChatGPT can import the generated OpenAPI document, MCP clients can use local
stdio or remote Streamable HTTP, and every transport invokes the same validated tool registry and
guardrails.

```
AI client
   │  authenticated tool request
   ▼
agent-tool-server-azure  ── HTTP/OpenAPI and MCP transports
   │                      ── tool registry (Zod-validated input/output)
   │                      ── services (inventory / diagnostics / operations + guardrails)
   ▼
Azure provider adapter
   │  Managed Identity
   ▼
Azure SDK / ARM / Resource Graph
```

---

## Design

| Layer     | Location                | Responsibility                                                                                                        |
| --------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Transport | `src/server`, `src/mcp` | HTTP routing, auth, rate limiting, error mapping. No Azure knowledge.                                                 |
| Tools     | `src/tools`             | Declarative tool definitions with Zod schemas; a registry that validates input and erases types for transports.       |
| Services  | `src/services`          | Business logic and guardrails: inventory, diagnostics, constrained operations.                                        |
| Provider  | `src/provider`          | The `AzureProvider` port and its Azure SDK implementation. The only layer that knows about Azure SDK types.           |
| Config    | `src/config`            | Zod-validated environment; the process fails fast on misconfiguration.                                                |
| OpenAPI   | `src/openapi`           | Generates the OpenAPI 3.1 document from the tool registry, so the HTTP surface can never drift from the tool surface. |

Two rules keep the design honest:

1. **Provider logic never lives in a transport.** Adding MCP required no changes to any service.
2. **Everything below the transport throws `AppError`.** Both transports map that taxonomy to their
   own error representation in exactly one place.

---

## Safety model

The connector is designed to be given real credentials in a real environment, so the blast radius
is bounded in several independent ways:

- **Azure RBAC** — the managed identity gets `Reader` + `Monitoring Reader` by default. Operator
  roles (`Virtual Machine Contributor`, `Website Contributor`, `Tag Contributor`) are only assigned
  when the infrastructure is deployed with `enableMutations=true`.
- **Allow-lists** — `AZURE_SUBSCRIPTION_IDS` and `AZURE_ALLOWED_RESOURCE_GROUPS` are enforced in
  the service layer for every read and every write, including the raw Resource Graph escape hatch.
- **Mutations off by default** — `MUTATIONS_ENABLED=false` means every state-changing tool refuses
  to act. Dry runs still work, so ChatGPT can explain exactly what it _would_ do.
- **Explicit confirmation** — with mutations enabled, a write still requires `confirm: true`.
  Write operations are marked `x-openai-isConsequential: true` in the OpenAPI document.
- **Type checking** — a restart tool verifies the target's ARM type before acting.
- **Injection-safe queries** — structured search builds KQL with escaped literals; the raw query
  tool rejects mutating KQL operators.
- **Audit logging** — every mutation (real or dry run) is logged as structured JSON with the
  resource id, the caller principal, the request id and the caller's stated reason.

---

## Tools

Read-only:

| Tool                             | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `azure_list_subscriptions`       | Subscriptions visible to the connector.                 |
| `azure_list_resource_groups`     | Resource groups in a subscription.                      |
| `azure_search_resources`         | Structured resource search (type, name, location, tag). |
| `azure_get_resource`             | One resource with its properties.                       |
| `azure_run_graph_query`          | Read-only Resource Graph (KQL) escape hatch.            |
| `azure_get_activity_log`         | Recent control-plane changes.                           |
| `azure_get_resource_metrics`     | Azure Monitor metric time series.                       |
| `azure_list_unhealthy_resources` | Resource Health triage.                                 |

State-changing (gated):

| Tool                            | Purpose                                |
| ------------------------------- | -------------------------------------- |
| `azure_restart_virtual_machine` | Restart a VM.                          |
| `azure_start_virtual_machine`   | Start a stopped VM.                    |
| `azure_restart_web_app`         | Restart an App Service / Function App. |
| `azure_tag_resource`            | Merge tags onto a resource.            |

---

## HTTP API

| Method | Path                | Auth | Description                                     |
| ------ | ------------------- | ---- | ----------------------------------------------- |
| `GET`  | `/health`           | no   | Liveness probe.                                 |
| `GET`  | `/version`          | no   | Build metadata and effective capabilities.      |
| `GET`  | `/openapi.json`     | no   | OpenAPI 3.1 document for the ChatGPT connector. |
| `GET`  | `/tools`            | yes  | Tool catalogue with JSON Schemas.               |
| `POST` | `/tools/{toolName}` | yes  | Invoke a tool.                                  |
| `POST` | `/mcp`              | yes  | Stateless MCP Streamable HTTP endpoint.         |

Tool input may be sent either bare or wrapped in an `input` envelope:

```bash
curl -sS "https://<host>/tools/azure_search_resources" \
  -H "x-api-key: <connector-api-key>" \
  -H 'content-type: application/json' \
  -d '{"resourceType":"microsoft.web/sites","limit":10}'
```

The `authorization` request header with a bearer token is accepted as an equivalent to
`x-api-key`, which is what the ChatGPT connector UI sends.

Successful responses are `{ "tool", "requestId", "result" }`. Failures use a single envelope:

```json
{
  "error": {
    "code": "forbidden",
    "message": "Subscription ... is outside the connector's allow-list",
    "details": { "allowedSubscriptionIds": ["..."] },
    "retryable": false,
    "requestId": "9f1c..."
  }
}
```

Codes map to HTTP status: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404,
`conflict` 409, `rate_limited` 429, `internal_error` 500, `upstream_error` 502, `timeout` 504.

---

## Configuration

All configuration is environment based and validated at startup — see `.env.example` for the
annotated list.

| Variable                                                       | Default                  | Notes                                                                         |
| -------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------- |
| `PORT` / `HOST`                                                | `8080` / `0.0.0.0`       | HTTP listener.                                                                |
| `LOG_LEVEL`                                                    | `info`                   | pino level.                                                                   |
| `PUBLIC_BASE_URL`                                              | –                        | Server URL advertised in the OpenAPI document.                                |
| `AUTH_MODE`                                                    | `api-key`                | `api-key`, `entra-jwt`, or `disabled` (rejected in production).               |
| `API_KEYS`                                                     | –                        | Comma-separated keys, each at least 32 characters. Compared in constant time. |
| `ENTRA_TENANT_ID` / `ENTRA_AUDIENCE` / `ENTRA_ALLOWED_APP_IDS` | –                        | For `entra-jwt`.                                                              |
| `AZURE_CLIENT_ID` / `AZURE_TENANT_ID`                          | –                        | User-assigned managed identity; omit locally to use `az login`.               |
| `AZURE_SUBSCRIPTION_IDS`                                       | _(empty = unrestricted)_ | Subscription allow-list.                                                      |
| `AZURE_ALLOWED_RESOURCE_GROUPS`                                | _(empty = unrestricted)_ | Resource group allow-list.                                                    |
| `MUTATIONS_ENABLED`                                            | `false`                  | Master switch for state-changing tools.                                       |
| `MUTATION_CONFIRMATION_REQUIRED`                               | `true`                   | Require `confirm: true` per call.                                             |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`                      | `120` / `60000`          | Per-principal fixed window; `0` disables.                                     |
| `REQUEST_TIMEOUT_MS`                                           | `30000`                  | Upstream ARM timeout.                                                         |

---

## Local development

Requires Node.js 22+.

```bash
npm install
cp .env.example .env          # then edit
az login                      # DefaultAzureCredential falls back to your CLI session
npm run dev
```

Useful scripts:

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (type-aware)
npm run format        # prettier
npm test              # vitest
npm run test:coverage # vitest + v8 coverage
npm run build         # tsc -> dist/
npm start             # run the built server
npm run openapi:emit  # print the OpenAPI document (optionally to a file)
npm run mcp:stdio     # run the same tools over MCP stdio
```

Docker:

```bash
docker build -t agent-tool-server-azure .
docker run --rm -p 8080:8080 \
  -e API_KEYS="$(openssl rand -hex 32)" agent-tool-server-azure
```

---

## Deploying to Azure

Infrastructure lives in `infra/` (Bicep, subscription-scoped) and provisions a user-assigned
managed identity, an Azure Container Registry, a Key Vault holding the connector API key, a Log
Analytics workspace, and a Container App running the connector with the identity attached.

### Existing deployment compatibility

The public project identity is `agent-tool-server-azure`, but existing Azure resources deliberately
retain their original `chatgpt-azure` names. Renaming a resource group, Container App, environment,
identity, registry, workspace, Key Vault, or monitoring resource would recreate infrastructure,
change the connector hostname, or disconnect secrets and role assignments. The bootstrap scripts
therefore continue to discover resources such as `rg-chatgpt-azure-prod` and
`ca-chatgpt-azure-prod`. These are compatibility identifiers, not stale repository or package
branding. New image builds use the `agent-tool-server-azure` repository inside the existing ACR.

```bash
# 1. Provision infrastructure and generate the connector API key
./scripts/bootstrap/provision.sh <subscription-id> prod westus2

# 2. Build the image in ACR and redeploy the Container App
./scripts/bootstrap/deploy.sh <subscription-id> prod westus2
```

`provision.sh` deploys in two passes on purpose. The Container App mounts `connector-api-key`
directly out of Key Vault, so it cannot be created before that secret exists; the first pass runs
with `deployApp=false` to create the vault and the identity, the script writes the secret, and the
second pass brings the app up. The script also grants the invoking user **Key Vault Secrets
Officer** on the vault — the vault uses RBAC authorisation, so being subscription Owner does not
by itself grant data-plane access to write the secret.

`PUBLIC_BASE_URL` is deliberately absent until `deploy.sh` runs: the ingress hostname does not
exist until the app does. The connector starts fine without it, but the OpenAPI document then
advertises `http://localhost:8080`, so **register the connector in ChatGPT only after `deploy.sh`**,
which supplies the real hostname. Optional settings are omitted rather than passed as empty
strings — an empty `PUBLIC_BASE_URL` would fail `z.url()` and crash-loop the container.

### Cost and monitoring

The Container App defaults to zero idle replicas and 0.25 vCPU / 0.5 GiB, so compute is billed only
while requests are served; the first request after an idle period can incur a cold start. Log
Analytics has a 1 GB/day ingestion cap. Availability alerts are opt-in because they require an
explicit notification destination. Azure Container Registry is a fixed-cost resource and does not
scale to zero.

> CI validates the templates with `az bicep build` and the linter, which check syntax and never
> attempt a deployment. Green CI does not prove the templates deploy.

To grant operator permissions, redeploy with `enableMutations=true` — this both assigns the
operator roles and flips `MUTATIONS_ENABLED` in the Container App:

```bash
az deployment sub create \
  --location westus2 \
  --template-file infra/main.bicep \
  --parameters infra/parameters/prod.parameters.json enableMutations=true
```

### Registering the connector in ChatGPT

1. Retrieve the connector API key from Key Vault
   (`az keyvault secret show --vault-name <kv> --name connector-api-key --query value -o tsv`).
2. Point ChatGPT at `https://<connector-host>/openapi.json`.
3. Configure authentication as a bearer token using that key.

The four state-changing operations are marked `x-openai-isConsequential: true`, so ChatGPT will
prompt for confirmation before invoking them. They additionally refuse to run unless the
deployment set `enableMutations=true`.

---

## MCP

The same registry is served over MCP, so local and remote clients use identical tools and
guardrails.

Local stdio:

```bash
npm run build
npm run mcp:stdio
# Once the npm package is published: npx agent-tool-server-azure-mcp
```

Remote Streamable HTTP:

```text
https://<connector-host>/mcp
```

Send the same bearer token or `x-api-key` used by `/tools`. The endpoint is stateless, authenticated
and rate limited, which allows Container Apps to scale it horizontally. Read tools are annotated
`readOnlyHint`, write tools `destructiveHint`; the guardrails are the same objects used by the HTTP
transport.

---

## Template, registry, and publication

- [`agent-tool-server-template`](https://github.com/ashergarland/agent-tool-server-template) owns the
  reusable architecture, security, testing, and deployment scaffold.
- [`agent-tool-server-registry`](https://github.com/ashergarland/agent-tool-server-registry) owns the
  curated family catalog, schema, and registration lifecycle. This server has no runtime dependency
  on that registry.
- This repository owns its implementation and `server.json`. The manifest intentionally contains no
  npm package, remote endpoint, or container distribution: none has been published as a stable
  public distribution yet.

Before publishing a release, publish the npm package and an immutable OCI image, add only the
verified distributions to `server.json`, validate it with `mcp-publisher validate`, and then publish
it with `mcp-publisher publish`. The central registry entry must then be reconciled with this
repository's final manifest and tool list; publication in npm, the official MCP Registry, or
Docker's catalog is separate from inclusion in the curated family registry.

---

## Repository layout

```
src/
  app.ts                 composition root
  index.ts               HTTP entry point
  errors.ts              transport-agnostic error taxonomy
  config/                Zod-validated environment
  server/                Fastify transport, auth, rate limiting, error mapping
  tools/                 tool definitions + registry
  services/              inventory, diagnostics, operations, guardrails
  provider/              AzureProvider port + Azure SDK adapter
  openapi/               OpenAPI 3.1 generation
  mcp/                   MCP server + stdio entry point
  util/                  logging
infra/                   Bicep templates, modules and parameter files
scripts/bootstrap/       provisioning and deployment scripts
tests/                   unit and integration tests
```
