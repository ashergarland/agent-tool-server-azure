import {
  defineAgentToolCapability,
  type AgentToolCapability,
} from '@agent-tool-platform/runtime/capability';
import type { BicepCompiler } from './bicep/index.js';
import { azureCapabilityConfig, type AppConfig } from './config/index.js';
import type { DeploymentRecordStore } from './deployments/records.js';
import { capabilityManifest } from './manifest.js';
import { createAzureProvider } from './provider/azure/index.js';
import type { AzureProvider } from './provider/types.js';
import { azureReadiness } from './readiness.js';
import { createServices, type CreateServicesOptions, type Services } from './services/index.js';
import { toolDefinitions } from './tools/definitions/index.js';
import { SERVER_INSTRUCTIONS } from './tools/instructions.js';
import type { Metrics } from './util/metrics.js';

export interface AzureCapabilityDependencies {
  readonly provider?: AzureProvider;
  readonly compiler?: BicepCompiler;
  readonly store?: DeploymentRecordStore;
  readonly metrics?: Metrics;
}

export const createAzureCapability = (
  dependencies: AzureCapabilityDependencies = {},
): AgentToolCapability<Services, AppConfig> =>
  defineAgentToolCapability({
    manifest: capabilityManifest,
    instructions: SERVER_INSTRUCTIONS,
    config: azureCapabilityConfig,
    tools: toolDefinitions,

    createServices({ config, logger }): Services {
      const provider = dependencies.provider ?? createAzureProvider(config);
      const options: CreateServicesOptions = {
        ...(dependencies.compiler === undefined ? {} : { compiler: dependencies.compiler }),
        ...(dependencies.store === undefined ? {} : { store: dependencies.store }),
        ...(dependencies.metrics === undefined ? {} : { metrics: dependencies.metrics }),
      };
      return createServices(config, provider, logger, options);
    },

    readiness: azureReadiness,

    protectedRoutes: [
      (router, { services }): void => {
        router.get('/metrics', () => services.metrics.snapshot());
      },
    ],
  });

export const capability = createAzureCapability();
