import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const OCI_IDENTIFIER = 'ghcr.io/ashergarland/agent-tool-server-azure';
const OCI_REGISTRY = 'https://ghcr.io';
const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const main = async () => {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/validate-release.mjs v<major>.<minor>.<patch>');
  }

  const releaseTag = process.argv[2];
  const match = STABLE_TAG.exec(releaseTag);
  if (!match) {
    throw new Error(
      `release tag must be stable SemVer in the form v<major>.<minor>.<patch>: ${releaseTag}`,
    );
  }
  const tagVersion = releaseTag.slice(1);

  const packageMetadata = await readJson(join(repositoryRoot, 'package.json'));
  const packageLock = await readJson(join(repositoryRoot, 'package-lock.json'));
  const serverMetadata = await readJson(join(repositoryRoot, 'server.json'));
  const environmentExample = await readFile(join(repositoryRoot, '.env.example'), 'utf8');

  const ociPackages = Array.isArray(serverMetadata.packages)
    ? serverMetadata.packages.filter(
        (entry) => entry.registryType === 'oci' && entry.identifier === OCI_IDENTIFIER,
      )
    : [];
  if (ociPackages.length !== 1) {
    throw new Error(
      `server.json must declare exactly one OCI package with identifier ${OCI_IDENTIFIER}`,
    );
  }
  const [ociPackage] = ociPackages;
  if (ociPackage.registryBaseUrl !== OCI_REGISTRY) {
    throw new Error(
      `server.json OCI registryBaseUrl must be ${OCI_REGISTRY}, found ${String(
        ociPackage.registryBaseUrl,
      )}`,
    );
  }

  const serviceVersionMatches = [
    ...environmentExample.matchAll(/^SERVICE_VERSION=([^\r\n]*)\r?$/gm),
  ];
  if (serviceVersionMatches.length !== 1) {
    throw new Error('.env.example must declare SERVICE_VERSION exactly once');
  }

  const versions = new Map([
    ['release tag', tagVersion],
    ['package.json', packageMetadata.version],
    ['package-lock.json', packageLock.version],
    ['package-lock.json root package', packageLock.packages?.['']?.version],
    ['server.json capability', serverMetadata.version],
    ['server.json OCI package', ociPackage.version],
    ['.env.example SERVICE_VERSION', serviceVersionMatches[0][1]],
  ]);
  const mismatches = [...versions].filter(([, version]) => version !== tagVersion);
  if (mismatches.length > 0) {
    const observed = [...versions]
      .map(([source, version]) => `${source}=${String(version)}`)
      .join(', ');
    throw new Error(`release version mismatch: ${observed}`);
  }

  process.stdout.write(`${tagVersion}\n`);
};

main().catch((error) => {
  console.error(`Release contract validation failed: ${error.message}`);
  process.exitCode = 1;
});
