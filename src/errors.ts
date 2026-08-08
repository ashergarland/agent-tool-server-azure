/**
 * Transport-agnostic error taxonomy. Every layer below the transport throws one of these so that
 * HTTP and MCP adapters can map failures consistently without leaking provider internals.
 */
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_error'
  | 'timeout'
  | 'internal_error';

const statusByCode: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream_error: 502,
  timeout: 504,
  internal_error: 500,
};

export interface AppErrorOptions {
  readonly details?: unknown;
  readonly cause?: unknown;
  readonly retryable?: boolean;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly status: number;
  public readonly details: unknown;
  public readonly retryable: boolean;

  public constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = statusByCode[code];
    this.details = options.details;
    this.retryable = options.retryable ?? (code === 'upstream_error' || code === 'timeout');
  }

  public toJSON(): { code: ErrorCode; message: string; details?: unknown; retryable: boolean } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      retryable: this.retryable,
    };
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError('bad_request', message, { details });

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError('unauthorized', message);

export const forbidden = (message: string, details?: unknown): AppError =>
  new AppError('forbidden', message, { details });

export const notFound = (message: string, details?: unknown): AppError =>
  new AppError('not_found', message, { details });

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError('conflict', message, { details });

export const internalError = (message: string, cause?: unknown): AppError =>
  new AppError('internal_error', message, { cause });

export const isAppError = (error: unknown): error is AppError => error instanceof AppError;

export const toAppError = (error: unknown): AppError => {
  if (isAppError(error)) return error;
  if (error instanceof Error) return internalError(error.message, error);
  return internalError('Unexpected error', error);
};
