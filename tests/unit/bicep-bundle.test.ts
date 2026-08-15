import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUNDLE_LIMITS,
  normalizeBundle,
  normalizeBundlePath,
} from '../../src/bicep/bundle.js';

const file = (path: string, content = 'param a string\n') => ({ path, content });
const bundle = (paths: string[], mainFile = paths[0] ?? 'main.bicep') => ({
  mainFile,
  files: paths.map((path) => file(path)),
});

const expectRejected = (run: () => unknown, pattern: RegExp): void => {
  expect(run).toThrowError(expect.objectContaining({ code: 'bad_request' }) as unknown);
  expect(run).toThrowError(pattern);
};

describe('bundle path normalisation', () => {
  it('accepts nested relative paths and normalises separators', () => {
    expect(normalizeBundlePath('modules\\storage.bicep', DEFAULT_BUNDLE_LIMITS)).toBe(
      'modules/storage.bicep',
    );
    expect(normalizeBundlePath('./main.bicep', DEFAULT_BUNDLE_LIMITS)).toBe('main.bicep');
  });

  it.each([
    ['../../etc/passwd.bicep', /traverse outside/],
    ['/etc/passwd.bicep', /must be relative/],
    ['//server/share/main.bicep', /must be relative/],
    ['C:/windows/main.bicep', /absolute or drive-qualified/],
    ['~/main.bicep', /home directory/],
    ['modules/../../main.bicep', /traverse outside/],
    ['con.bicep', /reserved device name/],
    ['modules/PRN.bicep', /reserved device name/],
    ['modules/trailing /x.bicep', /must not end with a dot or space/],
    ['main.exe', /file type .exe is not allowed/],
    ['main', /file type \(none\) is not allowed/],
    ['bicepconfig.json', /configures the compiler/],
    ['nested/bicepconfig.json', /configures the compiler/],
  ])('rejects %s', (path, pattern) => {
    expectRejected(() => normalizeBundlePath(path, DEFAULT_BUNDLE_LIMITS), pattern);
  });

  it('rejects control characters and NUL', () => {
    expectRejected(
      () => normalizeBundlePath('main\u0000.bicep', DEFAULT_BUNDLE_LIMITS),
      /valid UTF-8/,
    );
    expectRejected(
      () => normalizeBundlePath('ma\u0007in.bicep', DEFAULT_BUNDLE_LIMITS),
      /control characters/,
    );
  });

  it('enforces the path length and depth limits', () => {
    expectRejected(
      () => normalizeBundlePath(`${'a'.repeat(300)}.bicep`, DEFAULT_BUNDLE_LIMITS),
      /exceeds 200 characters/,
    );
    expectRejected(
      () => normalizeBundlePath(`${'a/'.repeat(20)}main.bicep`, DEFAULT_BUNDLE_LIMITS),
      /nested deeper than 8/,
    );
  });
});

describe('normalizeBundle', () => {
  it('accepts a template with local modules and data files', () => {
    const result = normalizeBundle({
      mainFile: 'main.bicep',
      files: [file('main.bicep'), file('modules/storage.bicep'), file('data/settings.json', '{}')],
    });
    expect(result.mainFile).toBe('main.bicep');
    expect(result.files.map((entry) => entry.path)).toEqual([
      'data/settings.json',
      'main.bicep',
      'modules/storage.bicep',
    ]);
    expect(result.sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable hash regardless of the order files arrive in', () => {
    const a = normalizeBundle(bundle(['main.bicep', 'modules/one.bicep'], 'main.bicep'));
    const b = normalizeBundle(bundle(['modules/one.bicep', 'main.bicep'], 'main.bicep'));
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it('changes the hash when any byte of any file changes', () => {
    const before = normalizeBundle(simple('param a string\n'));
    const after = normalizeBundle(simple('param a string \n'));
    expect(before.sourceHash).not.toBe(after.sourceHash);
  });

  it('rejects duplicate paths that differ only in case', () => {
    expectRejected(
      () => normalizeBundle(bundle(['Main.bicep', 'main.bicep'], 'main.bicep')),
      /Duplicate bundle path/,
    );
  });

  it('rejects a mainFile that is not in the bundle', () => {
    expectRejected(
      () => normalizeBundle({ mainFile: 'other.bicep', files: [file('main.bicep')] }),
      /is not present in the bundle/,
    );
  });

  it('rejects a mainFile that is not a .bicep template', () => {
    expectRejected(
      () => normalizeBundle({ mainFile: 'main.json', files: [file('main.json', '{}')] }),
      /must be a .bicep template/,
    );
  });

  it('enforces the file count limit', () => {
    const paths = Array.from({ length: 65 }, (_, index) => `file${index}.bicep`);
    expectRejected(() => normalizeBundle(bundle(paths, 'file0.bicep')), /more than 64 files/);
  });

  it('enforces the per-file and total size limits', () => {
    expectRejected(
      () =>
        normalizeBundle({
          mainFile: 'main.bicep',
          files: [file('main.bicep', 'x'.repeat(300_000))],
        }),
      /per-file limit/,
    );

    expectRejected(
      () =>
        normalizeBundle({
          mainFile: 'main.bicep',
          files: Array.from({ length: 8 }, (_, index) =>
            file(`f${index}.bicep`, 'x'.repeat(200_000)),
          ).concat(file('main.bicep')),
        }),
      /total limit/,
    );
  });

  it('rejects content that is not valid UTF-16 text', () => {
    expectRejected(
      () =>
        normalizeBundle({
          mainFile: 'main.bicep',
          files: [file('main.bicep', 'lone \uD800 surrogate')],
        }),
      /valid UTF-8 text/,
    );
  });

  it('rejects an empty bundle', () => {
    expectRejected(
      () => normalizeBundle({ mainFile: 'main.bicep', files: [] }),
      /contains no files/,
    );
  });
});

const simple = (content: string) => ({
  mainFile: 'main.bicep',
  files: [{ path: 'main.bicep', content }],
});
