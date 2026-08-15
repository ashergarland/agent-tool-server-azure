import { badRequest } from '../errors.js';
import { hashJson } from './hash.js';
import type { BicepBundle, BundleLimits, NormalizedBundle } from './types.js';

/** Windows reserved device names. A file called `CON` is a device, not a file, on Windows hosts. */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/**
 * Files that configure the compiler itself rather than describe infrastructure. A caller-supplied
 * `bicepconfig.json` could re-enable remote module restore, point at an arbitrary OCI registry or
 * disable linter rules, so it is never accepted from the bundle — the server writes its own.
 */
const RESERVED_FILE_NAMES = new Set(['bicepconfig.json']);

export const DEFAULT_ALLOWED_EXTENSIONS = [
  '.bicep',
  '.bicepparam',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.txt',
  '.md',
  '.csv',
] as const;

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxPathLength: 200,
  maxDepth: 8,
  allowedExtensions: [...DEFAULT_ALLOWED_EXTENSIONS],
};

const reject = (message: string, details?: unknown): never => {
  throw badRequest(message, details);
};

/** True when the string is valid UTF-16 (no unpaired surrogates) and carries no NUL. */
const isWellFormedUtf8 = (value: string): boolean =>
  !value.includes('\u0000') &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

const extensionOf = (path: string): string => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
};

/**
 * Normalises one caller-supplied path into a safe POSIX-relative path, or rejects it.
 *
 * Everything that could make a path mean something other than "a file underneath the bundle root"
 * is refused rather than sanitised: silently rewriting `../../etc/passwd` into `etc/passwd` would
 * hide an attack instead of reporting it.
 */
export const normalizeBundlePath = (rawPath: string, limits: BundleLimits): string => {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return reject('Every bundle file needs a non-empty path');
  }
  if (!isWellFormedUtf8(rawPath)) {
    return reject('Bundle file paths must be valid UTF-8 without NUL characters');
  }
  if (rawPath.length > limits.maxPathLength) {
    return reject(`Bundle file path exceeds ${limits.maxPathLength} characters`, {
      path: rawPath.slice(0, 80),
    });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    return reject('Bundle file paths must not contain control characters');
  }

  const unified = rawPath.replace(/\\/g, '/');
  if (unified.startsWith('/') || unified.startsWith('//')) {
    return reject(`Bundle file paths must be relative: ${rawPath}`);
  }
  if (/^[a-zA-Z]:/.test(unified)) {
    return reject(`Bundle file paths must not be absolute or drive-qualified: ${rawPath}`);
  }
  if (/^~/.test(unified)) {
    return reject(`Bundle file paths must not reference a home directory: ${rawPath}`);
  }

  const segments = unified.split('/');
  if (segments.some((segment) => segment === '..')) {
    return reject(`Bundle file paths must not traverse outside the bundle: ${rawPath}`);
  }

  const cleaned = segments.filter((segment) => segment !== '' && segment !== '.');
  if (cleaned.length === 0) return reject(`Bundle file path resolves to nothing: ${rawPath}`);
  if (cleaned.length > limits.maxDepth) {
    return reject(`Bundle file path is nested deeper than ${limits.maxDepth} directories`, {
      path: rawPath,
    });
  }

  for (const segment of cleaned) {
    if (segment.endsWith('.') || segment.endsWith(' ')) {
      return reject(`Bundle path segments must not end with a dot or space: ${rawPath}`);
    }
    const stem = segment.split('.')[0]?.toLowerCase() ?? '';
    if (RESERVED_DEVICE_NAMES.has(stem)) {
      return reject(`Bundle path segment is a reserved device name: ${segment}`);
    }
    if (/[<>:"|?*]/.test(segment)) {
      return reject(`Bundle path segment contains an unsupported character: ${segment}`);
    }
  }

  const normalized = cleaned.join('/');
  const fileName = cleaned[cleaned.length - 1] ?? '';
  if (RESERVED_FILE_NAMES.has(fileName.toLowerCase())) {
    return reject(
      `${fileName} configures the compiler and cannot be supplied by a caller. Remote module ` +
        'restore is controlled by server configuration.',
    );
  }

  const extension = extensionOf(normalized);
  if (!limits.allowedExtensions.includes(extension)) {
    return reject(`Bundle file type ${extension || '(none)'} is not allowed`, {
      path: normalized,
      allowedExtensions: limits.allowedExtensions,
    });
  }

  return normalized;
};

/**
 * Validates and canonicalises a caller-supplied bundle. Returns a bundle that is safe to
 * materialise, together with the digest that identifies it in every downstream hash.
 */
export const normalizeBundle = (
  bundle: BicepBundle,
  limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
): NormalizedBundle => {
  if (bundle.files.length === 0) reject('The Bicep bundle contains no files');
  if (bundle.files.length > limits.maxFiles) {
    reject(`The Bicep bundle contains more than ${limits.maxFiles} files`, {
      fileCount: bundle.files.length,
    });
  }

  const seen = new Map<string, string>();
  const files: { path: string; content: string }[] = [];
  let totalBytes = 0;

  for (const file of bundle.files) {
    const path = normalizeBundlePath(file.path, limits);
    if (typeof file.content !== 'string' || !isWellFormedUtf8(file.content)) {
      reject(`File ${path} must be valid UTF-8 text without NUL characters`);
    }

    const bytes = Buffer.byteLength(file.content, 'utf8');
    if (bytes > limits.maxFileBytes) {
      reject(`File ${path} exceeds the ${limits.maxFileBytes} byte per-file limit`, { bytes });
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      reject(`The Bicep bundle exceeds the ${limits.maxTotalBytes} byte total limit`);
    }

    // Case-insensitive: the compiler may run on a case-insensitive filesystem, where two entries
    // differing only in case would silently overwrite each other.
    const key = path.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      reject(`Duplicate bundle path after normalisation: ${previous} and ${path}`);
    }
    seen.set(key, path);
    files.push({ path, content: file.content });
  }

  const mainFile = normalizeBundlePath(bundle.mainFile, limits);
  if (!mainFile.endsWith('.bicep')) {
    reject(`mainFile must be a .bicep template, got ${mainFile}`);
  }
  if (!seen.has(mainFile.toLowerCase())) {
    reject(`mainFile ${mainFile} is not present in the bundle`, {
      files: files.map((file) => file.path),
    });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    mainFile,
    files,
    totalBytes,
    sourceHash: hashJson({ mainFile, files }),
  };
};
