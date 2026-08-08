import type { FastifyInstance } from 'fastify';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Logger } from 'pino';

/**
 * Fastify instance type for this application. Pinning the logger generic keeps every module that
 * touches the server in agreement about the concrete pino logger being used.
 */
export type HttpServer = FastifyInstance<
  Server<typeof IncomingMessage, typeof ServerResponse>,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;
