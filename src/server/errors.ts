import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HttpServer } from './types.js';
import { AppError, toAppError } from '../errors.js';

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly retryable: boolean;
    readonly requestId: string;
  };
}

export const toErrorBody = (error: AppError, requestId: string): ErrorBody => ({
  error: {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    retryable: error.retryable,
    requestId,
  },
});

/**
 * Single place where any thrown value becomes an HTTP response. Internal errors never leak their
 * message to the caller in production, but are always logged with the request id.
 *
 * Whether this is production is taken from the validated configuration rather than from
 * `process.env` at throw time: the process environment can be mutated after startup, and the
 * decision to withhold an error message is not one that should depend on a mutable global.
 */
export const registerErrorHandler = (app: HttpServer, isProduction: boolean): void => {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const error = new AppError('not_found', `No route for ${request.method} ${request.url}`);
    void reply.status(error.status).send(toErrorBody(error, request.id));
  });

  app.setErrorHandler((rawError: unknown, request, reply) => {
    const statusCode = (rawError as { statusCode?: unknown }).statusCode;
    const validationStatus = typeof statusCode === 'number' ? statusCode : undefined;

    let error: AppError;
    if (rawError instanceof AppError) {
      error = rawError;
    } else if (validationStatus === 400) {
      error = new AppError(
        'bad_request',
        rawError instanceof Error ? rawError.message : 'Invalid request',
      );
    } else if (validationStatus === 413) {
      error = new AppError('bad_request', 'Request payload is too large');
    } else if (validationStatus === 429) {
      error = new AppError('rate_limited', 'Too many requests');
    } else {
      error = toAppError(rawError);
    }

    const logPayload = { err: rawError, code: error.code, requestId: request.id };
    if (error.status >= 500) request.log.error(logPayload, error.message);
    else request.log.warn(logPayload, error.message);

    const exposed =
      error.status >= 500 && isProduction
        ? new AppError(error.code, 'The server failed to complete the request')
        : error;

    void reply.status(error.status).send(toErrorBody(exposed, request.id));
  });
};
