import { writeFile } from 'node:fs/promises';
import { buildOpenApiDocument } from '@agent-tool-platform/runtime/openapi';
import { generateTestApiKey } from '@agent-tool-platform/testkit';
import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import { loadConfig } from '../src/config/index.js';
import { capabilityManifest } from '../src/manifest.js';
import { toolDefinitions } from '../src/tools/definitions/index.js';
import { SERVER_INSTRUCTIONS } from '../src/tools/instructions.js';

/**
 * Emits the OpenAPI document to stdout (or to the path given as the first argument) without
 * starting the server, so CI can diff or publish it.
 */
const main = async (): Promise<void> => {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'development',
    AUTH_MODE: 'api-key',
    API_KEYS: generateTestApiKey(),
  });
  const document = buildOpenApiDocument(config, createToolRegistry(toolDefinitions), {
    title: capabilityManifest.title,
    description: capabilityManifest.description,
    instructions: SERVER_INSTRUCTIONS,
  });
  const json = `${JSON.stringify(document, null, 2)}\n`;

  const target = process.argv[2] ?? 'openapi.json';
  await writeFile(target, json, 'utf8');
  console.log(`Wrote ${target}`);
};

await main();
