import { z } from 'zod';
import { defineTool } from '../types.js';
import type { DeployResult, WhatIfResult } from '../../services/deployments.js';
import type { DeploymentScope } from '../../provider/types.js';

/* ------------------------------------------------------------------ shapes */

const bundleSchema = z
  .object({
    mainFile: z
      .string()
      .min(1)
      .max(200)
      .describe('Relative path of the entry .bicep template inside files, e.g. "main.bicep".'),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .min(1)
              .max(200)
              .describe('Relative POSIX path. Absolute paths and ".." are rejected.'),
            content: z.string().max(262_144).describe('UTF-8 file contents.'),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .describe(
    'A self-contained virtual bundle. Modules must be included as files and referenced by ' +
      'relative path; the server never fetches anything from a URL or a registry by default.',
  );

const scopeSchema = z
  .object({
    kind: z
      .enum(['resourceGroup', 'subscription', 'managementGroup', 'tenant'])
      .describe('Deployment scope. Must match the scope the template targets.'),
    subscriptionId: z.string().max(64).optional(),
    resourceGroup: z.string().max(90).optional(),
    managementGroupId: z.string().max(90).optional(),
    location: z
      .string()
      .max(40)
      .optional()
      .describe('Required for subscription, managementGroup and tenant scopes.'),
  })
  .strict();

const scopeOutputSchema = z.object({
  kind: z.string(),
  subscriptionId: z.string().optional(),
  resourceGroup: z.string().optional(),
  managementGroupId: z.string().optional(),
  location: z.string().optional(),
  armScope: z.string(),
});

const diagnosticSchema = z.object({
  level: z.string(),
  code: z.string().optional(),
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
});

const warningSchema = z.object({ code: z.string(), message: z.string() });

const changeSchema = z.object({
  changeType: z.string(),
  resourceId: z.string(),
  resourceType: z.string(),
  propertyChanges: z.array(z.object({ path: z.string(), changeType: z.string() })),
  propertyChangesTruncated: z.boolean(),
  unsupportedReason: z.string().optional(),
});

const summarySchema = z.object({
  totalChanges: z.number(),
  countsByChangeType: z.record(z.string(), z.number()),
  deletes: z.array(z.string()),
  unsupported: z.array(z.string()),
  truncated: z.boolean(),
});

const previewSchema = z.object({
  previewId: z.string(),
  confirmationHash: z.string(),
  expiresAt: z.string(),
  scope: scopeOutputSchema,
  mode: z.literal('Incremental'),
  sourceHash: z.string(),
  templateHash: z.string(),
  summary: summarySchema,
  changes: z.array(changeSchema),
  diagnostics: z.array(diagnosticSchema),
  warnings: z.array(warningSchema),
  resourceTypes: z.array(z.string()),
  secureParameterNames: z.array(z.string()),
});

const deployResultSchema = z.object({
  recordId: z.string(),
  deploymentId: z.string(),
  deploymentName: z.string(),
  status: z.string(),
  scope: scopeOutputSchema,
  confirmationHash: z.string(),
  templateHash: z.string(),
  correlationId: z.string().optional(),
  startedAt: z.string(),
  alreadyStarted: z.boolean(),
  message: z.string(),
});

const parameters = z
  .record(z.string().min(1).max(200), z.unknown())
  .default({})
  .describe('Template parameter values, keyed by parameter name. Do not wrap them in {"value":…}.');

const targetFields = {
  recordId: z
    .string()
    .max(200)
    .optional()
    .describe('Record id returned by azure_deploy_bicep. Preferred.'),
  scope: scopeSchema.optional().describe('Only needed when recordId is not supplied.'),
  deploymentName: z
    .string()
    .max(64)
    .optional()
    .describe('ARM deployment name. Only needed when recordId is not supplied.'),
};

/* ------------------------------------------------------------------- tools */

export const validateBicepTool = defineTool({
  name: 'azure_validate_bicep',
  title: 'Validate Bicep source',
  summary: 'Compile and statically check Bicep source without contacting Azure.',
  description:
    'Compiles a self-contained Bicep bundle with a pinned Bicep compiler and statically inspects ' +
    'the resulting ARM template. Returns compiler diagnostics, the resource types and scope the ' +
    'template targets, a template hash, and warnings such as privileged resource types. Nothing ' +
    'is sent to Azure and nothing is changed. Templates that run scripts, reference linked ' +
    'templates or point at external content URLs are rejected here rather than at deploy time.',
  kind: 'read',
  routing: {
    useWhen: [
      'You wrote or edited Bicep and want to know whether it compiles and what it would create.',
      'You want to check a template against this server’s deployment policy before planning work.',
      'Deployments are disabled but you still want to review a template.',
    ],
    doNotUseWhen: [
      'You need to know the effect on existing Azure resources — use azure_what_if_bicep.',
      'You want to apply the template — use azure_what_if_bicep and then azure_deploy_bicep.',
    ],
    requiredScope: 'None. This tool never contacts Azure.',
    changesState: false,
    nextSteps: ['azure_what_if_bicep'],
  },
  inputSchema: z.object({ bundle: bundleSchema }).strict(),
  outputSchema: z.object({
    valid: z.boolean(),
    diagnostics: z.array(diagnosticSchema),
    sourceHash: z.string(),
    templateHash: z.string().optional(),
    templateScope: z.string().optional(),
    resourceTypes: z.array(z.string()),
    resourceCount: z.number().optional(),
    nestedDeploymentCount: z.number().optional(),
    parameterNames: z.array(z.string()),
    secureParameterNames: z.array(z.string()),
    outputNames: z.array(z.string()),
    warnings: z.array(warningSchema),
  }),
  handler: async (input, services) => {
    const result = await services.deployments.validate({ bundle: input.bundle });
    return {
      valid: result.valid,
      diagnostics: [...result.diagnostics],
      sourceHash: result.sourceHash,
      ...(result.templateHash === undefined ? {} : { templateHash: result.templateHash }),
      ...(result.templateScope === undefined ? {} : { templateScope: result.templateScope }),
      resourceTypes: [...result.resourceTypes],
      ...(result.resourceCount === undefined ? {} : { resourceCount: result.resourceCount }),
      ...(result.nestedDeploymentCount === undefined
        ? {}
        : { nestedDeploymentCount: result.nestedDeploymentCount }),
      parameterNames: [...result.parameterNames],
      secureParameterNames: [...result.secureParameterNames],
      outputNames: [...result.outputNames],
      warnings: [...result.warnings],
    };
  },
});

export const whatIfBicepTool = defineTool({
  name: 'azure_what_if_bicep',
  title: 'Preview a Bicep deployment',
  summary: 'Compile a Bicep bundle and ask Azure what deploying it would change.',
  description:
    'Compiles the bundle, checks it against the configured scope allow-lists, then runs an ARM ' +
    'what-if at the requested resource group, subscription, management group or tenant scope. ' +
    'Returns a bounded, normalised list of changes including deletions and results Azure could ' +
    'not evaluate, plus a confirmationHash that binds this exact source, parameters, scope, mode ' +
    'and preview together. Show the user the changes — especially deletions — and get explicit ' +
    'approval before deploying. The preview expires; if it does, run this again.',
  kind: 'read',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  routing: {
    useWhen: [
      'You are about to deploy Bicep and must show the user what will change.',
      'You want to know whether a template would delete or replace an existing resource.',
      'A previous confirmationHash expired or no longer matches.',
    ],
    doNotUseWhen: [
      'The template has not compiled yet — run azure_validate_bicep first to get clean diagnostics.',
      'You only want to inspect current state — use azure_search_resources or azure_get_resource.',
    ],
    requiredScope:
      'The deployment identity needs read access at the target scope, which must be inside the ' +
      'configured deployment allow-list.',
    changesState: false,
    prerequisites: ['azure_list_subscriptions', 'azure_validate_bicep'],
    nextSteps: ['azure_deploy_bicep'],
  },
  inputSchema: z
    .object({ bundle: bundleSchema, parameters, scope: scopeSchema })
    .strict()
    .describe('Caller-supplied Azure credentials or identities are not accepted and are rejected.'),
  outputSchema: previewSchema,
  handler: async (input, services, context) => {
    const result = await services.deployments.whatIf(
      { bundle: input.bundle, parameters: input.parameters, scope: input.scope },
      context.principal,
      context.requestId,
    );
    return toPreviewOutput(result);
  },
});

export const deployBicepTool = defineTool({
  name: 'azure_deploy_bicep',
  title: 'Deploy Bicep',
  summary: 'Apply a previously previewed and approved Bicep deployment (state-changing).',
  description:
    'Starts an ARM deployment in Incremental mode. It only proceeds when generic deployment is ' +
    'enabled, confirm is true, a reason is supplied, and the confirmationHash matches a recent ' +
    'azure_what_if_bicep preview over identical source, parameters, scope and mode. Any ' +
    'difference is refused so an approval can never be reused for a different change. The call ' +
    'returns as soon as Azure accepts the deployment: poll azure_get_deployment for progress ' +
    'rather than waiting. Complete mode is never used, so resources absent from the template are ' +
    'left alone.',
  kind: 'write',
  annotations: { destructiveHint: true, idempotentHint: false },
  routing: {
    useWhen: [
      'The user has seen the what-if output and explicitly approved it.',
      'You hold an unexpired confirmationHash for exactly the source and parameters you are sending.',
    ],
    doNotUseWhen: [
      'You have not previewed this exact template and parameter set — run azure_what_if_bicep.',
      'The user has not approved the change, or you are inferring approval.',
      'You only need to restart or tag something — use the constrained operation tools instead.',
    ],
    requiredScope:
      'The deployment identity needs write permission for every resource type in the template at ' +
      'the target scope. Role assignments additionally require privileged RBAC.',
    changesState: true,
    prerequisites: ['azure_what_if_bicep'],
    nextSteps: ['azure_get_deployment', 'azure_list_deployment_operations'],
  },
  inputSchema: z
    .object({
      bundle: bundleSchema,
      parameters,
      scope: scopeSchema,
      confirmationHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/, 'must be the confirmationHash from azure_what_if_bicep'),
      confirm: z
        .boolean()
        .default(false)
        .describe('Must be true, and must reflect an explicit human approval.'),
      reason: z
        .string()
        .min(1)
        .max(500)
        .describe('Why this deployment is being made. Recorded in the audit log.'),
    })
    .strict(),
  outputSchema: deployResultSchema,
  handler: async (input, services, context) => {
    const result = await services.deployments.deploy(
      {
        bundle: input.bundle,
        parameters: input.parameters,
        scope: input.scope,
        confirmationHash: input.confirmationHash,
        confirm: input.confirm,
        reason: input.reason,
      },
      context.principal,
      context.requestId,
    );
    return toDeployOutput(result);
  },
});

export const getDeploymentTool = defineTool({
  name: 'azure_get_deployment',
  title: 'Get deployment status',
  summary: 'Report the status, outputs and errors of an ARM deployment.',
  description:
    'Returns the current provisioning state, timestamps, correlation id, error and non-sensitive ' +
    'outputs of a deployment. Secure outputs and outputs whose names suggest secrets are ' +
    'reported by name only, never by value. Use it to verify that a deployment you started ' +
    'actually succeeded.',
  kind: 'read',
  routing: {
    useWhen: [
      'You started a deployment and need to know whether it finished.',
      'You need the outputs of a completed deployment.',
      'A deployment failed and you want the top-level error before drilling in.',
    ],
    doNotUseWhen: [
      'You need per-resource failure detail — use azure_list_deployment_operations.',
      'You want to know what a deployment would do — use azure_what_if_bicep.',
    ],
    requiredScope: 'Read access to the deployment scope with the deployment identity.',
    changesState: false,
    prerequisites: ['azure_deploy_bicep'],
    nextSteps: ['azure_list_deployment_operations'],
  },
  inputSchema: z.object(targetFields).strict(),
  outputSchema: z.object({
    recordId: z.string().optional(),
    deploymentId: z.string(),
    deploymentName: z.string(),
    scope: scopeOutputSchema,
    provisioningState: z.string(),
    correlationId: z.string().optional(),
    timestamp: z.string().optional(),
    duration: z.string().optional(),
    outputs: z.array(z.object({ name: z.string(), value: z.unknown().optional() })),
    redactedOutputNames: z.array(z.string()),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  handler: async (input, services, context) => {
    const result = await services.deployments.getDeployment(
      { recordId: input.recordId, scope: input.scope, deploymentName: input.deploymentName },
      context.principal,
    );
    return {
      ...(result.recordId === undefined ? {} : { recordId: result.recordId }),
      deploymentId: result.deploymentId,
      deploymentName: result.deploymentName,
      scope: toScopeOutput(result.scope),
      provisioningState: result.provisioningState,
      ...(result.correlationId === undefined ? {} : { correlationId: result.correlationId }),
      ...(result.timestamp === undefined ? {} : { timestamp: result.timestamp }),
      ...(result.duration === undefined ? {} : { duration: result.duration }),
      outputs: result.outputs.map((output) => ({ name: output.name, value: output.value })),
      redactedOutputNames: [...result.redactedOutputNames],
      ...(result.error === undefined
        ? {}
        : { error: { code: result.error.code, message: result.error.message } }),
    };
  },
});

export const listDeploymentOperationsTool = defineTool({
  name: 'azure_list_deployment_operations',
  title: 'List deployment operations',
  summary: 'List the per-resource operations of an ARM deployment, paginated.',
  description:
    'Returns the individual resource operations ARM performed for a deployment, with status codes ' +
    'and messages. This is how you find which specific resource failed and why, when ' +
    'azure_get_deployment only tells you the deployment failed.',
  kind: 'read',
  routing: {
    useWhen: [
      'A deployment failed and you need the specific resource and error responsible.',
      'You want to see the order and timing of resource operations.',
    ],
    doNotUseWhen: [
      'You only need the overall result — azure_get_deployment is cheaper.',
      'The deployment has not started yet.',
    ],
    requiredScope: 'Read access to the deployment scope with the deployment identity.',
    changesState: false,
    prerequisites: ['azure_get_deployment'],
  },
  inputSchema: z
    .object({
      ...targetFields,
      limit: z.number().int().min(1).max(500).default(50),
      skipToken: z.string().max(8192).optional(),
    })
    .strict(),
  outputSchema: z.object({
    recordId: z.string().optional(),
    deploymentName: z.string(),
    operations: z.array(
      z.object({
        operationId: z.string(),
        provisioningState: z.string().optional(),
        timestamp: z.string().optional(),
        duration: z.string().optional(),
        resourceType: z.string().optional(),
        resourceName: z.string().optional(),
        targetResourceId: z.string().optional(),
        statusCode: z.string().optional(),
        statusMessage: z.string().optional(),
      }),
    ),
    skipToken: z.string().optional(),
  }),
  handler: async (input, services, context) => {
    const result = await services.deployments.listOperations(
      {
        recordId: input.recordId,
        scope: input.scope,
        deploymentName: input.deploymentName,
        limit: input.limit,
        skipToken: input.skipToken,
      },
      context.principal,
    );
    return {
      ...(result.recordId === undefined ? {} : { recordId: result.recordId }),
      deploymentName: result.deploymentName,
      operations: result.operations.map((operation) => ({
        operationId: operation.operationId,
        ...(operation.provisioningState === undefined
          ? {}
          : { provisioningState: operation.provisioningState }),
        ...(operation.timestamp === undefined ? {} : { timestamp: operation.timestamp }),
        ...(operation.duration === undefined ? {} : { duration: operation.duration }),
        ...(operation.resourceType === undefined ? {} : { resourceType: operation.resourceType }),
        ...(operation.resourceName === undefined ? {} : { resourceName: operation.resourceName }),
        ...(operation.targetResourceId === undefined
          ? {}
          : { targetResourceId: operation.targetResourceId }),
        ...(operation.statusCode === undefined ? {} : { statusCode: operation.statusCode }),
        ...(operation.statusMessage === undefined
          ? {}
          : { statusMessage: operation.statusMessage }),
      })),
      ...(result.skipToken === undefined ? {} : { skipToken: result.skipToken }),
    };
  },
});

export const rollbackDeploymentTool = defineTool({
  name: 'azure_rollback_deployment',
  title: 'Roll back to a previous deployment',
  summary: 'Preview and redeploy a previously successful template (state-changing).',
  description:
    'Redeploys the template and parameters of an earlier successful deployment. This is a forward ' +
    'deployment, not an undo: ARM does not restore state, so resources deleted since, data ' +
    'written since, and changes made outside this server are NOT reverted. Call it first without ' +
    'confirm to obtain a fresh what-if preview and a new confirmationHash, show the user what ' +
    'redeploying would change, and only then call again with confirm=true and that hash. Secure ' +
    'parameters were never stored, so their values must be supplied again.',
  kind: 'write',
  annotations: { destructiveHint: true, idempotentHint: false },
  routing: {
    useWhen: [
      'A deployment made things worse and the user asked to return to the previous template.',
      'You need to see what redeploying an earlier revision would change.',
    ],
    doNotUseWhen: [
      'You expect deleted resources or lost data to come back — they will not.',
      'The earlier deployment did not succeed, or its record no longer exists.',
      'A forward fix is simpler and safer — use azure_what_if_bicep with corrected source.',
    ],
    requiredScope: 'Same write permissions as azure_deploy_bicep at the original scope.',
    changesState: true,
    prerequisites: ['azure_get_deployment'],
    nextSteps: ['azure_get_deployment'],
  },
  inputSchema: z
    .object({
      recordId: z.string().min(1).max(200).describe('Record id of the successful deployment.'),
      confirm: z.boolean().default(false),
      confirmationHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional()
        .describe('From the rollback preview. Required together with confirm=true.'),
      reason: z.string().max(500).default(''),
      secureParameters: z
        .record(z.string().min(1).max(200), z.string().max(4096))
        .optional()
        .describe('Values for parameters the original template declared secure.'),
    })
    .strict(),
  outputSchema: z.object({
    phase: z.enum(['preview', 'deployed']),
    rollbackOf: z.string(),
    preview: previewSchema.optional(),
    result: deployResultSchema.optional(),
  }),
  handler: async (input, services, context) => {
    const outcome = await services.deployments.rollback(
      {
        recordId: input.recordId,
        confirm: input.confirm,
        reason: input.reason,
        confirmationHash: input.confirmationHash,
        secureParameters: input.secureParameters,
      },
      context.principal,
      context.requestId,
    );

    return outcome.phase === 'preview'
      ? {
          phase: 'preview' as const,
          rollbackOf: outcome.rollbackOf,
          preview: toPreviewOutput(outcome.preview),
        }
      : {
          phase: 'deployed' as const,
          rollbackOf: outcome.rollbackOf,
          result: toDeployOutput(outcome.result),
        };
  },
});

/* ----------------------------------------------------------------- mapping */

type ScopeOutput = z.output<typeof scopeOutputSchema>;
type PreviewOutput = z.output<typeof previewSchema>;
type DeployOutput = z.output<typeof deployResultSchema>;

const toScopeOutput = (scope: DeploymentScope): ScopeOutput => ({
  kind: scope.kind,
  ...(scope.subscriptionId === undefined ? {} : { subscriptionId: scope.subscriptionId }),
  ...(scope.resourceGroup === undefined ? {} : { resourceGroup: scope.resourceGroup }),
  ...(scope.managementGroupId === undefined ? {} : { managementGroupId: scope.managementGroupId }),
  ...(scope.location === undefined ? {} : { location: scope.location }),
  armScope: scope.armScope,
});

const toPreviewOutput = (result: WhatIfResult): PreviewOutput => ({
  previewId: result.previewId,
  confirmationHash: result.confirmationHash,
  expiresAt: result.expiresAt,
  scope: toScopeOutput(result.scope),
  mode: result.mode,
  sourceHash: result.sourceHash,
  templateHash: result.templateHash,
  summary: {
    totalChanges: result.summary.totalChanges,
    countsByChangeType: { ...result.summary.countsByChangeType },
    deletes: [...result.summary.deletes],
    unsupported: [...result.summary.unsupported],
    truncated: result.summary.truncated,
  },
  changes: result.changes.map((change) => ({
    changeType: change.changeType,
    resourceId: change.resourceId,
    resourceType: change.resourceType,
    propertyChanges: change.propertyChanges.map((property) => ({ ...property })),
    propertyChangesTruncated: change.propertyChangesTruncated,
    ...(change.unsupportedReason === undefined
      ? {}
      : { unsupportedReason: change.unsupportedReason }),
  })),
  diagnostics: result.diagnostics.map((diagnostic) => ({
    level: diagnostic.level,
    message: diagnostic.message,
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
    ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
    ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
    ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
  })),
  warnings: result.warnings.map((warning) => ({ ...warning })),
  resourceTypes: [...result.resourceTypes],
  secureParameterNames: [...result.secureParameterNames],
});

const toDeployOutput = (result: DeployResult): DeployOutput => ({
  recordId: result.recordId,
  deploymentId: result.deploymentId,
  deploymentName: result.deploymentName,
  status: result.status,
  scope: toScopeOutput(result.scope),
  confirmationHash: result.confirmationHash,
  templateHash: result.templateHash,
  ...(result.correlationId === undefined ? {} : { correlationId: result.correlationId }),
  startedAt: result.startedAt,
  alreadyStarted: result.alreadyStarted,
  message: result.message,
});
