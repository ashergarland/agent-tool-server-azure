import type { ToolDefinition } from '../types.js';
import {
  getResourceTool,
  listResourceGroupsTool,
  listSubscriptionsTool,
  runGraphQueryTool,
  searchResourcesTool,
} from './inventory.js';
import { getActivityLogTool, getMetricsTool, getUnhealthyResourcesTool } from './diagnostics.js';
import {
  restartVirtualMachineTool,
  restartWebAppTool,
  startVirtualMachineTool,
  tagResourceTool,
} from './operations.js';
import {
  deployBicepTool,
  getDeploymentTool,
  listDeploymentOperationsTool,
  rollbackDeploymentTool,
  validateBicepTool,
  whatIfBicepTool,
} from './bicep.js';

export * from './inventory.js';
export * from './diagnostics.js';
export * from './operations.js';
export * from './bicep.js';

/**
 * The single ordered catalogue every transport is built from. Order matters only for
 * presentation: discovery first, then diagnosis, then constrained operations, then deployments.
 */
export const toolDefinitions = [
  listSubscriptionsTool,
  listResourceGroupsTool,
  searchResourcesTool,
  getResourceTool,
  runGraphQueryTool,
  getActivityLogTool,
  getMetricsTool,
  getUnhealthyResourcesTool,
  restartVirtualMachineTool,
  startVirtualMachineTool,
  restartWebAppTool,
  tagResourceTool,
  validateBicepTool,
  whatIfBicepTool,
  deployBicepTool,
  getDeploymentTool,
  listDeploymentOperationsTool,
  rollbackDeploymentTool,
] as const satisfies readonly ToolDefinition[];
