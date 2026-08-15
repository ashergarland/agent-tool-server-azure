import { badRequest } from '../errors.js';
import type { NormalizedBundle } from './types.js';

export interface ModulePolicy {
  /** Remote module restore is off unless an operator deliberately turns it on. */
  readonly remoteModulesEnabled: boolean;
  /** Lower-cased OCI registry hosts that `br:` references may target. */
  readonly allowedRegistries: readonly string[];
  /** Whether `ts:` Template Spec references are permitted. */
  readonly templateSpecsEnabled: boolean;
  /** Subscriptions whose Template Specs may be referenced. */
  readonly allowedSubscriptionIds: readonly string[];
}

export const DEFAULT_MODULE_POLICY: ModulePolicy = {
  remoteModulesEnabled: false,
  allowedRegistries: [],
  templateSpecsEnabled: false,
  allowedSubscriptionIds: [],
};

/** `br:host/path:tag`, `br/alias:path:tag`, `ts:sub/rg/name:version`, `ts/alias:name:version`. */
const REMOTE_REFERENCE = /'((?:br|ts)[:/][^'\n]*)'/g;

/**
 * Bicep's compile-time file functions. They are evaluated by the compiler, which reads the named
 * path from disk and inlines its bytes into the emitted ARM template.
 */
const FILE_LOAD = /\bload(?:TextContent|FileAsBase64|JsonContent|YamlContent)\s*\(([^)]*)\)/g;
const LITERAL_FIRST_ARGUMENT = /^\s*'([^'\n]*)'/;

export interface RemoteModuleReference {
  readonly file: string;
  readonly reference: string;
  readonly scheme: 'br' | 'ts';
}

export const findRemoteModuleReferences = (
  bundle: NormalizedBundle,
): readonly RemoteModuleReference[] => {
  const found: RemoteModuleReference[] = [];
  for (const file of bundle.files) {
    if (!file.path.endsWith('.bicep') && !file.path.endsWith('.bicepparam')) continue;
    for (const match of file.content.matchAll(REMOTE_REFERENCE)) {
      const reference = match[1] ?? '';
      found.push({
        file: file.path,
        reference,
        scheme: reference.startsWith('ts') ? 'ts' : 'br',
      });
    }
  }
  return found;
};

const assertRegistryAllowed = (reference: RemoteModuleReference, policy: ModulePolicy): void => {
  // `br/alias:` resolves through bicepconfig.json module aliases. The server writes that file with
  // no aliases defined, so an alias reference can only ever be an attempt to reach configuration
  // the caller does not control.
  if (reference.reference.startsWith('br/')) {
    throw badRequest(
      `Module alias references are not supported: ${reference.reference} in ${reference.file}. ` +
        'Use a fully qualified br:<registry>/<path>:<tag> reference.',
    );
  }
  const host = reference.reference.slice('br:'.length).split('/')[0]?.toLowerCase() ?? '';
  if (!policy.allowedRegistries.includes(host)) {
    throw badRequest(`Container registry ${host || '(none)'} is not allow-listed for modules`, {
      file: reference.file,
      allowedRegistries: policy.allowedRegistries,
    });
  }
};

const assertTemplateSpecAllowed = (
  reference: RemoteModuleReference,
  policy: ModulePolicy,
): void => {
  if (!policy.templateSpecsEnabled) {
    throw badRequest(
      `Template Spec references are disabled: ${reference.reference} in ${reference.file}`,
    );
  }
  if (reference.reference.startsWith('ts/')) {
    throw badRequest(
      `Template Spec alias references are not supported: ${reference.reference} in ${reference.file}`,
    );
  }
  const subscription = reference.reference.slice('ts:'.length).split('/')[0]?.toLowerCase() ?? '';
  if (
    policy.allowedSubscriptionIds.length > 0 &&
    !policy.allowedSubscriptionIds.includes(subscription)
  ) {
    throw badRequest(`Template Spec subscription ${subscription} is outside the allow-list`, {
      file: reference.file,
    });
  }
};

/**
 * Rejects any module reference the deployment policy does not permit, before the compiler is ever
 * started. Failing here gives the caller an actionable message and means the compiler never has a
 * reason to open a network connection.
 */
export const assertModuleReferencesAllowed = (
  bundle: NormalizedBundle,
  policy: ModulePolicy,
): readonly RemoteModuleReference[] => {
  const references = findRemoteModuleReferences(bundle);
  if (references.length === 0) return references;

  if (!policy.remoteModulesEnabled) {
    throw badRequest(
      'Remote Bicep modules are disabled on this server. Include the module source in the ' +
        'bundle and reference it with a relative path.',
      { references: references.map((reference) => `${reference.file}: ${reference.reference}`) },
    );
  }

  for (const reference of references) {
    if (reference.scheme === 'ts') assertTemplateSpecAllowed(reference, policy);
    else assertRegistryAllowed(reference, policy);
  }
  return references;
};

/** Resolves a POSIX path relative to a file's directory, or undefined if it escapes the root. */
const resolveWithinBundle = (fromFile: string, relative: string): string | undefined => {
  const segments = fromFile.split('/').slice(0, -1);
  for (const segment of relative.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join('/');
};

/**
 * Rejects compile-time file loads that reach outside the bundle.
 *
 * `loadTextContent`, `loadFileAsBase64`, `loadJsonContent` and `loadYamlContent` are evaluated by
 * the compiler against the real filesystem, and their result is inlined into the emitted template.
 * Left unchecked, `loadTextContent('../../../../proc/self/environ')` turns a template into an
 * arbitrary file read whose output is returned to the caller — so the argument must be a literal
 * relative path that resolves to a file the caller supplied in this very bundle.
 */
export const assertFileLoadsAllowed = (bundle: NormalizedBundle): void => {
  const present = new Set(bundle.files.map((file) => file.path.toLowerCase()));

  for (const file of bundle.files) {
    if (!file.path.endsWith('.bicep') && !file.path.endsWith('.bicepparam')) continue;

    for (const match of file.content.matchAll(FILE_LOAD)) {
      const args = match[1] ?? '';
      const literal = LITERAL_FIRST_ARGUMENT.exec(args);
      const target = literal?.[1];
      // Bicep interpolates inside single quotes, so a literal containing `${…}` is still a value
      // this server cannot resolve ahead of the compiler.
      if (target === undefined || target.includes('${')) {
        throw badRequest(
          `${file.path} loads a file using a computed path. The path must be a literal ` +
            'relative path with no interpolation, so the server can check where it points.',
          { expression: match[0].slice(0, 120) },
        );
      }

      const resolved = resolveWithinBundle(file.path, target);
      if (resolved === undefined || !present.has(resolved.toLowerCase())) {
        throw badRequest(
          `${file.path} loads "${target}", which is not a file in this bundle. Compile-time file ` +
            'loads may only reference files supplied in the same bundle.',
        );
      }
    }
  }
};

/** Every source-level check that must pass before a bundle is handed to a compiler. */
export const assertBundleSourceAllowed = (bundle: NormalizedBundle, policy: ModulePolicy): void => {
  assertModuleReferencesAllowed(bundle, policy);
  assertFileLoadsAllowed(bundle);
};
