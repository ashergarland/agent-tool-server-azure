import { z } from 'zod';

/* --------------------------------------------------------------- input parts */

export const subscriptionId = z
  .string()
  .regex(/^[0-9a-fA-F-]{36}$/, 'must be an Azure subscription GUID')
  .describe('Azure subscription id (GUID).');

export const subscriptionIds = z
  .array(subscriptionId)
  .max(50)
  .default([])
  .describe('Subscriptions to target. Defaults to every subscription the server is scoped to.');

export const resourceId = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    'Fully qualified ARM resource id, e.g. /subscriptions/.../providers/Microsoft.Web/sites/app',
  );

export const resourceGroup = z.string().min(1).max(90).describe('Resource group name.');

export const limit = z
  .number()
  .int()
  .min(1)
  .max(1000)
  .default(100)
  .describe('Maximum rows to return.');

export const skipToken = z
  .string()
  .min(1)
  .max(8192)
  .optional()
  .describe('Continuation token returned by a previous call.');

export const mutationFields = {
  confirm: z
    .boolean()
    .default(false)
    .describe('Must be true to actually perform the change; the user has to explicitly agree.'),
  dryRun: z
    .boolean()
    .default(false)
    .describe('When true, validate and report what would happen without changing anything.'),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe('Short human-readable justification recorded in the audit log.'),
};

/* -------------------------------------------------------------- output parts */

export const subscriptionSchema = z.object({
  subscriptionId: z.string(),
  displayName: z.string(),
  state: z.string(),
  tenantId: z.string().optional(),
  /** True when the read/operator identity holds RBAC in this subscription. */
  readable: z.boolean(),
  /** True when the deployment identity is configured and scoped to this subscription. */
  deployable: z.boolean(),
});

export const resourceGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  location: z.string(),
  provisioningState: z.string().optional(),
  tags: z.record(z.string(), z.string()),
});

export const resourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  location: z.string().optional(),
  resourceGroup: z.string().optional(),
  subscriptionId: z.string().optional(),
  kind: z.string().optional(),
  sku: z.unknown().optional(),
  tags: z.record(z.string(), z.string()),
  properties: z.unknown().optional(),
});

export const operationResultSchema = z.object({
  action: z.string(),
  resourceId: z.string(),
  performed: z.boolean(),
  dryRun: z.boolean(),
  message: z.string(),
});
