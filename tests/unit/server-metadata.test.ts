import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/index.js';

const read = (relative: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8'),
  ) as Record<string, unknown>;

const serverJson = read('server.json');
const packageJson = read('package.json');

interface EnvironmentVariable {
  name: string;
  description: string;
  isRequired: boolean;
  isSecret: boolean;
}

interface PackageEntry {
  registryType: string;
  identifier: string;
  version: string;
  transport: { type: string };
  environmentVariables?: EnvironmentVariable[];
}

const packages = serverJson['packages'] as PackageEntry[];

describe('server.json registry metadata', () => {
  it('declares the schema the registry validates against', () => {
    expect(serverJson['$schema']).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/.+\/server\.schema\.json$/,
    );
  });

  it('uses a reverse-DNS name with exactly one namespace separator', () => {
    const name = serverJson['name'] as string;
    expect(name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(name.split('/')).toHaveLength(2);
    expect(name.length).toBeGreaterThanOrEqual(3);
    expect(name.length).toBeLessThanOrEqual(200);
  });

  it('keeps the description inside the registry length limit', () => {
    const description = serverJson['description'] as string;
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThanOrEqual(100);
  });

  it('pins an exact version that matches package.json', () => {
    expect(serverJson['version']).toBe(packageJson['version']);
    for (const entry of packages) {
      expect(entry.version).toBe(packageJson['version']);
      expect(entry.version).not.toBe('latest');
      expect(entry.version).not.toMatch(/[\^~><*x]/);
    }
  });

  it('points at the same repository package.json declares', () => {
    const repository = serverJson['repository'] as { url: string; source: string };
    const declared = (packageJson['repository'] as { url: string }).url
      .replace(/^git\+/, '')
      .replace(/\.git$/, '');
    expect(repository.url).toBe(declared);
    expect(repository.source).toBe('github');
  });

  it('declares at least one installable package with a known transport', () => {
    expect(packages.length).toBeGreaterThan(0);
    for (const entry of packages) {
      expect(['npm', 'pypi', 'oci', 'nuget', 'mcpb']).toContain(entry.registryType);
      expect(['stdio', 'streamable-http', 'sse']).toContain(entry.transport.type);
    }
  });

  it('only advertises environment variables the server actually understands', () => {
    const known = new Set(Object.keys(envSchema.shape));
    for (const entry of packages) {
      for (const variable of entry.environmentVariables ?? []) {
        expect(known, `${variable.name} is not part of the environment contract`).toContain(
          variable.name,
        );
        expect(variable.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('never embeds a value, secret or account-specific identifier', () => {
    const serialized = JSON.stringify(serverJson);
    // Any GUID here would be somebody's tenant, subscription or client id.
    expect(serialized).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(serialized).not.toMatch(/\.azurecr\.io|\.azurewebsites\.net|\.azurecontainerapps\.io/);
    for (const entry of packages) {
      for (const variable of entry.environmentVariables ?? []) {
        expect(variable).not.toHaveProperty('value');
        expect(variable).not.toHaveProperty('default');
      }
    }
  });
});
