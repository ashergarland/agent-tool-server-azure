import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const PLATFORM_REVISION = '98ec8162fb11d5c04aee9e6f7b3625a472a0180d';

const commandOutput = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout || '(no output)'}`,
    );
  }
  return result.stdout.trim();
};

export const platformCheckout = () => {
  if (process.versions.node.split('.')[0] !== '22') {
    throw new Error(`Node 22 is required; current runtime is ${process.version}`);
  }

  const configured = process.env['AGENT_TOOL_PLATFORM_CHECKOUT'];
  if (!configured) {
    throw new Error(
      'AGENT_TOOL_PLATFORM_CHECKOUT must point to an Agent Tool Platform checkout at ' +
        PLATFORM_REVISION,
    );
  }

  const checkout = resolve(configured);
  if (!existsSync(checkout)) throw new Error(`Platform checkout does not exist: ${checkout}`);

  const revision = commandOutput('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  if (revision !== PLATFORM_REVISION) {
    throw new Error(`Expected Platform ${PLATFORM_REVISION}, found ${revision || '(unknown)'}`);
  }
  return checkout;
};
