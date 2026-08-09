# Contributing

Thank you for helping improve chatgpt-azure.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use an issue to discuss broad features or changes to the connector's security model.
- Do not include subscription IDs, resource IDs, logs, credentials, or other private Azure data in
  issues, fixtures, or screenshots.
- Report suspected vulnerabilities according to [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 22 or newer:

```bash
git clone https://github.com/ashergarland/chatgpt-azure.git
cd chatgpt-azure
npm ci
cp .env.example .env
npm test
```

Most tests use a fake Azure provider and do not require an Azure account. Running the service
against Azure requires `az login`; see the [quick start](README.md#quick-start).

## Making a change

1. Create a focused branch from `main`.
2. Keep changes small and avoid mixing refactors with behavior changes.
3. Preserve the architecture boundaries described in [How it works](README.md#how-it-works).
4. Add or update tests for observable behavior.
5. Update the README, OpenAPI descriptions, or deployment guide when the public behavior changes.

Provider-specific Azure SDK types belong in `src/provider`. Services and tool definitions should
depend on the provider interface, not directly on SDK clients. Both HTTP and MCP use the same tool
registry, so a feature should not be implemented in only one transport.

## Quality checks

Run the same checks as CI:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit -- /tmp/chatgpt-azure-openapi.json
```

If formatting fails, run `npm run format`, review the result, and repeat the checks. Infrastructure
changes should also pass:

```bash
az bicep build --file infra/main.bicep --stdout > /dev/null
for template in infra/main.bicep infra/modules/*.bicep; do
  az bicep lint --file "$template"
done
```

Do not use a production subscription to test infrastructure changes.

## Pull requests

A pull request should:

- explain the problem and the chosen solution;
- identify security, RBAC, configuration, and compatibility effects;
- include tests or explain why no test is needed;
- include documentation for user-facing changes; and
- pass all CI jobs.

Maintainers may ask for changes to keep the tool surface narrow and the default deployment
read-only. By contributing, you agree that your contribution is licensed under the repository's
[MIT License](LICENSE).
