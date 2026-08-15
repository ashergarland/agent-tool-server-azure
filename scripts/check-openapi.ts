import { readFile } from 'node:fs/promises';
import { createToolRegistry } from '../src/tools/registry.js';

/**
 * Checks an emitted OpenAPI document against the live tool registry.
 *
 * The document is the contract an HTTP client is given, so this fails on the two ways it can go
 * wrong without anyone noticing: drifting from the registry, and carrying somebody's account
 * details into a public artefact.
 */
interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: { url?: string }[];
  paths?: Record<
    string,
    Record<
      string,
      { operationId?: string; requestBody?: unknown; responses?: Record<string, unknown> }
    >
  >;
  components?: { securitySchemes?: Record<string, unknown> };
}

const problems: string[] = [];
const check = (condition: boolean, message: string): void => {
  if (!condition) problems.push(message);
};

const main = async (): Promise<void> => {
  const target = process.argv[2];
  if (!target) throw new Error('usage: check-openapi.ts <path-to-openapi.json>');

  const document = JSON.parse(await readFile(target, 'utf8')) as OpenApiDocument;
  const registry = createToolRegistry();

  check(
    document.openapi === '3.1.0',
    `expected openapi 3.1.0, got ${document.openapi ?? 'nothing'}`,
  );
  check(Boolean(document.info?.title), 'info.title is missing');
  check(Boolean(document.info?.version), 'info.version is missing');
  check(Boolean(document.components?.securitySchemes), 'no security scheme is declared');

  for (const path of ['/health', '/ready', '/version', '/tools']) {
    check(Boolean(document.paths?.[path]), `${path} is missing from the document`);
  }

  for (const tool of registry.list()) {
    const path = document.paths?.[`/tools/${tool.name}`];
    if (!path) {
      problems.push(`tool ${tool.name} has no path`);
      continue;
    }
    const operation = path['post'];
    check(Boolean(operation), `tool ${tool.name} has no POST operation`);
    check(
      operation?.operationId === tool.name,
      `tool ${tool.name} has operationId ${operation?.operationId ?? 'nothing'}`,
    );
    check(Boolean(operation?.requestBody), `tool ${tool.name} declares no request body`);
    check(Boolean(operation?.responses?.['200']), `tool ${tool.name} declares no 200 response`);
    check(Boolean(operation?.responses?.['403']), `tool ${tool.name} declares no 403 response`);
  }

  const declaredOperations = Object.entries(document.paths ?? {})
    .filter(([path]) => path.startsWith('/tools/'))
    .map(([path]) => path.slice('/tools/'.length));
  const known = new Set(registry.list().map((tool) => tool.name));
  for (const name of declaredOperations) {
    check(known.has(name), `the document declares /tools/${name}, which is not in the registry`);
  }

  // A published artefact must not carry the hostname, tenant or subscription of whoever emitted it.
  const serialized = JSON.stringify(document);
  check(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized),
    'the document contains something shaped like a GUID',
  );
  for (const server of document.servers ?? []) {
    check(
      !/azurecontainerapps\.io|azurewebsites\.net/.test(server.url ?? ''),
      `the document advertises a deployment-specific server URL: ${server.url ?? ''}`,
    );
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`);
    throw new Error(`${problems.length} problem(s) in ${target}`);
  }

  console.log(
    `${target} is consistent with the registry: ${registry.list().length} tools, ` +
      `${Object.keys(document.paths ?? {}).length} paths.`,
  );
};

await main();
