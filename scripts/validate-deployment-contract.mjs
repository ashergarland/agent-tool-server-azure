import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORM_REVISION, platformCheckout } from './platform-reference.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const validator = join(platformCheckout(), 'packages', 'runtime', 'bin', 'validate-deployment.js');
if (!existsSync(validator)) {
  throw new Error(`Build the pinned Platform checkout before validating; missing ${validator}`);
}

const result = spawnSync(
  process.execPath,
  [validator, '--declaration', join(repositoryRoot, 'capability-profiles.json')],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0) {
  throw new Error(`Deployment validation failed with status ${String(result.status)}`);
}

process.stdout.write(`Validated with Agent Tool Platform ${PLATFORM_REVISION}.\n`);
