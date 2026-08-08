import { writeFile } from 'node:fs/promises';
import { buildOpenApiDocument } from '../src/openapi/document.js';
import { buildConfig, envSchema } from '../src/config/index.js';
import { createToolRegistry } from '../src/tools/registry.js';

/**
 * Emits the OpenAPI document to stdout (or to the path given as the first argument) without
 * starting the server, so CI can diff or publish it.
 */
const main = async (): Promise<void> => {
  const config = buildConfig(
    envSchema.parse({
      NODE_ENV: 'development',
      AUTH_MODE: 'disabled',
      ...process.env,
    }),
  );
  const document = buildOpenApiDocument(config, createToolRegistry());
  const json = `${JSON.stringify(document, null, 2)}\n`;

  const target = process.argv[2];
  if (target) {
    await writeFile(target, json, 'utf8');
    console.log(`Wrote ${target}`);
  } else {
    process.stdout.write(json);
  }
};

await main();
