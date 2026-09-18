import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PLATFORM_REVISION, platformCheckout } from './platform-reference.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const testkitModule = join(
  platformCheckout(),
  'packages',
  'testkit',
  'dist',
  'deployment',
  'index.js',
);

const { runDeploymentContractConformance } = await import(pathToFileURL(testkitModule).href);
const declaration = JSON.parse(
  await readFile(join(repositoryRoot, 'capability-profiles.json'), 'utf8'),
);
const result = runDeploymentContractConformance({ declaration });

process.stdout.write(
  `Deployment contract conformance passed with Agent Tool Platform ${PLATFORM_REVISION} ` +
    `(${result.checks.length} checks).\n`,
);
