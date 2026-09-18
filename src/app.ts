import {
  createAgentToolApplication,
  type AgentToolApplication,
  type CreateApplicationOptions as PlatformApplicationOptions,
} from '@agent-tool-platform/runtime/capability';
import { createAzureCapability, type AzureCapabilityDependencies } from './capability.js';
import type { AppConfig } from './config/index.js';
import type { Services } from './services/index.js';

export type Application = AgentToolApplication<AppConfig, Services>;

export type CreateApplicationOptions = PlatformApplicationOptions<AppConfig> &
  AzureCapabilityDependencies;

/** Test and embedding seam; all runtime assembly remains owned by Agent Tool Platform. */
export const createApplication = async (
  options: CreateApplicationOptions = {},
): Promise<Application> => {
  const { provider, compiler, store, metrics, ...platformOptions } = options;
  const application = await createAgentToolApplication(
    createAzureCapability({
      ...(provider === undefined ? {} : { provider }),
      ...(compiler === undefined ? {} : { compiler }),
      ...(store === undefined ? {} : { store }),
      ...(metrics === undefined ? {} : { metrics }),
    }),
    platformOptions,
  );
  await application.start();
  return application;
};
