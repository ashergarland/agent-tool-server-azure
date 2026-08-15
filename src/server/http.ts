import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';
import { handleMcpHttpRequest } from '../mcp/http.js';
import { buildOpenApiDocument } from '../openapi/document.js';
import type { Services } from '../services/index.js';
import { SERVER_INSTRUCTIONS } from '../tools/instructions.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createAuthenticator, type Principal } from './auth.js';
import { registerErrorHandler } from './errors.js';
import { FixedWindowRateLimiter, type RateLimitDecision } from './rate-limit.js';
import { buildReadinessReport } from './ready.js';
import type { HttpServer } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface HttpServerDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
}

/** Every path that requires an authenticated, rate-limited principal. */
const isGuarded = (url: string): boolean =>
  url.startsWith('/tools') || url.startsWith('/mcp') || url.startsWith('/metrics');

export const createHttpServer = (deps: HttpServerDeps): HttpServer => {
  const { config, logger, services, registry } = deps;
  const startedAt = Date.now();

  const app = Fastify({
    loggerInstance: logger,
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      return typeof header === 'string' && header.length > 0 && header.length <= 200
        ? header
        : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: config.http.maxBodyBytes,
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  const authenticator = createAuthenticator(config);
  const limiter = new FixedWindowRateLimiter(
    config.http.rateLimit.max,
    config.http.rateLimit.windowMs,
  );
  /**
   * Applied before authentication so that an unauthenticated flood cannot force the server to
   * perform an unbounded number of credential verifications. Deliberately more generous than the
   * per-principal limit, since a single caller may legitimately sit behind one address.
   */
  const preAuthLimiter = new FixedWindowRateLimiter(
    config.http.rateLimit.max > 0 ? config.http.rateLimit.max * 2 : 0,
    config.http.rateLimit.windowMs,
  );

  const rateLimitExceeded = (reply: FastifyReply, decision: RateLimitDecision): AppError => {
    void reply.header('retry-after', String(Math.ceil((decision.resetAtMs - Date.now()) / 1000)));
    services.metrics.increment('rate_limited_total');
    return new AppError('rate_limited', 'Too many requests; slow down and retry.');
  };

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  /** Authentication + rate limiting for every guarded route. */
  // codeql[js/missing-rate-limiting]
  app.addHook('onRequest', async (request, reply) => {
    if (!isGuarded(request.url)) return;

    const preAuth = preAuthLimiter.consume(`ip:${request.ip}`);
    if (!preAuth.allowed) throw rateLimitExceeded(reply, preAuth);

    const principal = await authenticator.authenticate(request);
    request.principal = principal;
    services.metrics.increment('auth_total', { mode: principal.kind });

    const decision = limiter.consume(principal.id);
    void reply.header('x-ratelimit-remaining', String(decision.remaining));
    if (!decision.allowed) throw rateLimitExceeded(reply, decision);
  });

  registerErrorHandler(app, config.isProduction);

  app.get('/health', () => ({
    status: 'ok' as const,
    service: config.service.name,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  app.get('/ready', async (_request, reply) => {
    const report = await buildReadinessReport(config, registry, services);
    void reply.status(report.ready ? 200 : 503);
    return report;
  });

  app.get('/version', () => ({
    service: config.service.name,
    version: config.service.version,
    gitSha: config.service.gitSha,
    node: process.version,
    environment: config.env,
    capabilities: {
      mutationsEnabled: config.guardrails.mutationsEnabled,
      confirmationRequired: config.guardrails.confirmationRequired,
      deploymentsEnabled: config.deployments.enabled,
      mcpHttpEnabled: config.mcp.httpEnabled,
      authMode: config.auth.mode,
      scopedSubscriptions: config.azure.allowedSubscriptionIds.length,
    },
  }));

  const openApiDocument = buildOpenApiDocument(config, registry);
  app.get('/openapi.json', () => openApiDocument);

  app.get('/metrics', () => services.metrics.snapshot());

  app.get('/tools', () => ({
    instructions: SERVER_INSTRUCTIONS,
    tools: registry.list().map((tool) => ({
      name: tool.name,
      title: tool.title,
      summary: tool.summary,
      description: tool.description,
      kind: tool.kind,
      annotations: tool.annotations,
      routing: tool.routing,
      inputSchema: tool.inputJsonSchema,
      outputSchema: tool.outputJsonSchema,
    })),
  }));

  app.post<{ Params: { toolName: string }; Body: unknown }>('/tools/:toolName', async (request) => {
    const { toolName } = request.params;
    const principal = request.principal ?? { id: 'anonymous', kind: 'anonymous' as const };
    const tool = registry.get(toolName);
    const startedAtMs = Date.now();

    request.log.info(
      { event: 'tool.invoke', tool: toolName, kind: tool.kind, principal: principal.id },
      'tool invocation started',
    );

    const body = request.body;
    const input =
      body === undefined || body === null
        ? {}
        : typeof body === 'object' && 'input' in (body as Record<string, unknown>)
          ? (body as { input: unknown }).input
          : body;

    try {
      const result = await tool.invoke(input, services, {
        requestId: request.id,
        principal: principal.id,
        transport: 'http',
        signal: toAbortSignal(request),
      });

      const durationMs = Date.now() - startedAtMs;
      services.metrics.observe('tool_invocation_ms', durationMs, {
        tool: toolName,
        outcome: 'success',
      });
      services.metrics.increment('tool_invocations_total', { tool: toolName, outcome: 'success' });
      request.log.info(
        { event: 'tool.result', tool: toolName, principal: principal.id, durationMs },
        'tool invocation succeeded',
      );

      return { tool: toolName, requestId: request.id, result };
    } catch (error) {
      services.metrics.observe('tool_invocation_ms', Date.now() - startedAtMs, {
        tool: toolName,
        outcome: 'failure',
      });
      services.metrics.increment('tool_invocations_total', { tool: toolName, outcome: 'failure' });
      throw error;
    }
  });

  if (config.mcp.httpEnabled) {
    const mcp = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      await handleMcpHttpRequest({ config, registry, services }, request, reply);
    };
    app.post('/mcp', mcp);
    app.get('/mcp', mcp);
    app.delete('/mcp', mcp);
  }

  return app;
};

/** Cancels in-flight Azure work when the caller disconnects. */
const toAbortSignal = (request: FastifyRequest): AbortSignal => {
  const controller = new AbortController();
  request.raw.once('close', () => {
    if (!request.raw.complete || request.raw.destroyed) controller.abort();
  });
  return controller.signal;
};
