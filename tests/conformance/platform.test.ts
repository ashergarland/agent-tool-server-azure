import { readFile } from 'node:fs/promises';
import {
  createAgentToolApplication,
  type AgentToolApplication,
} from '@agent-tool-platform/runtime/capability';
import { createSilentLogger } from '@agent-tool-platform/runtime/logging';
import { createToolRegistry } from '@agent-tool-platform/runtime/tools';
import {
  generateTestApiKey,
  runAuthConformance,
  runConfigConformance,
  runHttpConformance,
  runLifecycleConformance,
  runMcpConformance,
  runMetadataConformance,
  runOpenApiConformance,
  runRoutingConformance,
  runTransportParity,
} from '@agent-tool-platform/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { createAzureCapability, type AzureCapabilityDependencies } from '../../src/capability.js';
import { azureCapabilityConfig, type AppConfig } from '../../src/config/index.js';
import { capabilityManifest } from '../../src/manifest.js';
import { createServices, type Services } from '../../src/services/index.js';
import { toolDefinitions } from '../../src/tools/definitions/index.js';
import { SERVER_INSTRUCTIONS } from '../../src/tools/instructions.js';
import { createFakeCompiler } from '../helpers/bicep.js';
import { createFakeProvider } from '../helpers/fake-provider.js';
import { testConfig } from '../helpers/config.js';

type TestApplication = AgentToolApplication<AppConfig, Services>;

const apiKey = generateTestApiKey();
const applications: TestApplication[] = [];
const readSample = { name: 'azure_list_subscriptions', input: {} } as const;

const dependencies = (): AzureCapabilityDependencies => ({
  provider: createFakeProvider(),
  compiler: createFakeCompiler(),
});

const createApplication = async (start = true): Promise<TestApplication> => {
  const application = await createAgentToolApplication(createAzureCapability(dependencies()), {
    logger: createSilentLogger(),
    env: {
      NODE_ENV: 'test',
      AUTH_MODE: 'api-key',
      API_KEYS: apiKey,
    },
    readinessCacheMs: 0,
  });
  applications.push(application);
  if (start) await application.start();
  return application;
};

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.shutdown()));
});

describe('Agent Tool Platform conformance', () => {
  it('satisfies registry behavior and routing without collapsing nondestructive writes', async () => {
    const registry = createToolRegistry(toolDefinitions);
    const services = createServices(testConfig(), createFakeProvider(), createSilentLogger(), {
      compiler: createFakeCompiler(),
    });

    expect(registry.size).toBe(toolDefinitions.length);
    await expect(
      registry.invoke('azure_get_resource', { resourceId: 42 }, services, {
        requestId: 'invalid-input',
        principal: { id: 'conformance', kind: 'anonymous' },
        transport: 'http',
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(runRoutingConformance({ registry, instructions: SERVER_INSTRUCTIONS }).failures).toEqual(
      [],
    );
    expect(registry.get('azure_tag_resource').annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
  });

  it('satisfies authentication and composed configuration contracts', async () => {
    expect((await runAuthConformance()).failures).toEqual([]);
    expect(
      (
        await runConfigConformance({
          spec: azureCapabilityConfig,
          serviceName: capabilityManifest.name,
          serviceVersion: capabilityManifest.version,
          expect: (config) =>
            config.azure.armEndpoint === 'https://management.azure.com' &&
            config.http.bodyLimit === 4_194_304,
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies HTTP, MCP, OpenAPI, and transport parity contracts', async () => {
    const application = await createApplication();
    expect(
      (
        await runHttpConformance({
          app: application.http,
          registry: application.registry,
          apiKey,
          readSample: { name: readSample.name, body: readSample.input },
          protectedExtensionPaths: ['/metrics'],
        })
      ).failures,
    ).toEqual([]);
    expect(
      (
        await runMcpConformance({
          createServer: () => application.createStdioServer(),
          registry: application.registry,
          instructions: SERVER_INSTRUCTIONS,
          readSample,
        })
      ).failures,
    ).toEqual([]);
    expect(
      runOpenApiConformance({
        document: application.openApiDocument(),
        registry: application.registry,
      }).failures,
    ).toEqual([]);
    expect(
      (
        await runTransportParity({
          app: application.http,
          createMcpServer: () => application.createStdioServer(),
          apiKey,
          samples: [readSample],
        })
      ).failures,
    ).toEqual([]);
  });

  it('satisfies lifecycle and readiness behavior without live credentials', async () => {
    expect(
      (
        await runLifecycleConformance({
          createApplication: () => createApplication(false),
        })
      ).failures,
    ).toEqual([]);
  });

  it('publishes truthful repository metadata', async () => {
    const load = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
    expect(
      runMetadataConformance({
        server: await load('../../server.json'),
        packageManifest: await load('../../package.json'),
      }).failures,
    ).toEqual([]);
  });
});
