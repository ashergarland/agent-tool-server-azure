import { AppError, type ErrorCode } from '@agent-tool-platform/runtime/errors';

interface RestErrorish {
  statusCode?: number;
  code?: string;
  message?: string;
  name?: string;
  details?: { error?: { code?: string; message?: string } };
}

const asRestError = (error: unknown): RestErrorish =>
  typeof error === 'object' && error !== null ? error : {};

/**
 * Translate Azure SDK / ARM failures into the connector's transport-agnostic error taxonomy.
 * Provider-specific status codes never escape this module.
 */
export const mapAzureError = (error: unknown, context: string): AppError => {
  if (error instanceof AppError) return error;

  const rest = asRestError(error);
  const status = rest.statusCode;
  const azureCode = rest.details?.error?.code ?? rest.code;
  const azureMessage = rest.details?.error?.message ?? rest.message ?? 'Azure request failed';
  const details = { context, azureCode, status };
  const mapped = (code: ErrorCode, message: string, retryable?: boolean): AppError =>
    new AppError(code, message, details, retryable, error);

  if (rest.name === 'AbortError' || azureCode === 'REQUEST_ABORTED_ERROR') {
    return mapped('timeout', `${context}: request aborted`);
  }
  if (rest.name === 'CredentialUnavailableError' || rest.name === 'AuthenticationError') {
    return mapped(
      'upstream_error',
      `${context}: unable to acquire an Azure token (${azureMessage})`,
    );
  }

  switch (status) {
    case 400:
      return mapped('bad_request', `${context}: ${azureMessage}`);
    case 401:
      return mapped(
        'upstream_error',
        `${context}: Azure rejected the connector's token (${azureMessage})`,
        true,
      );
    case 403:
      return mapped(
        'forbidden',
        `${context}: the server identity is not authorized (${azureMessage})`,
      );
    case 404:
      return mapped('not_found', `${context}: ${azureMessage}`);
    case 409:
      return mapped('conflict', `${context}: ${azureMessage}`);
    case 429:
      return mapped('rate_limited', `${context}: Azure throttled the request`, true);
    case 408:
    case 504:
      return mapped('timeout', `${context}: ${azureMessage}`);
    default:
      return mapped('upstream_error', `${context}: ${azureMessage}`);
  }
};
