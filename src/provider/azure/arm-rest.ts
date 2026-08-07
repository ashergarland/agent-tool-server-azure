import type { TokenCredential } from '@azure/core-auth';
import { AppError } from '../../errors.js';
import { mapAzureError } from './errors.js';

export interface ArmRequestOptions {
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly timeoutMs?: number;
}

/**
 * Thin authenticated ARM reader used for the handful of control-plane surfaces that do not have a
 * modern first-party SDK worth pulling in (currently the Activity Log). It deliberately supports
 * GET only: every mutating call goes through an official SDK client.
 */
export class ArmRestClient {
  public constructor(
    private readonly credential: TokenCredential,
    private readonly endpoint: string,
    private readonly defaultTimeoutMs: number,
  ) {}

  private async authorizationHeader(): Promise<string> {
    const scope = `${this.endpoint.replace(/\/$/, '')}/.default`;
    const token = await this.credential.getToken(scope);
    if (!token) {
      throw new AppError('upstream_error', 'Unable to acquire an Azure ARM access token');
    }
    return ['Bearer', token.token].join(' ');
  }

  public async get<T>(path: string, options: ArmRequestOptions = {}): Promise<T> {
    const url = new URL(path, `${this.endpoint.replace(/\/$/, '')}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          authorization: await this.authorizationHeader(),
          accept: 'application/json',
        },
        signal: controller.signal,
      });

      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw mapAzureError(
          {
            statusCode: response.status,
            details: body,
            message: `ARM request failed with status ${response.status}`,
          },
          `GET ${url.pathname}`,
        );
      }
      return body as T;
    } catch (error) {
      throw mapAzureError(error, `GET ${url.pathname}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
