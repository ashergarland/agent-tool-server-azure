# tool-server-template

Contract for servers in the curated `ashergarland-tool-servers` family. Copy the three template
metadata files, then implement the server using the same transport-neutral boundaries as this
repository: tool registry, services, provider adapters, and transport adapters.

## Required interfaces

- Keep tool definitions and schemas in one registry shared by stdio MCP, Streamable HTTP MCP, and
  HTTP/OpenAPI.
- Expose unauthenticated `/health`, version metadata, and OpenAPI; authenticate and rate limit every
  tool and remote MCP request.
- Make Streamable HTTP stateless unless a documented feature needs durable sessions.
- Propagate the authenticated principal and request ID into tool invocation and audit records.

## Security baseline

- Use workload identity or short-lived credentials; never persist or log caller credentials.
- Apply least-privilege provider permissions and explicit resource-scope allow-lists.
- Disable mutations by default, mark their MCP/OpenAPI safety properties, require explicit
  confirmation, support dry runs, and audit every attempted mutation.
- Bound request size, execution time, pagination, and per-principal request rate.
- Validate all input and output at the tool boundary and map internal errors to safe public errors.
- Run as a non-root container user and pin released image references to immutable versions or
  digests.

## Test and release baseline

1. Test tool schemas, guardrails, authentication, rate limiting, error mapping, stdio MCP,
   Streamable HTTP MCP, HTTP/OpenAPI, and health/version endpoints.
2. Run formatting, lint, typecheck, tests with coverage, production build, container smoke test,
   infrastructure validation, secret scanning, dependency review, and code scanning.
3. Keep package, image, `server.json`, family catalog, and Docker catalog versions synchronized.
4. Validate `server.json` with the official publisher before publishing it.
5. Publish to the official MCP Registry; GitHub discovers that registry entry. Submit the released
   image to Docker's catalog and only selected community directories.
6. Add only owned, reviewed servers to the family `catalog.json`; established registries remain the
   source for global discovery.

## Deployment baseline

Deploy from infrastructure as code with TLS-only ingress, managed secrets, health/readiness probes,
structured logs, monitoring, and a rollback-capable immutable image. Record repository, npm, remote
MCP, OpenAPI, health, authentication, tool summaries, safety properties, and current version in the
family catalog.
