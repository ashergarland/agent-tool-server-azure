import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliBicepCompiler, parseDiagnostics } from '../../src/bicep/compiler.js';
import { normalizeBundle } from '../../src/bicep/bundle.js';
import {
  DEFAULT_MODULE_POLICY,
  assertFileLoadsAllowed,
  assertModuleReferencesAllowed,
} from '../../src/bicep/modules.js';
import { createProcessRunner, processResult, RG_TEMPLATE } from '../helpers/bicep.js';
import type { ProcessRunRequest } from '../../src/bicep/process.js';

const bundle = (content = 'param name string\n') =>
  normalizeBundle({ mainFile: 'main.bicep', files: [{ path: 'main.bicep', content }] });

const digest = (value: string) => ({ sha256: () => Promise.resolve(value) });

const DIGEST = 'a'.repeat(64);

const config = (overrides: Partial<ConstructorParameters<typeof CliBicepCompiler>[0]> = {}) => ({
  // A real, executable file so the access() check reflects reality; the process itself is faked.
  cliPath: process.execPath,
  expectedSha256: DIGEST,
  timeoutMs: 30_000,
  maxOutputBytes: 1_000_000,
  maxConcurrency: 2,
  modulePolicy: DEFAULT_MODULE_POLICY,
  runAsUid: undefined,
  runAsGid: undefined,
  ...overrides,
});

/** Answers `--version` itself so each test only has to describe the build it expects. */
const runnerFor = (
  build: (request: ProcessRunRequest) => ReturnType<typeof processResult>,
): ReturnType<typeof createProcessRunner> =>
  createProcessRunner((request) =>
    request.args[0] === '--version' ? processResult({ stdout: '0.30.0\n' }) : build(request),
  );

const compilerFor = (
  runner: ReturnType<typeof createProcessRunner>,
  overrides: Partial<ConstructorParameters<typeof CliBicepCompiler>[0]> = {},
): CliBicepCompiler => new CliBicepCompiler(config(overrides), runner, digest(DIGEST));

/** Build requests only, with the version probe filtered out. */
const buildRequests = (runner: ReturnType<typeof createProcessRunner>): ProcessRunRequest[] =>
  runner.requests.filter((request) => request.args[0] === 'build');

describe('parseDiagnostics', () => {
  const root = process.platform === 'win32' ? 'C:\\tmp\\bundle' : '/tmp/bundle';
  const path = process.platform === 'win32' ? `${root}\\main.bicep` : `${root}/main.bicep`;

  it('parses positioned diagnostics and rewrites paths to bundle-relative form', () => {
    const diagnostics = parseDiagnostics(
      `${path}(3,7) : Error BCP028: Identifier "foo" is declared multiple times.`,
      root,
    );
    expect(diagnostics).toEqual([
      {
        level: 'error',
        code: 'BCP028',
        message: 'Identifier "foo" is declared multiple times.',
        file: 'main.bicep',
        line: 3,
        column: 7,
      },
    ]);
  });

  it('never leaks a path outside the compile directory', () => {
    const outside = process.platform === 'win32' ? 'C:\\etc\\other.bicep' : '/etc/other.bicep';
    expect(
      parseDiagnostics(`${outside}(1,1) : Warning BCP081: hmm`, root)[0]?.file,
    ).toBeUndefined();
  });

  it('scrubs the compile directory out of diagnostic message text', () => {
    const diagnostics = parseDiagnostics(
      `${path}(1,9) : Error BCP302: Unable to open file at path "${path}.json".`,
      root,
    );
    expect(diagnostics[0]?.message).not.toContain(root);
    expect(diagnostics[0]?.message).toContain('<bundle>');
  });

  it('scrubs the compile directory out of unpositioned diagnostics too', () => {
    const diagnostics = parseDiagnostics(`Error BCP091: could not read ${root}/secret`, root);
    expect(diagnostics[0]?.message).not.toContain(root);
  });

  it('parses diagnostics that carry no position', () => {
    expect(parseDiagnostics('Error BCP091: unable to resolve module', root)[0]).toMatchObject({
      level: 'error',
      code: 'BCP091',
    });
  });
});

describe('CliBicepCompiler', () => {
  it('verifies the pinned digest before it will run anything', async () => {
    const runner = runnerFor(() => processResult());
    const wrongDigest = new CliBicepCompiler(config(), runner, digest('b'.repeat(64)));
    const info = await wrongDigest.describe();
    expect(info).toMatchObject({ available: false, checksumVerified: false });
    expect(info.detail).toMatch(/does not match BICEP_CLI_SHA256/);

    await expect(wrongDigest.compile({ bundle: bundle() })).rejects.toThrowError(
      /compiler is unavailable/,
    );
    expect(buildRequests(runner)).toHaveLength(0);
  });

  it('reports an unavailable compiler when the path is not configured', async () => {
    const info = await compilerFor(
      runnerFor(() => processResult()),
      { cliPath: '' },
    ).describe();
    expect(info).toMatchObject({ available: false, detail: 'BICEP_CLI_PATH is not configured' });
  });

  it('invokes the pinned binary with no shell and a scrubbed environment', async () => {
    const runner = runnerFor(() => processResult({ stdout: JSON.stringify(RG_TEMPLATE) }));
    const result = await compilerFor(runner).compile({ bundle: bundle() });

    expect(result.template).toEqual(RG_TEMPLATE);
    const request = buildRequests(runner)[0] as ProcessRunRequest;
    expect(request.command).toBe(process.execPath);
    expect(request.args[0]).toBe('build');
    expect(request.args).toContain('--stdout');
    expect(request.args).toContain('--no-restore');
    expect(request.env).not.toHaveProperty('API_KEYS');
    expect(request.env).not.toHaveProperty('AZURE_CLIENT_ID');
    expect(request.env['HOME']).toBe(request.cwd);
    expect(request.timeoutMs).toBe(30_000);
  });

  it('materialises the bundle in an unpredictable directory and removes it afterwards', async () => {
    let observedCwd = '';
    const runner = runnerFor((request) => {
      observedCwd = request.cwd;
      return processResult({ stdout: JSON.stringify(RG_TEMPLATE) });
    });
    await compilerFor(runner).compile({ bundle: bundle() });

    expect(observedCwd).toMatch(/atsa-bicep-[0-9a-f]{32}/);
    expect(existsSync(observedCwd)).toBe(false);
  });

  it('writes a server-owned bicepconfig.json with no module aliases', async () => {
    let written = '';
    const runner = runnerFor((request) => {
      written = readFileSync(join(request.cwd, 'bicepconfig.json'), 'utf8');
      return processResult({ stdout: JSON.stringify(RG_TEMPLATE) });
    });
    await compilerFor(runner).compile({ bundle: bundle() });
    expect(JSON.parse(written)).toMatchObject({ moduleAliases: { br: {}, ts: {} } });
  });

  it('reports compiler errors as diagnostics rather than throwing', async () => {
    const runner = runnerFor((request) =>
      processResult({
        exitCode: 1,
        stderr: `${request.cwd}${process.platform === 'win32' ? '\\' : '/'}main.bicep(1,1) : Error BCP007: bad`,
      }),
    );
    const result = await compilerFor(runner).compile({ bundle: bundle() });
    expect(result.template).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ level: 'error', code: 'BCP007' });
  });

  it('turns a compiler timeout into a timeout error', async () => {
    const runner = runnerFor(() => processResult({ timedOut: true, exitCode: null }));
    await expect(compilerFor(runner).compile({ bundle: bundle() })).rejects.toThrowError(
      expect.objectContaining({ code: 'timeout' }) as unknown,
    );
  });

  it('refuses output that exceeded the size limit instead of parsing a truncated template', async () => {
    const runner = runnerFor(() => processResult({ stdout: '{"a":', truncated: true }));
    await expect(compilerFor(runner).compile({ bundle: bundle() })).rejects.toThrowError(
      /exceeded the configured output limit/,
    );
  });

  it('rejects compiler output that is not an ARM template object', async () => {
    const runner = runnerFor(() => processResult({ stdout: '[1,2,3]' }));
    await expect(compilerFor(runner).compile({ bundle: bundle() })).rejects.toThrowError(
      /not an ARM template/,
    );
  });

  it('bounds concurrent compilations', async () => {
    let running = 0;
    let peak = 0;
    const runner = runnerFor(() => {
      running += 1;
      peak = Math.max(peak, running);
      running -= 1;
      return processResult({ stdout: JSON.stringify(RG_TEMPLATE) });
    });
    const compiler = compilerFor(runner, { maxConcurrency: 1 });
    await Promise.all([
      compiler.compile({ bundle: bundle() }),
      compiler.compile({ bundle: bundle('param b string\n') }),
      compiler.compile({ bundle: bundle('param c string\n') }),
    ]);
    expect(peak).toBe(1);
    expect(buildRequests(runner)).toHaveLength(3);
  });

  it('refuses remote modules before starting the compiler', async () => {
    const runner = runnerFor(() => processResult());
    await expect(
      compilerFor(runner).compile({
        bundle: bundle("module x 'br:contoso.azurecr.io/bicep/storage:v1' = {}\n"),
      }),
    ).rejects.toThrowError(/Remote Bicep modules are disabled/);
    expect(buildRequests(runner)).toHaveLength(0);
  });
});

describe('compile-time file loads', () => {
  const withFiles = (files: { path: string; content: string }[]) =>
    normalizeBundle({ mainFile: 'main.bicep', files });

  it('allows a load that resolves to a file in the same bundle', () => {
    expect(() =>
      assertFileLoadsAllowed(
        withFiles([
          { path: 'main.bicep', content: "var x = loadTextContent('data/settings.json')\n" },
          { path: 'data/settings.json', content: '{}' },
        ]),
      ),
    ).not.toThrow();
  });

  it('allows a relative load from a nested module', () => {
    expect(() =>
      assertFileLoadsAllowed(
        withFiles([
          { path: 'main.bicep', content: 'param a string\n' },
          {
            path: 'modules/storage.bicep',
            content: "var x = loadJsonContent('../data/settings.json')\n",
          },
          { path: 'data/settings.json', content: '{}' },
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    ['loadTextContent', "loadTextContent('../../../../etc/passwd')"],
    ['loadFileAsBase64', "loadFileAsBase64('../../../../proc/self/environ')"],
    ['loadJsonContent', "loadJsonContent('../../secrets.json')"],
    ['loadYamlContent', "loadYamlContent('../../../config.yaml')"],
  ])('rejects %s reaching outside the bundle', (_name, expression) => {
    expect(() =>
      assertFileLoadsAllowed(
        withFiles([{ path: 'main.bicep', content: `var x = ${expression}\n` }]),
      ),
    ).toThrowError(/not a file in this bundle/);
  });

  it('rejects a load of a path that is inside the bundle root but was never supplied', () => {
    expect(() =>
      assertFileLoadsAllowed(
        withFiles([
          { path: 'main.bicep', content: "var x = loadTextContent('bicepconfig.json')\n" },
        ]),
      ),
    ).toThrowError(/not a file in this bundle/);
  });

  it('rejects a computed path, which cannot be checked before the compiler resolves it', () => {
    expect(() =>
      assertFileLoadsAllowed(
        withFiles([
          {
            path: 'main.bicep',
            content: "param p string\nvar x = loadTextContent('${p}/secret.txt')\n",
          },
        ]),
      ),
    ).toThrowError(/computed path/);
  });

  it('is enforced by the compiler before any process is started', async () => {
    const runner = runnerFor(() => processResult());
    await expect(
      compilerFor(runner).compile({
        bundle: bundle("var x = loadTextContent('../../../../etc/passwd')\n"),
      }),
    ).rejects.toThrowError(/not a file in this bundle/);
    expect(buildRequests(runner)).toHaveLength(0);
  });
});

describe('module policy', () => {
  const policy = {
    remoteModulesEnabled: true,
    allowedRegistries: ['contoso.azurecr.io'],
    templateSpecsEnabled: true,
    allowedSubscriptionIds: ['11111111-1111-1111-1111-111111111111'],
  };

  it('allows an explicitly allow-listed registry', () => {
    expect(() =>
      assertModuleReferencesAllowed(
        bundle("module x 'br:contoso.azurecr.io/bicep/storage:v1' = {}\n"),
        policy,
      ),
    ).not.toThrow();
  });

  it('rejects a registry that is not allow-listed', () => {
    expect(() =>
      assertModuleReferencesAllowed(bundle("module x 'br:evil.example/bicep/x:v1' = {}\n"), policy),
    ).toThrowError(/not allow-listed/);
  });

  it('rejects alias references, which resolve through configuration the caller cannot see', () => {
    expect(() =>
      assertModuleReferencesAllowed(bundle("module x 'br/mine:storage:v1' = {}\n"), policy),
    ).toThrowError(/alias references are not supported/);
  });

  it('rejects a Template Spec outside the allow-listed subscriptions', () => {
    expect(() =>
      assertModuleReferencesAllowed(
        bundle("module x 'ts:99999999-9999-9999-9999-999999999999/rg/spec:1.0' = {}\n"),
        policy,
      ),
    ).toThrowError(/outside the allow-list/);
  });

  it('rejects Template Specs entirely when they are disabled', () => {
    expect(() =>
      assertModuleReferencesAllowed(
        bundle("module x 'ts:11111111-1111-1111-1111-111111111111/rg/spec:1.0' = {}\n"),
        { ...policy, templateSpecsEnabled: false },
      ),
    ).toThrowError(/Template Spec references are disabled/);
  });
});
