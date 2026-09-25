import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { URL } from 'node:url';
import { evaluateReleaseIntegrity } from '../scripts/release-integrity.mjs';

const CANDIDATE = `sha256:${'a'.repeat(64)}`;
const CONFLICT = `sha256:${'b'.repeat(64)}`;
const SOURCE_TAG = 'sha-0123456789ab';
const WORKFLOW = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

const state = (digests, overrides = {}) => ({
  candidateDigest: CANDIDATE,
  version: '0.3.0',
  sourceTag: SOURCE_TAG,
  requireAll: false,
  digests: {
    source: null,
    canonical: null,
    versionAlias: null,
    ...digests,
  },
  ...overrides,
});

describe('release integrity', () => {
  it('accepts a first publication with all release tags missing', () => {
    const result = evaluateReleaseIntegrity(state({}));

    assert.deepEqual(result.missingTags, [SOURCE_TAG, '0.3.0', 'v0.3.0']);
    assert.deepEqual(result.reusableTags, []);
  });

  it('reuses a matching immutable source tag', () => {
    const result = evaluateReleaseIntegrity(state({ source: CANDIDATE }));

    assert.deepEqual(result.reusableTags, [SOURCE_TAG]);
  });

  it('fails when the immutable source tag conflicts with the fresh build', () => {
    assert.throws(
      () =>
        evaluateReleaseIntegrity(
          state(
            { source: CONFLICT },
            { imageMetadata: { gitSha: '0123456789abcdef', serviceVersion: '0.3.0' } },
          ),
        ),
      /existing tag sha-0123456789ab resolves to .* not fresh-build candidate/,
    );
  });

  it('reuses a matching canonical version tag', () => {
    const result = evaluateReleaseIntegrity(state({ canonical: CANDIDATE }));

    assert.deepEqual(result.reusableTags, ['0.3.0']);
  });

  it('fails when the canonical version tag conflicts with the fresh build', () => {
    assert.throws(
      () => evaluateReleaseIntegrity(state({ canonical: CONFLICT })),
      /existing tag 0\.3\.0 resolves to .* not fresh-build candidate/,
    );
  });

  it('reuses a matching v-version tag', () => {
    const result = evaluateReleaseIntegrity(state({ versionAlias: CANDIDATE }));

    assert.deepEqual(result.reusableTags, ['v0.3.0']);
  });

  it('fails when the v-version tag conflicts with the fresh build', () => {
    assert.throws(
      () => evaluateReleaseIntegrity(state({ versionAlias: CONFLICT })),
      /existing tag v0\.3\.0 resolves to .* not fresh-build candidate/,
    );
  });

  it('supports safe resume from a matching source tag with missing aliases', () => {
    const result = evaluateReleaseIntegrity(state({ source: CANDIDATE }));

    assert.deepEqual(result.missingTags, ['0.3.0', 'v0.3.0']);
  });

  it('supports a matching version alias that exists before the source tag', () => {
    const result = evaluateReleaseIntegrity(state({ canonical: CANDIDATE }));

    assert.deepEqual(result.missingTags, [SOURCE_TAG, 'v0.3.0']);
  });

  it('requires the final alias set to be complete and equal to the candidate', () => {
    const result = evaluateReleaseIntegrity(
      state(
        {
          source: CANDIDATE,
          canonical: CANDIDATE,
          versionAlias: CANDIDATE,
        },
        { requireAll: true },
      ),
    );

    assert.deepEqual(result.verifiedTags, [SOURCE_TAG, '0.3.0', 'v0.3.0']);
    assert.throws(
      () =>
        evaluateReleaseIntegrity(
          state({ source: CANDIDATE, canonical: CANDIDATE }, { requireAll: true }),
        ),
      /required release tag v0\.3\.0 is missing/,
    );
  });

  it('rejects malformed candidate and existing registry digests', () => {
    assert.throws(
      () => evaluateReleaseIntegrity(state({}, { candidateDigest: 'sha256:not-a-digest' })),
      /fresh-build candidate digest must be/,
    );
    assert.throws(
      () => evaluateReleaseIntegrity(state({ source: 'sha256:not-a-digest' })),
      /existing tag sha-0123456789ab digest must be/,
    );
  });

  it('orders the private-package gate before aliases, attestation, and release', () => {
    const orderedSteps = [
      'Fresh-build and push the validation manifest',
      'Establish the authoritative candidate registry digest',
      'Compare existing release tags with the fresh build',
      'Establish or reuse the immutable source tag',
      'Require anonymous public pull',
      'Establish or reuse version aliases',
      'Verify every release alias against the fresh build',
      'Attest published image provenance',
      'Create GitHub Release',
    ];
    const positions = orderedSteps.map((step) => WORKFLOW.indexOf(`- name: ${step}`));

    assert.equal(
      positions.every((position) => position >= 0),
      true,
    );
    assert.deepEqual(
      positions,
      [...positions].sort((left, right) => left - right),
    );
  });

  it('uses the fresh registry candidate for attestation and release metadata', () => {
    assert.match(WORKFLOW, /digest: \$\{\{ steps\.candidate\.outputs\.digest \}\}/);
    assert.match(WORKFLOW, /subject-digest: \$\{\{ steps\.candidate\.outputs\.digest \}\}/);
    assert.match(WORKFLOW, /DIGEST: \$\{\{ needs\.publish\.outputs\.digest \}\}/);
    assert.match(
      WORKFLOW,
      /VALIDATION_TAG: release-validation-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
    );
  });
});
