import { z } from 'zod';
import { defineTool } from '../types.js';
import { mutationFields, operationResultSchema, resourceId, resourceSchema } from '../schemas.js';

const previewFirst =
  'Always call with dryRun=true first, show the user exactly what would happen, and only call ' +
  'again with confirm=true after they explicitly agree. The server refuses the change unless it ' +
  'was deployed with mutations enabled.';

export const restartVirtualMachineTool = defineTool({
  name: 'azure_restart_virtual_machine',
  title: 'Restart a virtual machine',
  summary: 'Restart an Azure virtual machine (state-changing).',
  description: `Restarts a Microsoft.Compute/virtualMachines resource. In-flight work on the machine is lost and the machine is unavailable while it reboots. ${previewFirst}`,
  kind: 'write',
  annotations: { destructiveHint: true, idempotentHint: false },
  routing: {
    useWhen: [
      'Diagnosis showed a hung or unresponsive virtual machine and a reboot is the agreed remedy.',
      'The user explicitly asked to restart a named virtual machine and approved the disruption.',
    ],
    doNotUseWhen: [
      'The machine is stopped or deallocated — use azure_start_virtual_machine.',
      'The target is an App Service or Function App — use azure_restart_web_app.',
      'You have not yet confirmed the resource type with azure_get_resource.',
    ],
    requiredScope: 'Restart permission on the virtual machine, inside the allow-listed scope.',
    changesState: true,
    prerequisites: ['azure_get_resource', 'azure_get_resource_metrics'],
    nextSteps: ['azure_get_resource', 'azure_get_activity_log'],
  },
  inputSchema: z.object({ resourceId, ...mutationFields }),
  outputSchema: operationResultSchema,
  handler: (input, services, context) =>
    services.operations.restartVirtualMachine({
      resourceId: input.resourceId,
      confirm: input.confirm,
      dryRun: input.dryRun,
      reason: input.reason,
      principal: context.principal,
      requestId: context.requestId,
      transport: context.transport,
    }),
});

export const startVirtualMachineTool = defineTool({
  name: 'azure_start_virtual_machine',
  title: 'Start a virtual machine',
  summary: 'Start a stopped or deallocated Azure virtual machine (state-changing).',
  description: `Starts a stopped or deallocated Microsoft.Compute/virtualMachines resource. Starting a deallocated machine begins incurring compute charges again. ${previewFirst}`,
  kind: 'write',
  annotations: { destructiveHint: false, idempotentHint: true },
  routing: {
    useWhen: [
      'A virtual machine is stopped or deallocated and the user asked for it to be running.',
      'A scheduled shutdown stopped a machine that is needed now.',
    ],
    doNotUseWhen: [
      'The machine is already running but misbehaving — use azure_restart_virtual_machine.',
      'The target is not a virtual machine.',
    ],
    requiredScope: 'Start permission on the virtual machine, inside the allow-listed scope.',
    changesState: true,
    prerequisites: ['azure_get_resource'],
    nextSteps: ['azure_get_resource'],
  },
  inputSchema: z.object({ resourceId, ...mutationFields }),
  outputSchema: operationResultSchema,
  handler: (input, services, context) =>
    services.operations.startVirtualMachine({
      resourceId: input.resourceId,
      confirm: input.confirm,
      dryRun: input.dryRun,
      reason: input.reason,
      principal: context.principal,
      requestId: context.requestId,
      transport: context.transport,
    }),
});

export const restartWebAppTool = defineTool({
  name: 'azure_restart_web_app',
  title: 'Restart an App Service app',
  summary: 'Restart an Azure App Service or Function App (state-changing).',
  description: `Restarts a Microsoft.Web/sites resource. In-flight HTTP requests are dropped and the site is briefly unavailable while workers recycle. ${previewFirst}`,
  kind: 'write',
  annotations: { destructiveHint: true, idempotentHint: false },
  routing: {
    useWhen: [
      'An App Service or Function App is wedged, leaking memory or serving stale configuration.',
      'The user approved recycling the site to clear a fault.',
    ],
    doNotUseWhen: [
      'The target is a virtual machine — use azure_restart_virtual_machine.',
      'The fault is a platform outage rather than the app — check ' +
        'azure_list_unhealthy_resources first.',
    ],
    requiredScope: 'Restart permission on the site, inside the allow-listed scope.',
    changesState: true,
    prerequisites: ['azure_get_resource'],
    nextSteps: ['azure_get_resource_metrics'],
  },
  inputSchema: z.object({ resourceId, ...mutationFields }),
  outputSchema: operationResultSchema,
  handler: (input, services, context) =>
    services.operations.restartWebApp({
      resourceId: input.resourceId,
      confirm: input.confirm,
      dryRun: input.dryRun,
      reason: input.reason,
      principal: context.principal,
      requestId: context.requestId,
      transport: context.transport,
    }),
});

export const tagResourceTool = defineTool({
  name: 'azure_tag_resource',
  title: 'Tag a resource',
  summary: 'Merge tags onto an Azure resource (state-changing).',
  description: `Merges the supplied tags onto a resource, leaving tags you did not name untouched. A tag whose name already exists is overwritten. ${previewFirst}`,
  kind: 'write',
  annotations: { destructiveHint: false, idempotentHint: true },
  routing: {
    useWhen: [
      'The user asked to label a resource for ownership, cost allocation or lifecycle.',
      'A governance policy requires a tag that is missing.',
    ],
    doNotUseWhen: [
      'You want to remove a tag; this tool only merges and cannot delete tags.',
      'You intend to change any other resource configuration — use the Bicep deployment tools.',
    ],
    requiredScope: 'Tag write permission on the resource, inside the allow-listed scope.',
    changesState: true,
    prerequisites: ['azure_get_resource'],
  },
  inputSchema: z.object({
    resourceId,
    tags: z.record(z.string().min(1).max(512), z.string().max(256)),
    ...mutationFields,
  }),
  outputSchema: operationResultSchema.extend({ resource: resourceSchema.optional() }),
  handler: async (input, services, context) => {
    const result = await services.operations.tagResource({
      resourceId: input.resourceId,
      tags: input.tags,
      confirm: input.confirm,
      dryRun: input.dryRun,
      reason: input.reason,
      principal: context.principal,
      requestId: context.requestId,
      transport: context.transport,
    });
    return {
      action: result.action,
      resourceId: result.resourceId,
      performed: result.performed,
      dryRun: result.dryRun,
      message: result.message,
      ...(result.resource === undefined ? {} : { resource: result.resource }),
    };
  },
});
