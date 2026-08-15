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
