import { badRequest } from '../errors.js';
import { hashJson } from './hash.js';

export type TemplateScopeKind = 'resourceGroup' | 'subscription' | 'managementGroup' | 'tenant';

export interface InspectionLimits {
  readonly maxResources: number;
  readonly maxDepth: number;
  readonly maxNestedDeployments: number;
  readonly maxTemplateBytes: number;
  /** Extra resource types an operator has chosen to deny, lower-cased. */
  readonly deniedResourceTypes: readonly string[];
}

/**
 * Resource types that can execute code or reach the network during a deployment. These are always
 * refused: allowing them would turn "deploy a template" into "run arbitrary code in the target
 * subscription", which is precisely the capability this server exists to withhold.
 */
export const ALWAYS_DENIED_RESOURCE_TYPES = ['microsoft.resources/deploymentscripts'] as const;

export const DEFAULT_DENIED_RESOURCE_TYPES = [
  'microsoft.compute/virtualmachines/extensions',
  'microsoft.compute/virtualmachinescalesets/extensions',
  'microsoft.hybridcompute/machines/extensions',
  'microsoft.connectedvmwarevsphere/virtualmachines/extensions',
] as const;

/**
 * Property names that name an external artefact: another template, a parameter file, a script or
 * a content package. Every one of them is a way to make the deployment execute or include
 * something the server never inspected.
 */
const EXTERNAL_REFERENCE_KEYS = new Set([
  'templatelink',
  'parameterslink',
  'primaryscripturi',
  'supportingscripturis',
  'contentlink',
  'contenturi',
  'scripturi',
  'packageuri',
  'fileuris',
  'commandtoexecute',
]);

/** Types that grant or change authority. Permitted, but always surfaced to the operator. */
const PRIVILEGED_TYPES = new Set([
  'microsoft.authorization/roleassignments',
  'microsoft.authorization/roledefinitions',
  'microsoft.authorization/policyassignments',
  'microsoft.keyvault/vaults/accesspolicies',
  'microsoft.managedidentity/userassignedidentities/federatedidentitycredentials',
]);

const SCHEMA_SCOPES: readonly (readonly [string, TemplateScopeKind])[] = [
  ['subscriptiondeploymenttemplate.json', 'subscription'],
  ['managementgroupdeploymenttemplate.json', 'managementGroup'],
  ['tenantdeploymenttemplate.json', 'tenant'],
  ['deploymenttemplate.json', 'resourceGroup'],
];

export const DEFAULT_INSPECTION_LIMITS: InspectionLimits = {
  maxResources: 500,
  maxDepth: 12,
  maxNestedDeployments: 32,
  maxTemplateBytes: 4 * 1024 * 1024,
  deniedResourceTypes: [...DEFAULT_DENIED_RESOURCE_TYPES],
};

export interface InspectionWarning {
  readonly code: string;
  readonly message: string;
}

export interface CrossScopeTarget {
  readonly subscriptionId: string | undefined;
  readonly resourceGroup: string | undefined;
  readonly managementGroupId: string | undefined;
}

export interface TemplateInspection {
  readonly templateScope: TemplateScopeKind;
  readonly templateHash: string;
  readonly resourceTypes: readonly string[];
  readonly resourceCount: number;
  readonly nestedDeploymentCount: number;
  readonly crossScopeTargets: readonly CrossScopeTarget[];
  readonly parameterNames: readonly string[];
  readonly secureParameterNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly warnings: readonly InspectionWarning[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const scopeFromSchema = (schema: unknown): TemplateScopeKind => {
  const value = asString(schema)?.toLowerCase();
  if (!value) {
    throw badRequest('The compiled template has no $schema and its scope cannot be determined');
  }
  for (const [needle, scope] of SCHEMA_SCOPES) {
    if (value.includes(needle)) return scope;
  }
  throw badRequest('The compiled template targets an unsupported deployment scope', {
    schema: value.slice(0, 200),
  });
};

/** Depth-limited search for external-artefact keys anywhere beneath a node. */
const assertNoExternalReferences = (
  node: unknown,
  path: string,
  limits: InspectionLimits,
): void => {
  const walk = (current: unknown, currentPath: string, depth: number): void => {
    if (depth > limits.maxDepth) {
      throw badRequest(
        `The template nests deeper than ${limits.maxDepth} levels at ${currentPath} and cannot ` +
          'be safely inspected',
      );
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => walk(entry, `${currentPath}[${index}]`, depth + 1));
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, value] of Object.entries(current)) {
      if (EXTERNAL_REFERENCE_KEYS.has(key.toLowerCase())) {
        throw badRequest(
          `The template references external content through "${key}" at ${currentPath}. Linked ` +
            'templates, parameter files, scripts and content URLs are not permitted; inline the ' +
            'content in the bundle instead.',
        );
      }
      walk(value, `${currentPath}.${key}`, depth + 1);
    }
  };
  walk(node, path, 0);
};

interface WalkState {
  readonly types: Set<string>;
  readonly crossScope: CrossScopeTarget[];
  readonly warnings: InspectionWarning[];
  resourceCount: number;
  nestedDeployments: number;
}

const resourceEntries = (resources: unknown, path: string): readonly Record<string, unknown>[] => {
  if (resources === undefined) return [];
  // Bicep emits either the classic array form or the symbolic-name object form.
  const list = Array.isArray(resources)
    ? resources
    : isRecord(resources)
      ? Object.values(resources)
      : undefined;
  if (list === undefined) {
    throw badRequest(`The template has a "${path}" section that is neither an array nor an object`);
  }
  return list.map((entry, index) => {
    if (!isRecord(entry)) {
      throw badRequest(`Resource ${path}[${index}] is not an object and cannot be inspected`);
    }
    return entry;
  });
};

const walkResources = (
  resources: unknown,
  path: string,
  depth: number,
  limits: InspectionLimits,
  state: WalkState,
): void => {
  if (depth > limits.maxDepth) {
    throw badRequest(
      `Nested deployments exceed the maximum inspection depth of ${limits.maxDepth}`,
    );
  }

  for (const [index, resource] of resourceEntries(resources, path).entries()) {
    state.resourceCount += 1;
    if (state.resourceCount > limits.maxResources) {
      throw badRequest(`The template declares more than ${limits.maxResources} resources`);
    }

    const type = asString(resource['type']);
    if (!type) {
      throw badRequest(`Resource ${path}[${index}] has no type and cannot be inspected`);
    }
    const normalizedType = type.toLowerCase();
    state.types.add(normalizedType);

    if (ALWAYS_DENIED_RESOURCE_TYPES.includes(normalizedType as never)) {
      throw badRequest(
        `Resource type ${type} executes arbitrary code during deployment and is never permitted.`,
      );
    }
    if (limits.deniedResourceTypes.includes(normalizedType)) {
      throw badRequest(
        `Resource type ${type} is not permitted by this server's deployment policy.`,
      );
    }
    if (PRIVILEGED_TYPES.has(normalizedType)) {
      state.warnings.push({
        code: 'privileged_resource_type',
        message:
          `${type} changes authorisation. The deployment identity needs privileged RBAC ` +
          '(such as Role Based Access Control Administrator) for this to succeed.',
      });
    }

    const subscriptionId = asString(resource['subscriptionId']);
    const resourceGroup = asString(resource['resourceGroup']);
    const managementGroupId = asString(resource['managementGroupId']);
    const scope = asString(resource['scope']);
    if (subscriptionId ?? resourceGroup ?? managementGroupId) {
      state.crossScope.push({ subscriptionId, resourceGroup, managementGroupId });
    }
    if (scope !== undefined) {
      state.warnings.push({
        code: 'extension_scope',
        message: `Resource ${type} is deployed at an explicit scope; verify it stays inside the allow-list.`,
      });
    }

    if (normalizedType === 'microsoft.resources/deployments') {
      state.nestedDeployments += 1;
      if (state.nestedDeployments > limits.maxNestedDeployments) {
        throw badRequest(
          `The template contains more than ${limits.maxNestedDeployments} nested deployments`,
        );
      }
      const properties = resource['properties'];
      if (!isRecord(properties)) {
        throw badRequest(`Nested deployment ${path}[${index}] has no inspectable properties`);
      }
      const nested = properties['template'];
      if (!isRecord(nested)) {
        throw badRequest(
          `Nested deployment ${path}[${index}] does not carry an inline template. Only inline ` +
            'nested templates can be inspected, so linked deployments are refused.',
        );
      }
      const mode = asString(properties['mode'])?.toLowerCase();
      if (mode === 'complete') {
        throw badRequest(
          `Nested deployment ${path}[${index}] uses Complete mode, which deletes resources that ` +
            'are absent from the template. Only Incremental mode is supported.',
        );
      }
      walkResources(
        nested['resources'],
        `${path}[${index}].properties.template.resources`,
        depth + 1,
        limits,
        state,
      );
    }
  }
};

/**
 * Inspects compiled ARM JSON before it is ever sent to Azure.
 *
 * Anything that cannot be bounded or understood is rejected rather than passed through: an
 * un-inspectable template is indistinguishable from a hostile one.
 */
export const inspectTemplate = (
  template: unknown,
  limits: InspectionLimits = DEFAULT_INSPECTION_LIMITS,
): TemplateInspection => {
  if (!isRecord(template)) throw badRequest('The compiled template is not a JSON object');

  const serialized = JSON.stringify(template);
  if (serialized.length > limits.maxTemplateBytes) {
    throw badRequest(`The compiled template exceeds ${limits.maxTemplateBytes} bytes`);
  }

  assertNoExternalReferences(template, 'template', limits);

  const state: WalkState = {
    types: new Set<string>(),
    crossScope: [],
    warnings: [],
    resourceCount: 0,
    nestedDeployments: 0,
  };
  walkResources(template['resources'], 'resources', 0, limits, state);

  const parameters = isRecord(template['parameters']) ? template['parameters'] : {};
  const secureParameterNames = Object.entries(parameters)
    .filter(([, definition]) => {
      const type = isRecord(definition) ? asString(definition['type'])?.toLowerCase() : undefined;
      return type === 'securestring' || type === 'secureobject';
    })
    .map(([name]) => name)
    .sort();

  const outputs = isRecord(template['outputs']) ? template['outputs'] : {};

  return {
    templateScope: scopeFromSchema(template['$schema']),
    templateHash: hashJson(template),
    resourceTypes: [...state.types].sort(),
    resourceCount: state.resourceCount,
    nestedDeploymentCount: state.nestedDeployments,
    crossScopeTargets: state.crossScope,
    parameterNames: Object.keys(parameters).sort(),
    secureParameterNames,
    outputNames: Object.keys(outputs).sort(),
    warnings: state.warnings,
  };
};
