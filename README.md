# agent-tool-server-azure

[![CI](https://github.com/ashergarland/agent-tool-server-azure/actions/workflows/ci.yml/badge.svg)](https://github.com/ashergarland/agent-tool-server-azure/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A backend-only **agent tool server for Azure**. It gives an agent a small, typed, guard-railed way
to inspect, diagnose, operate and deploy an Azure environment, authenticating to Azure with managed
identities and never with secrets in configuration.

There is no frontend. The same validated tool registry is served over three transports:
authenticated HTTP with an OpenAPI 3.1 document, stdio MCP, and authenticated stateless Streamable
HTTP MCP.

> [!IMPORTANT]
> Mutations and generic deployment are **disabled by default**, and the Azure roles that would make
> them possible are not assigned unless you deliberately enable them. Read the
> [threat model](docs/threat-model.md) before pointing this at a subscription you care about.

## Contents

- [How it works](#how-it-works)
- [Safety model](#safety-model)
- [Available tools](#available-tools)
- [Quick start](#quick-start)
- [HTTP API](#http-api)
- [Remote MCP and coding clients](#remote-mcp-and-coding-clients)
- [Bicep deployment tools](#bicep-deployment-tools)
- [Configuration](#configuration)
- [Deploying to Azure](#deploying-to-azure)
- [Contributing and security](#contributing-and-security)

```
agent (ChatGPT, a coding client, anything that speaks MCP or HTTP)
   │  authenticated tool request
   ▼
agent-tool-server-azure
   │  transports         HTTP/OpenAPI · stdio MCP · Streamable HTTP MCP
   │  tool registry      one Zod-validated definition per tool, input and output
   │  services           inventory · diagnostics · operations · deployments · guardrails
   │  boundaries         Bicep bundle validation, pinned compiler, ARM inspection
   ▼
Azure provider adapter
   │  operator managed identity        │  deployment managed identity
   ▼                                   ▼
Azure SDK · ARM · Resource Graph       ARM deployments
```

---

## How it works

| Layer       | Location                | Responsibility                                                                                 |
| ----------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| Transport   | `src/server`, `src/mcp` | Routing, authentication, rate limiting, error mapping. No Azure knowledge.                     |
| Tools       | `src/tools`             | Declarative definitions with Zod schemas, routing guidance and MCP annotations; the registry.  |
| Services    | `src/services`          | Inventory, diagnostics, constrained operations, deployments, and the guardrails they consult.  |
| Bicep       | `src/bicep`             | Bundle validation, materialisation, the pinned compiler adapter, ARM template inspection.      |
| Deployments | `src/deployments`       | Deployment records: the port plus in-memory and Azure Table implementations.                   |
| Provider    | `src/provider`          | The `AzureProvider` port and its Azure SDK adapter. The only layer that knows Azure SDK types. |
| Config      | `src/config`            | Zod-validated environment; the process fails fast on misconfiguration.                         |
| OpenAPI     | `src/openapi`           | Generates the OpenAPI 3.1 document from the registry, so HTTP can never drift from the tools.  |

Three rules keep the design honest:

1. **The registry is the only source of truth.** Names, descriptions, annotations, input and output
   schemas, HTTP routes and OpenAPI operations all come from it. A parity test asserts that every
   transport publishes byte-identical contracts.
2. **Provider logic never lives in a transport.** Adding remote MCP required no change to any
   service.
3. **Everything below the transport throws `AppError`.** Each transport maps that taxonomy to its
   own representation in exactly one place.

---

## Safety model

This server is designed to be given real credentials in a real environment, so the blast radius is
bounded in several independent ways.

**Caller authentication and Azure authorisation are separate concerns.** An API key or an Entra
token says which _caller_ is talking to the server. What that call may do in Azure is decided by
ARM, evaluating the server's own managed identity. A caller can never present Azure credentials;
the deployment tools reject unknown input fields outright.

- **Two identities.** Reads and the four guarded operations use one user-assigned managed identity.
  Generic Bicep deployment uses a second one. The broad write permissions a deployment needs are
  never available to the read and operator surface.
- **Least-privilege roles.** Reads use `Reader` and `Monitoring Reader`. Writes use a custom role
  containing exactly `virtualMachines/restart/action`, `virtualMachines/start/action`,
  `sites/restart/action` and `tags/write` — not Virtual Machine Contributor, Website Contributor or
  Tag Contributor, all of which also allow creation and deletion.
- **Allow-lists.** Subscriptions, resource groups and management groups are enforced in the service
  layer for every read and every write, including the raw Resource Graph escape hatch and every
  scope a nested deployment tries to reach.
- **Honest capability reporting.** `azure_list_subscriptions` asks ARM what each identity can
  actually do and reports `readable` and `deployable` per subscription, so an agent never plans work
  in a subscription that will 403 halfway through.
- **Off by default.** `MUTATIONS_ENABLED=false` and `DEPLOYMENTS_ENABLED=false`. Dry runs and
  template validation still work, so an agent can explain exactly what it _would_ do.
- **Preview bound to execution.** A deployment only proceeds with a `confirmationHash` produced by a
  recent what-if over identical source, parameters, scope and mode. Any difference is refused.
- **No code execution.** No shell tool, no Azure CLI tool, no arbitrary REST tool, no arbitrary
  container. Templates that declare `Microsoft.Resources/deploymentScripts`, reference a linked
  template, or point at an external script or content URL are rejected before Azure sees them.
- **Injection-safe queries.** Structured search builds KQL from escaped literals; the raw query tool
  rejects mutating and external-data operators.
- **Redaction.** Secure parameter values, sensitive-looking parameter and output names, credentials
  and internal paths never appear in results, records or logs.
- **Audit logging.** Every mutation and every deployment step is logged as structured JSON with the
  principal, action, scope, hashes, resource types, reason, outcome and request id.

---

## Available tools

**Discovery and search**

| Tool                         | Purpose                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `azure_list_subscriptions`   | Subscriptions, with `readable` and `deployable` flags.  |
| `azure_list_resource_groups` | Resource groups in a subscription.                      |
| `azure_search_resources`     | Structured resource search (type, name, location, tag). |
| `azure_get_resource`         | One resource with its properties.                       |
| `azure_run_graph_query`      | Read-only Resource Graph aggregation escape hatch.      |

**Diagnosis**

| Tool                             | Purpose                           |
| -------------------------------- | --------------------------------- |
| `azure_get_activity_log`         | Recent control-plane changes.     |
| `azure_get_resource_metrics`     | Azure Monitor metric time series. |
| `azure_list_unhealthy_resources` | Resource Health triage.           |

**Guarded operations** (require `MUTATIONS_ENABLED` and `confirm: true`)

| Tool                            | Purpose                                |
| ------------------------------- | -------------------------------------- |
| `azure_restart_virtual_machine` | Restart a VM.                          |
| `azure_start_virtual_machine`   | Start a stopped VM.                    |
| `azure_restart_web_app`         | Restart an App Service / Function App. |
| `azure_tag_resource`            | Merge tags onto a resource.            |

**Generic Bicep deployment** (require `DEPLOYMENTS_ENABLED`)

| Tool                               | Purpose                                                    |
| ---------------------------------- | ---------------------------------------------------------- |
| `azure_validate_bicep`             | Compile and statically check source. Never contacts Azure. |
| `azure_what_if_bicep`              | ARM what-if, plus the confirmation hash.                   |
| `azure_deploy_bicep`               | Apply a previewed and approved deployment.                 |
| `azure_get_deployment`             | Status, outputs and errors.                                |
| `azure_list_deployment_operations` | Per-resource operations, paginated.                        |
| `azure_rollback_deployment`        | Preview and redeploy a previously successful template.     |

Every tool carries structured routing guidance — when to use it, when not to, the scope it needs,
and whether it changes state — which is rendered into the description agents actually read.

---

## Quick start

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or newer and npm
- An Azure account and the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
- Azure CLI access to at least one subscription (`az login`)
- Docker, only if you want to build or run the container locally

```bash
git clone https://github.com/ashergarland/agent-tool-server-azure.git
cd agent-tool-server-azure
npm ci
cp .env.example .env
az login
npm run dev
```

Replace `API_KEYS` in `.env` with a random value of at least 32 characters before starting. The
default configuration is read-only. Set `AZURE_SUBSCRIPTION_IDS` and
`AZURE_ALLOWED_RESOURCE_GROUPS` before using the server against real resources.

Locally the server authenticates to Azure through `DefaultAzureCredential`, which picks up your
`az login` session. Nothing is read from a secret file.

In another terminal:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/ready
curl -H "x-api-key: <your-api-key>" http://localhost:8080/tools
```

---

## HTTP API

| Method                | Path                | Auth | Description                                            |
| --------------------- | ------------------- | ---- | ------------------------------------------------------ |
| `GET`                 | `/health`           | no   | Liveness. Is the process up?                           |
| `GET`                 | `/ready`            | no   | Readiness. Can it do its job? `503` when it cannot.    |
| `GET`                 | `/version`          | no   | Build metadata and effective capabilities.             |
| `GET`                 | `/openapi.json`     | no   | OpenAPI 3.1 document.                                  |
| `GET`                 | `/tools`            | yes  | Tool catalogue, annotations, routing and JSON Schemas. |
| `POST`                | `/tools/{toolName}` | yes  | Invoke a tool.                                         |
| `GET`                 | `/metrics`          | yes  | Counters and latency summaries.                        |
| `POST`/`GET`/`DELETE` | `/mcp`              | yes  | Stateless Streamable HTTP MCP.                         |

Tool input may be sent bare or wrapped in an `input` envelope:

```bash
curl -sS "https://<host>/tools/azure_search_resources" \
  -H "x-api-key: <api-key>" \
  -H 'content-type: application/json' \
  -d '{"resourceType":"microsoft.web/sites","limit":10}'
```

An `authorization: Bearer <key>` header is accepted as an equivalent to `x-api-key`.

Successful responses are `{ "tool", "requestId", "result" }`. Failures use one envelope:

```json
{
  "error": {
    "code": "forbidden",
    "message": "Subscription ... is outside the server's allow-list",
    "details": { "allowedSubscriptionIds": ["..."] },
    "retryable": false,
    "requestId": "9f1c..."
  }
}
```

Codes map to HTTP status: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404,
`conflict` 409, `rate_limited` 429, `internal_error` 500, `upstream_error` 502, `timeout` 504.

### ChatGPT

1. Deploy behind HTTPS and set `PUBLIC_BASE_URL` so the document advertises the right server.
2. Retrieve the API key from Key Vault.
3. Point ChatGPT at `https://<host>/openapi.json` and configure bearer token authentication.

Every state-changing operation is marked `x-openai-isConsequential: true`, so ChatGPT prompts before
invoking it, and the server independently refuses unless the deployment enabled it.

---

## Remote MCP and coding clients

**Remote (Streamable HTTP).** The `/mcp` endpoint is stateless: a fresh MCP server and transport are
created per request and closed when it completes, which is what lets the deployment scale to zero
and run several replicas without sticky routing. Authentication, rate limiting and audit are the
same as for `/tools`.

```jsonc
{
  "mcpServers": {
    "azure": {
      "type": "http",
      "url": "https://<host>/mcp",
      "headers": { "Authorization": "Bearer <api-key>" },
    },
  },
}
```

**Local (stdio).** Runs with your own `az login` session and needs no API key:

```jsonc
{
  "mcpServers": {
    "azure": {
      "command": "node",
      "args": ["/path/to/agent-tool-server-azure/dist/mcp/stdio.js"],
      "env": {
        "AUTH_MODE": "disabled",
        "AZURE_SUBSCRIPTION_IDS": "<subscription-id>",
      },
    },
  },
}
```

Build first with `npm run build`. `AUTH_MODE=disabled` is only about the _caller_: Azure still
evaluates your own identity, and the allow-lists still apply.

[`server.json`](server.json) carries the MCP registry metadata for this server.

---

## Bicep deployment tools

Generic deployment accepts a **bounded virtual bundle** — a `mainFile` plus relative UTF-8 files —
never a path on disk, a URL or a registry reference. The workflow is always the same:

```
azure_validate_bicep  →  azure_what_if_bicep  →  (human approval)  →  azure_deploy_bicep
                                                                       ↓
                                                              azure_get_deployment
```

`azure_what_if_bicep` returns a `confirmationHash` covering the exact source, parameters, scope,
mode and the preview the user saw. `azure_deploy_bicep` recompiles what it is sent, recomputes that
hash, and refuses anything that differs. Previews expire.

**What is rejected.** Absolute paths, `..` traversal, duplicate normalised paths, reserved device
names, invalid encoding, disallowed file types, a caller-supplied `bicepconfig.json`, and bundles
that exceed the configured file count or size. In the compiled template:
`Microsoft.Resources/deploymentScripts`, linked or external templates and parameter files, external
script and content URLs, Complete mode, unsupported or non-allow-listed scopes, and any structure
that cannot be bounded or inspected.

**Modules.** Local modules inside the bundle work normally. Remote module restore is disabled by
default; when enabled it is limited to configured OCI registries or Template Specs. See the
[threat model](docs/threat-model.md).

**Compilation.** A pinned, checksum-verified official Bicep CLI is installed into the image at build
time and invoked directly — no shell, no inherited environment, non-root, in an unpredictable
temporary directory that is always removed, under time, output and concurrency limits. The server
never downloads a compiler at runtime.

**Rollback is a redeploy, not an undo.** It reapplies a previously successful template after a fresh
preview and a new confirmation. It does not restore deleted resources, revert data-plane changes, or
undo anything done outside this server. Secure parameter values are never stored, so a rollback
requires them to be supplied again.

---

## Configuration

All configuration is environment based and validated at startup; see [`.env.example`](.env.example)
for the annotated list. The most important entries:

| Variable                                                    | Default                  | Notes                                                             |
| ----------------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| `AUTH_MODE`                                                 | `api-key`                | `api-key`, `entra-jwt`, or `disabled` (rejected in production).   |
| `API_KEYS`                                                  | –                        | Comma-separated, each ≥ 32 characters, compared in constant time. |
| `AZURE_CLIENT_ID`                                           | –                        | Operator managed identity; omit locally to use `az login`.        |
| `AZURE_DEPLOYMENT_CLIENT_ID`                                | –                        | Separate deployment identity. Required in production.             |
| `AZURE_SUBSCRIPTION_IDS`                                    | _(empty = unrestricted)_ | Allow-list. Deployments require it to be set.                     |
| `AZURE_ALLOWED_RESOURCE_GROUPS`                             | _(empty = unrestricted)_ | Allow-list.                                                       |
| `AZURE_ALLOWED_MANAGEMENT_GROUP_IDS`                        | _(empty = disabled)_     | Required for management group scope deployments.                  |
| `AZURE_TENANT_DEPLOYMENTS_ENABLED`                          | `false`                  | Tenant scope deployments.                                         |
| `AZURE_VERIFY_RBAC`                                         | `true`                   | Ask ARM what each identity can do before reporting a scope.       |
| `MUTATIONS_ENABLED` / `MUTATION_CONFIRMATION_REQUIRED`      | `false` / `true`         | The four guarded operations.                                      |
| `MCP_HTTP_ENABLED`                                          | `true`                   | The `/mcp` endpoint.                                              |
| `DEPLOYMENTS_ENABLED`                                       | `false`                  | Generic Bicep deployment.                                         |
| `BICEP_CLI_PATH` / `BICEP_CLI_SHA256`                       | – / –                    | The pinned compiler. The digest is required in production.        |
| `BICEP_REMOTE_MODULES_ENABLED` / `BICEP_ALLOWED_REGISTRIES` | `false` / –              | Remote module restore.                                            |
| `DEPLOYMENT_RECORD_STORE`                                   | `memory`                 | `azure-table` is required in production.                          |
| `DEPLOYMENT_PREVIEW_TTL_MS`                                 | `900000`                 | How long a confirmation hash stays valid.                         |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`                   | `120` / `60000`          | Per-principal fixed window; `0` disables.                         |
| `HTTP_MAX_BODY_BYTES`                                       | `4194304`                | Bicep bundles need headroom.                                      |

Production configuration is checked at startup: enabling deployments in production without a pinned
compiler digest, a separate deployment identity, durable record storage or an explicit subscription
allow-list makes the process refuse to start.

---

## Local development

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (type-aware)
npm run format        # prettier
npm test              # vitest
npm run test:coverage # vitest + v8 coverage with thresholds
npm run build         # tsc -> dist/
npm start             # run the built server
npm run openapi:emit  # write the OpenAPI document
npm run openapi:check # check it against the registry
npm run metadata:check# validate server.json
npm run mcp:stdio     # run the same tools over MCP stdio
```

Tests use fake Azure providers, compiler and process adapters, record stores and clocks. The suite
touches no Azure account and no network.

Docker:

```bash
docker build -t agent-tool-server-azure .
docker run --rm -p 8080:8080 -e API_KEYS="$(openssl rand -hex 32)" agent-tool-server-azure

# Read the digest of the Bicep CLI baked into the image, for BICEP_CLI_SHA256
docker run --rm --entrypoint cat agent-tool-server-azure /usr/local/share/bicep.sha256
```

---

## Deploying to Azure

Infrastructure lives in `infra/` (Bicep, subscription-scoped). Each environment has an authoritative
parameter file under `infra/parameters/`, which **both** provisioning and release pass on every
deployment — that is what stops an image-only release from resetting settings to template defaults.

```bash
# Provision infrastructure and generate the API key
./scripts/bootstrap/provision.sh <subscription-id> prod <region>

# Build the image in ACR and release it by digest
./scripts/bootstrap/deploy.sh <subscription-id> prod <region>
```

Both scripts run an account and tenant preflight, validate the template, show a what-if preview,
report any deletions, and ask for confirmation before changing anything.

For required permissions, GitHub OIDC setup, key rotation, monitoring, cost, recovery and teardown,
read the **[deployment and operations guide](docs/deployment.md)**. For the security boundary and
its known limits, read the **[threat model](docs/threat-model.md)**.

---

## Repository layout

```
src/
  app.ts                 composition root
  index.ts               HTTP entry point
  errors.ts              transport-agnostic error taxonomy
  config/                Zod-validated environment
  server/                Fastify transport, auth, rate limiting, readiness, error mapping
  tools/                 tool definitions, schemas, routing metadata, instructions, registry
  services/              inventory, diagnostics, operations, deployments, guardrails
  bicep/                 bundle validation, materialisation, compiler, inspection, hashing
  deployments/           deployment record port and implementations
  provider/              AzureProvider port + Azure SDK adapter
  openapi/               OpenAPI 3.1 generation
  mcp/                   MCP registry adapter, stdio entry point, Streamable HTTP handler
  util/                  logging, metrics, concurrency
infra/                   Bicep templates, modules and per-environment parameter files
scripts/                 provisioning, release, OpenAPI emit and check
tests/                   unit and integration tests
server.json              MCP registry metadata
```

---

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and quality
gates. To report a vulnerability, follow [SECURITY.md](SECURITY.md) rather than opening a public
issue.

This project is available under the [MIT License](LICENSE).
