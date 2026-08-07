import type { AppConfig } from '../config/index.js';
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

const errorResponses: JsonObject = {
  '400': { description: 'Invalid input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '401': { description: 'Missing or invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '403': { description: 'Outside the connector allow-list, or mutations disabled', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '404': { description: 'Unknown tool or resource', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '429': { description: 'Rate limited', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '500': { description: 'Connector failure', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '502': { description: 'Azure upstream failure', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
};

const toolPath = (tool: RegisteredTool): JsonObject => ({
  post: {
    operationId: tool.name,
    summary: tool.summary,
    description:
      tool.kind === 'write'
        ? `${tool.description}\n\nThis operation changes Azure state. Always call it with dryRun=true first and obtain explicit user confirmation before setting confirm=true.`
        : tool.description,
    tags: [tool.kind === 'write' ? 'operations' : 'read'],
    'x-openai-isConsequential': tool.kind === 'write',
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
    '/version': {
      get: {
        operationId: 'version',
        summary: 'Build and capability information.',
        security: [],
        responses: {
          '200': {
            description: 'Version and capability metadata',
            content: { 'application/json': { schema: { type: 'object' } } },
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
            content: { 'application/json': { schema: { type: 'object' } } },
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
      title: 'ChatGPT Azure Connector',
      version: config.service.version,
      description:
        'Backend connector that lets ChatGPT inspect, diagnose and perform a constrained set of ' +
        'operational actions against an Azure environment. All access is scoped by the ' +
        "connector's subscription and resource group allow-lists, and every state-changing " +
        'action is gated behind explicit confirmation.',
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
