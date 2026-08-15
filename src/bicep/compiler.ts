import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, constants, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { AppError, internalError } from '../errors.js';
import { Semaphore } from '../util/semaphore.js';
import { withMaterializedBundle, type MaterializedBundle } from './materialize.js';
import { assertBundleSourceAllowed, type ModulePolicy } from './modules.js';
import { NodeProcessRunner, type ProcessRunner } from './process.js';
import type {
  BicepCompiler,
  BicepCompileRequest,
  BicepCompileResult,
  BicepCompilerInfo,
  BicepDiagnostic,
  BicepDiagnosticLevel,
} from './types.js';

export interface BicepCompilerConfig {
  /** Absolute path of a Bicep CLI that was installed at image build time. */
  readonly cliPath: string;
  /** Expected SHA-256 of that binary. Required outside development. */
  readonly expectedSha256: string | undefined;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxConcurrency: number;
  readonly modulePolicy: ModulePolicy;
  readonly runAsUid: number | undefined;
  readonly runAsGid: number | undefined;
}

/** Port so tests can assert checksum handling without shipping a binary. */
export interface FileDigest {
  sha256(path: string): Promise<string>;
}

export class NodeFileDigest implements FileDigest {
  public sha256(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(path);
      stream.on('error', reject);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }
}

const DIAGNOSTIC = new RegExp(
  String.raw`^(?<file>.+?)\((?<line>\d+),(?<column>\d+)\)\s*:\s*(?<level>Error|Warning|Info)\s+(?<code>[A-Za-z0-9_.-]+)\s*:\s*(?<message>.*)$`,
);
const BARE_DIAGNOSTIC =
  /^(?<level>Error|Warning|Info)\s*(?<code>[A-Za-z0-9_.-]+)?\s*:\s*(?<message>.+)$/;

const levelOf = (raw: string): BicepDiagnosticLevel =>
  raw === 'Error' ? 'error' : raw === 'Warning' ? 'warning' : 'info';

/**
 * Rewrites an absolute path from the throwaway compile directory back to its bundle-relative form.
 * Callers must never learn where the server materialises their source.
 */
const toBundlePath = (root: string, candidate: string): string | undefined => {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return undefined;
  const rel = relative(root, trimmed);
  if (rel.length === 0 || rel.startsWith('..')) return undefined;
  return rel.split(sep).join('/');
};

/**
 * Diagnostic *messages* also embed absolute paths — a failed file load reports the path it tried to
 * open — so the compile root is stripped from the text as well as from the file field. Without
 * this, a message doubles as a disclosure of the materialisation directory and as a file-existence
 * oracle for the host.
 */
const scrubRoot = (message: string, root: string): string => {
  const variants = [root, root.split(sep).join('/'), root.split('/').join(sep)];
  let scrubbed = message;
  for (const variant of new Set(variants)) {
    if (variant.length === 0) continue;
    scrubbed = scrubbed.split(variant).join('<bundle>');
  }
  return scrubbed;
};

export const parseDiagnostics = (stderr: string, root: string): readonly BicepDiagnostic[] => {
  const diagnostics: BicepDiagnostic[] = [];
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const positioned = DIAGNOSTIC.exec(line);
    if (positioned?.groups) {
      const groups = positioned.groups;
      diagnostics.push({
        level: levelOf(groups['level'] ?? 'Error'),
        code: groups['code'],
        message: scrubRoot((groups['message'] ?? '').trim(), root),
        file: toBundlePath(root, groups['file'] ?? ''),
        line: Number(groups['line']),
        column: Number(groups['column']),
      });
      continue;
    }

    const bare = BARE_DIAGNOSTIC.exec(line);
    if (bare?.groups) {
      diagnostics.push({
        level: levelOf(bare.groups['level'] ?? 'Error'),
        code: bare.groups['code'],
        message: scrubRoot((bare.groups['message'] ?? '').trim(), root),
        file: undefined,
        line: undefined,
        column: undefined,
      });
    }
  }
  return diagnostics;
};

/**
 * Environment handed to the compiler. Built from nothing rather than filtered from the parent, so
 * no credential, token or endpoint that happens to be in the server's environment can be read by
 * the compiler or embedded in a template.
 */
const scrubbedEnv = (root: string): Record<string, string> => {
  const env: Record<string, string> = {
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    BICEP_CACHE_DIRECTORY: root,
    NO_COLOR: '1',
  };
  // Windows refuses to start most processes without SystemRoot; it carries no secrets.
  const systemRoot = process.env['SystemRoot'];
  if (systemRoot) env['SystemRoot'] = systemRoot;
  return env;
};

/**
 * Compiles Bicep by invoking a pinned, checksum-verified official Bicep CLI directly.
 *
 * The compiler is never downloaded at runtime: it is installed into the image at build time and
 * its digest is pinned by configuration, so a compromised mirror cannot swap it underneath a
 * running server.
 */
export class CliBicepCompiler implements BicepCompiler {
  private readonly semaphore: Semaphore;
  private verification: Promise<BicepCompilerInfo> | undefined;

  public constructor(
    private readonly config: BicepCompilerConfig,
    private readonly runner: ProcessRunner = new NodeProcessRunner(),
    private readonly digest: FileDigest = new NodeFileDigest(),
  ) {
    this.semaphore = new Semaphore(Math.max(1, config.maxConcurrency));
  }

  public describe(): Promise<BicepCompilerInfo> {
    this.verification ??= this.verify();
    return this.verification;
  }

  private async verify(): Promise<BicepCompilerInfo> {
    if (this.config.cliPath.length === 0) {
      return {
        available: false,
        version: undefined,
        checksumVerified: false,
        detail: 'BICEP_CLI_PATH is not configured',
      };
    }

    try {
      await access(this.config.cliPath, constants.X_OK);
    } catch {
      return {
        available: false,
        version: undefined,
        checksumVerified: false,
        detail: 'the configured Bicep CLI is missing or not executable',
      };
    }

    let checksumVerified = false;
    if (this.config.expectedSha256) {
      const actual = await this.digest.sha256(this.config.cliPath);
      if (actual.toLowerCase() !== this.config.expectedSha256.toLowerCase()) {
        return {
          available: false,
          version: undefined,
          checksumVerified: false,
          detail: 'the Bicep CLI digest does not match BICEP_CLI_SHA256',
        };
      }
      checksumVerified = true;
    }

    // The probe runs in a fresh writable directory rather than the process working directory.
    // scrubbedEnv points HOME and TMPDIR at whatever it is given, and the working directory of a
    // container image is typically root-owned: a self-contained .NET binary that cannot write to
    // its temporary directory aborts before it can print a version, which would report a perfectly
    // good compiler as unavailable.
    const probeRoot = await mkdtemp(join(await realpath(tmpdir()), 'atsa-bicep-probe-'));
    let result;
    try {
      result = await this.runner.run({
        command: this.config.cliPath,
        args: ['--version'],
        cwd: probeRoot,
        env: scrubbedEnv(probeRoot),
        timeoutMs: Math.min(this.config.timeoutMs, 15_000),
        maxOutputBytes: 4096,
        uid: this.config.runAsUid,
        gid: this.config.runAsGid,
      });
    } finally {
      await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
    }

    if (result.exitCode !== 0) {
      return {
        available: false,
        version: undefined,
        checksumVerified,
        detail: 'the Bicep CLI failed to report its version',
      };
    }

    return {
      available: true,
      version: /\d+\.\d+\.\d+/.exec(result.stdout)?.[0],
      checksumVerified,
      detail: undefined,
    };
  }

  public async compile(request: BicepCompileRequest): Promise<BicepCompileResult> {
    assertBundleSourceAllowed(request.bundle, this.config.modulePolicy);

    const info = await this.describe();
    if (!info.available) {
      throw new AppError(
        'internal_error',
        `The Bicep compiler is unavailable: ${info.detail ?? 'unknown reason'}`,
      );
    }

    return this.semaphore.run(() =>
      withMaterializedBundle(request.bundle, (materialized) =>
        this.runBuild(materialized, request.signal),
      ),
    );
  }

  private async runBuild(
    materialized: MaterializedBundle,
    signal: AbortSignal | undefined,
  ): Promise<BicepCompileResult> {
    const args = ['build', materialized.mainPath, '--stdout'];
    // Without remote modules there is nothing to restore, and --no-restore guarantees the
    // compiler has no reason to open a network connection at all.
    if (!this.config.modulePolicy.remoteModulesEnabled) args.push('--no-restore');

    const result = await this.runner.run({
      command: this.config.cliPath,
      args,
      cwd: materialized.root,
      env: scrubbedEnv(materialized.root),
      timeoutMs: this.config.timeoutMs,
      maxOutputBytes: this.config.maxOutputBytes,
      signal,
      uid: this.config.runAsUid,
      gid: this.config.runAsGid,
    });

    if (result.timedOut) {
      throw new AppError(
        'timeout',
        `Bicep compilation exceeded the ${this.config.timeoutMs} ms limit and was terminated`,
      );
    }

    const diagnostics = parseDiagnostics(result.stderr, materialized.root);
    const failed = result.exitCode !== 0 || diagnostics.some((entry) => entry.level === 'error');

    if (failed) {
      return {
        template: undefined,
        diagnostics:
          diagnostics.length > 0
            ? diagnostics
            : [
                {
                  level: 'error',
                  code: undefined,
                  message: 'Bicep compilation failed without a parsable diagnostic',
                  file: undefined,
                  line: undefined,
                  column: undefined,
                },
              ],
        durationMs: result.durationMs,
        truncatedOutput: result.truncated,
      };
    }

    if (result.truncated) {
      throw new AppError(
        'bad_request',
        'The compiled template exceeded the configured output limit. Split the deployment into ' +
          'smaller templates.',
      );
    }

    let template: unknown;
    try {
      template = JSON.parse(result.stdout);
    } catch (error) {
      throw internalError('The Bicep compiler produced output that is not valid JSON', error);
    }
    if (typeof template !== 'object' || template === null || Array.isArray(template)) {
      throw internalError('The Bicep compiler produced output that is not an ARM template');
    }

    return {
      template: template as Record<string, unknown>,
      diagnostics,
      durationMs: result.durationMs,
      truncatedOutput: false,
    };
  }
}
