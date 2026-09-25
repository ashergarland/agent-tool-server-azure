import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const OCI_DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE_TAG = /^sha-[0-9a-f]{12}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST_KEYS = ['source', 'canonical', 'versionAlias'];

const requireDigest = (value, description) => {
  if (typeof value !== 'string' || !OCI_DIGEST.test(value)) {
    throw new Error(`${description} must be a lowercase sha256 OCI manifest digest`);
  }
  return value;
};

export const evaluateReleaseIntegrity = (state) => {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('release integrity state must be an object');
  }

  const candidateDigest = requireDigest(state.candidateDigest, 'fresh-build candidate digest');
  if (typeof state.version !== 'string' || !STABLE_VERSION.test(state.version)) {
    throw new Error('release version must be stable SemVer without a v prefix');
  }
  if (typeof state.sourceTag !== 'string' || !SOURCE_TAG.test(state.sourceTag)) {
    throw new Error('source tag must have the form sha-<12 lowercase Git hex>');
  }
  if (!state.digests || typeof state.digests !== 'object' || Array.isArray(state.digests)) {
    throw new Error('release tag digests must be an object');
  }

  const unexpectedKeys = Object.keys(state.digests).filter((key) => !DIGEST_KEYS.includes(key));
  if (unexpectedKeys.length > 0) {
    throw new Error(`unexpected release tag digest keys: ${unexpectedKeys.join(', ')}`);
  }

  const tags = [
    { key: 'source', name: state.sourceTag },
    { key: 'canonical', name: state.version },
    { key: 'versionAlias', name: `v${state.version}` },
  ];
  const missingTags = [];
  const reusableTags = [];

  for (const tag of tags) {
    const digest = state.digests[tag.key];
    if (digest === null) {
      if (state.requireAll === true) {
        throw new Error(`required release tag ${tag.name} is missing`);
      }
      missingTags.push(tag.name);
      continue;
    }

    const existingDigest = requireDigest(digest, `existing tag ${tag.name} digest`);
    if (existingDigest !== candidateDigest) {
      throw new Error(
        `existing tag ${tag.name} resolves to ${existingDigest}, ` +
          `not fresh-build candidate ${candidateDigest}`,
      );
    }
    reusableTags.push(tag.name);
  }

  return {
    candidateDigest,
    missingTags,
    reusableTags,
    verifiedTags: state.requireAll === true ? reusableTags : [],
  };
};

const main = async () => {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/release-integrity.mjs <state.json>');
  }
  const state = JSON.parse(await readFile(process.argv[2], 'utf8'));
  process.stdout.write(`${JSON.stringify(evaluateReleaseIntegrity(state))}\n`);
};

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(`Release integrity validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
