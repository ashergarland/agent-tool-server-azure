import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { internalError } from '../errors.js';
import type { NormalizedBundle } from './types.js';

export interface MaterializedBundle {
  /** Absolute path of the throwaway root directory. */
  readonly root: string;
  /** Absolute path of the entry template inside {@link root}. */
  readonly mainPath: string;
  /** Absolute path of the server-owned compiler configuration. */
  readonly configPath: string;
}

/**
 * Compiler configuration written by the server, never by the caller.
 *
 * `moduleAliases` is deliberately empty so a template cannot reach a registry through an alias,
 * and the linter is left on so that callers get real diagnostics rather than silent acceptance.
 */
const compilerConfig = (): string =>
  `${JSON.stringify(
    {
      moduleAliases: { br: {}, ts: {} },
      analyzers: { core: { enabled: true, verbose: false } },
      experimentalFeaturesEnabled: {},
    },
    null,
    2,
  )}\n`;

const assertInside = (root: string, candidate: string): void => {
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) {
    throw internalError(`Refusing to write outside the bundle root: ${candidate}`);
  }
};

/**
 * Writes a validated bundle into a fresh, unpredictable, private directory.
 *
 * The directory name carries 128 bits of randomness on top of `mkdtemp`, so a local attacker
 * cannot pre-create it or race a symlink into place, and every file is created with the exclusive
 * flag so an existing entry (including a symlink) is an error rather than a target.
 */
export const materializeBundle = async (bundle: NormalizedBundle): Promise<MaterializedBundle> => {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, `atsa-bicep-${randomBytes(16).toString('hex')}-`));

  try {
    for (const file of bundle.files) {
      const target = resolve(root, file.path);
      assertInside(root, target);
      const directory = dirname(target);
      assertInside(root, directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(target, file.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }

    const configPath = join(root, 'bicepconfig.json');
    await writeFile(configPath, compilerConfig(), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });

    return { root, mainPath: resolve(root, bundle.mainFile), configPath };
  } catch (error) {
    await cleanupBundle(root);
    throw error;
  }
};

/** Best-effort removal. Never throws: a failed cleanup must not mask the real result. */
export const cleanupBundle = async (root: string): Promise<void> => {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the directory is inside the OS temp tree and will be reaped there */
  }
};

/** Materialise, run, and always clean up — including on cancellation. */
export const withMaterializedBundle = async <T>(
  bundle: NormalizedBundle,
  run: (materialized: MaterializedBundle) => Promise<T>,
): Promise<T> => {
  const materialized = await materializeBundle(bundle);
  try {
    return await run(materialized);
  } finally {
    await cleanupBundle(materialized.root);
  }
};
