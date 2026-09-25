# Public capability releases

This repository has two separate image paths:

- **Public capability release:** an integrated source tag is validated, built, published to GHCR,
  verified by digest and anonymous pull, attested, and then recorded as a GitHub Release.
- **Operator Azure deployment:** an operator supplies private desired state, builds into an
  operator-owned Azure Container Registry, and deploys an Azure Container App by digest. See the
  [deployment guide](deployment.md).

The public release path never signs in to Azure and does not read parameter files, private endpoints,
operator identities, Key Vault, Container Apps, or private desired-state repositories. The operator
deployment script does not publish the public capability package.

## Release authority

A stable SemVer Git tag is the release authority. For version `0.3.0`, the tag is `v0.3.0`.
The tag target must:

1. be an exact, clean commit integrated into `main`;
2. have a successful completed `CI` push run for that exact commit; and
3. declare `0.3.0` consistently in `package.json`, both root version fields in `package-lock.json`,
   the capability and OCI package entries in `server.json`, and `.env.example` `SERVICE_VERSION`.

The release fails rather than rewriting mismatched metadata. Pre-release or malformed tags are also
rejected. The contract can be checked locally without publishing:

```bash
node scripts/validate-release.mjs v0.3.0
```

## OCI tag and digest policy

The destination is fixed:

```text
ghcr.io/ashergarland/agent-tool-server-azure
```

One build publishes three tags that must resolve to one manifest digest:

| Tag                      | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| `0.3.0`                  | Canonical version required by `server.json`.  |
| `v0.3.0`                 | Alias matching the authoritative source tag.  |
| `sha-<first 12 Git hex>` | Source-commit identity and safe retry anchor. |

`latest` is deliberately not published. The workflow refuses to replace an existing tag with a
different digest and serializes attempts for the same Git ref without canceling a release already in
progress. Consumers that require immutability should use the verified `sha256:` manifest digest
recorded in the GitHub Release.

The Docker build receives the full tagged commit as `GIT_SHA` and the validated source version as
`SERVICE_VERSION`. Before publication, the exact release image is checked for those labels and
environment values, a non-root runtime, stdio MCP tool discovery, HTTP health and version metadata,
authentication on protected HTTP surfaces, and authentication-key leakage in logs.

## Normal release sequence

After the release implementation has been reviewed and integrated:

1. Confirm the exact `main` commit has a successful `CI` push run.
2. Create and push the stable source tag, such as `v0.3.0`, at that exact commit.
3. The [Public OCI release workflow](../.github/workflows/release.yml) validates source metadata and
   exact-source CI, builds the existing `Dockerfile`, and authenticates to GHCR with the repository's
   short-lived `GITHUB_TOKEN`.
4. The workflow publishes or safely resumes the immutable source tag, verifies the image identity,
   and requires an anonymous digest pull.
5. It publishes the version aliases, proves every tag resolves to the same digest, and repeats the
   anonymous pull through the canonical version tag.
6. GitHub's short-lived OIDC identity creates and publishes a standard build-provenance attestation.
7. Only after every OCI check succeeds does the workflow create the matching GitHub Release with the
   version, exact source commit, OCI reference, manifest digest, and exact-source CI run.

No manually stored registry token or PAT is used.

## One-time GHCR visibility prerequisite

GitHub creates a newly published container package as private even when its source repository is
public. A private package cannot satisfy this repository's anonymous-pull release gate.

For the first publication only, the workflow intentionally publishes the `sha-<commit>` retry anchor
before checking anonymous access. If the package is still private, the workflow stops before it
publishes `0.3.0` or `v0.3.0` and before it creates a GitHub Release.

An owner with package admin access must then:

1. open the
   [`agent-tool-server-azure` package settings](https://github.com/users/ashergarland/packages/container/agent-tool-server-azure/settings)
   page, which exists after the first source-tag push;
2. under **Danger Zone**, choose **Change visibility** and set the package to **Public**; and
3. re-run the failed release workflow.

The retry verifies the existing source tag and embedded source identity without overwriting it,
requires anonymous pull, and then completes the version aliases, attestation, and GitHub Release.
Later releases inherit the package's public visibility and should complete in one run.

Do not bypass the anonymous check and do not add a long-lived package credential. Publication is not
complete until both `ghcr.io/ashergarland/agent-tool-server-azure:<version>` and its digest are
pullable without authentication.

## Relationship to operator deployment

[`scripts/bootstrap/deploy.sh`](../scripts/bootstrap/deploy.sh) remains the operator deployment path.
It takes an explicit private parameter file, builds in an operator-owned ACR, resolves that private
image's digest, and updates an existing Azure Container App. It does not consume or publish the GHCR
release automatically.

A future operator may deliberately select a reviewed public release as an input to separate private
desired state, but changing that deployment contract is outside this release mechanism.
