import { AppError } from '../../errors.js';

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

  if (rest.name === 'AbortError' || azureCode === 'REQUEST_ABORTED_ERROR') {
    return new AppError('timeout', `${context}: request aborted`, { details, cause: error });
  }
  if (rest.name === 'CredentialUnavailableError' || rest.name === 'AuthenticationError') {
    return new AppError(
      'upstream_error',
      `${context}: unable to acquire an Azure token (${azureMessage})`,
      { details, cause: error },
    );
  }

  switch (status) {
    case 400:
      return new AppError('bad_request', `${context}: ${azureMessage}`, { details, cause: error });
    case 401:
    case 403:
      return new AppError(
        'forbidden',
        `${context}: the connector identity is not authorized (${azureMessage})`,
        { details, cause: error },
      );
    case 404:
      return new AppError('not_found', `${context}: ${azureMessage}`, { details, cause: error });
    case 409:
      return new AppError('conflict', `${context}: ${azureMessage}`, { details, cause: error });
    case 429:
      return new AppError('rate_limited', `${context}: Azure throttled the request`, {
        details,
        cause: error,
        retryable: true,
      });
    case 408:
    case 504:
      return new AppError('timeout', `${context}: ${azureMessage}`, { details, cause: error });
    default:
      return new AppError('upstream_error', `${context}: ${azureMessage}`, {
        details,
        cause: error,
      });
  }
};
