import { createHash } from 'node:crypto';

/** Deterministic JSON with object keys sorted, so hashes are stable across engines and orders. */
export const canonicalJson = (value: unknown): string => {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([key, entryValue]) => [key, walk(entryValue)]));
    }
    return node;
  };
  return JSON.stringify(walk(value) ?? null);
};

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const hashJson = (value: unknown): string => sha256Hex(canonicalJson(value));

export interface ConfirmationHashInput {
  /** Digest of the exact source bundle that was compiled. */
  readonly sourceHash: string;
  /** Digest of the compiled ARM template. */
  readonly templateHash: string;
  /** Digest of the parameters exactly as supplied, including secure names. */
  readonly parametersHash: string;
  /** Canonical scope string, e.g. `resourceGroup:/subscriptions/…/resourceGroups/rg`. */
  readonly scopeKey: string;
  readonly mode: string;
  /** Digest of the normalised what-if preview the user approved. */
  readonly previewHash: string;
}

/**
 * Binds a preview to a deployment. Any difference in source, parameters, scope, mode or the
 * preview the user actually saw produces a different hash, and the deployment is refused.
 */
export const computeConfirmationHash = (input: ConfirmationHashInput): string =>
  hashJson({
    v: 1,
    sourceHash: input.sourceHash,
    templateHash: input.templateHash,
    parametersHash: input.parametersHash,
    scopeKey: input.scopeKey,
    mode: input.mode,
    previewHash: input.previewHash,
  });
