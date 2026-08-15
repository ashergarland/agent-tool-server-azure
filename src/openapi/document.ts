import type { AppConfig } from '../config/index.js';
import { SERVER_INSTRUCTIONS } from '../tools/instructions.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';

type JsonObject = Record<string, unknown>;

const errorSchema: JsonObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        retryable: { type: 'boolean' },
        requestId: { type: 'string' },
      },
    },
  },
};

const versionSchema: JsonObject = {
  type: 'object',
  required: ['service', 'version', 'node', 'environment', 'capabilities'],
  properties: {
    service: { type: 'string' },
    version: { type: 'string' },
    gitSha: { type: 'string' },
    node: { type: 'string' },
    environment: { type: 'string' },
    capabilities: {
      type: 'object',
      required: ['mutationsEnabled', 'confirmationRequired', 'authMode', 'scopedSubscriptions'],
      properties: {
        mutationsEnabled: { type: 'boolean' },
        confirmationRequired: { type: 'boolean' },
        authMode: { type: 'string' },
        scopedSubscriptions: { type: 'integer' },
      },
    },
  },
};

const toolCatalogueSchema: JsonObject = {
  type: 'object',
  required: ['tools', 'instructions'],
  properties: {
    instructions: { type: 'string' },
    tools: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'title', 'summary', 'description', 'kind'],
        properties: {
          name: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          description: { type: 'string' },
          kind: { type: 'string' },
          annotations: { type: 'object', additionalProperties: true },
          routing: { type: 'object', additionalProperties: true },
          inputSchema: { type: 'object', additionalProperties: true },
          outputSchema: { type: 'object', additionalProperties: true },
        },
      },
    },
  },
};

const readinessSchema: JsonObject = {
  type: 'object',
  required: ['ready', 'service', 'components', 'capabilities'],
  properties: {
    ready: { type: 'boolean' },
    service: { type: 'string' },
    version: { type: 'string' },
    gitSha: { type: 'string' },
    environment: { type: 'string' },
    checkedAt: { type: 'string' },
    components: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['state'],
        properties: { state: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    capabilities: { type: 'object', additionalProperties: true },
  },
};

const errorResponses: JsonObject = {
  '400': {
    description: 'Invalid input',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '401': {
    description: 'Missing or invalid credentials',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '403': {
    description: 'Outside the connector allow-list, or mutations disabled',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '404': {
    description: 'Unknown tool or resource',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '429': {
    description: 'Rate limited',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '500': {
    description: 'Connector failure',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '502': {
    description: 'Azure upstream failure',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
};

const toolPath = (tool: RegisteredTool): JsonObject => ({
  post: {
    operationId: tool.name,
    summary: tool.summary,
    description:
      tool.kind === 'write'
        ? `${tool.description}\n\nThis operation changes Azure state. Always preview first (dryRun=true, or azure_what_if_bicep for deployments) and obtain explicit user confirmation before setting confirm=true.`
        : tool.description,
    tags: [tool.kind === 'write' ? 'operations' : 'read'],
    'x-openai-isConsequential': tool.kind === 'write',
    'x-tool-annotations': {
      readOnlyHint: tool.annotations.readOnlyHint,
      destructiveHint: tool.annotations.destructiveHint,
      idempotentHint: tool.annotations.idempotentHint,
      openWorldHint: tool.annotations.openWorldHint,
    },
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tool.inputJsonSchema } },
    },
    responses: {
      '200': {
        description: 'Tool result',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tool', 'requestId', 'result'],
              properties: {
                tool: { type: 'string' },
                requestId: { type: 'string' },
                result: tool.outputJsonSchema,
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  },
});

/**
 * Emits the OpenAPI 3.1 document that ChatGPT consumes to discover the connector's actions.
 * Every tool in the registry becomes exactly one POST operation, so the HTTP surface and the tool
 * surface can never drift apart.
 */
export const buildOpenApiDocument = (config: AppConfig, registry: ToolRegistry): JsonObject => {
  const paths: JsonObject = {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe.',
        security: [],
        responses: {
          '200': {
            description: 'Service is alive',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'service', 'uptimeSeconds'],
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    service: { type: 'string' },
                    uptimeSeconds: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/ready': {
      get: {
        operationId: 'ready',
        summary: 'Readiness probe: can the server actually do its job?',
        security: [],
        responses: {
          '200': {
            description: 'Every required component is usable',
            content: { 'application/json': { schema: readinessSchema } },
          },
          '503': {
            description: 'At least one required component is unavailable',
            content: { 'application/json': { schema: readinessSchema } },
          },
        },
      },
    },
    '/version': {
      get: {
        operationId: 'version',
        summary: 'Build and capability information.',
        security: [],
        responses: {
          '200': {
            description: 'Version and capability metadata',
            content: { 'application/json': { schema: versionSchema } },
          },
        },
      },
    },
    '/tools': {
      get: {
        operationId: 'listTools',
        summary: 'List the tools exposed by this connector.',
        responses: {
          '200': {
            description: 'Tool catalogue',
            content: { 'application/json': { schema: toolCatalogueSchema } },
          },
          ...errorResponses,
        },
      },
    },
  };

  for (const tool of registry.list()) {
    paths[`/tools/${tool.name}`] = toolPath(tool);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Agent Tool Server for Azure',
      version: config.service.version,
      description:
        'Backend tool server that lets an agent inspect, diagnose, operate and deploy to an Azure ' +
        'environment through a constrained control plane. All access is scoped by the configured ' +
        'subscription, resource group and management group allow-lists; every state-changing ' +
        'action is gated behind an explicit preview and confirmation; and no shell, arbitrary ' +
        'REST call or script execution is exposed.\n\n' +
        SERVER_INSTRUCTIONS,
    },
    servers: [{ url: config.service.publicBaseUrl ?? `http://localhost:${config.http.port}` }],
    security: config.auth.mode === 'disabled' ? [] : [{ bearerAuth: [] }],
    components: {
      schemas: { Error: errorSchema },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            config.auth.mode === 'entra-jwt'
              ? 'Microsoft Entra ID access token issued for the connector audience.'
              : 'Static connector API key.',
        },
      },
    },
    paths,
    tags: [
      { name: 'read', description: 'Read-only inspection and diagnostics.' },
      { name: 'operations', description: 'Constrained, confirmation-gated state changes.' },
    ],
  };
};
