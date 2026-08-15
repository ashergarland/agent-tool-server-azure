import type { TokenCredential } from '@azure/core-auth';
import { AppError } from '../../errors.js';
import { mapAzureError } from './errors.js';

export interface ArmRequestOptions {
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
  readonly body?: unknown;
}

export interface ArmResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Readonly<Record<string, string>>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Reads a response body while counting bytes, aborting as soon as the limit is exceeded.
 *
 * Checking the size after `response.text()` would report the problem only once the whole body had
 * already been allocated — and then parsed into a second copy — which in a small container is an
 * out-of-memory crash rather than a clean upstream error.
 */
const readBounded = async (response: Response, limit: number): Promise<string> => {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    throw new AppError('upstream_error', 'Azure returned a response larger than the limit');
  }

  const body = response.body;
  if (!body) return '';

  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        throw new AppError('upstream_error', 'Azure returned a response larger than the limit');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  chunks.push(decoder.decode());
  return chunks.join('');
};

/**
 * Thin authenticated ARM client for the control-plane surfaces that have no first-party SDK worth
 * pulling in: the Activity Log, deployments at four scopes, and effective permissions.
 *
 * It only ever issues the verbs this server needs, against paths this server constructs. A caller
 * can never reach it with an arbitrary method, URL or body.
 */
export class ArmRestClient {
  public constructor(
    private readonly credential: TokenCredential,
    private readonly endpoint: string,
    private readonly defaultTimeoutMs: number,
    private readonly maxResponseBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
  ) {}

  private async authorizationHeader(): Promise<string> {
    const scope = `${this.endpoint.replace(/\/$/, '')}/.default`;
    const token = await this.credential.getToken(scope);
    if (!token) {
      throw new AppError('upstream_error', 'Unable to acquire an Azure ARM access token');
    }
    return ['Bearer', token.token].join(' ');
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    options: ArmRequestOptions,
  ): Promise<ArmResponse<T>> {
    const url = new URL(path.replace(/^\//, ''), `${this.endpoint.replace(/\/$/, '')}/`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? this.defaultTimeoutMs,
    );
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method,
        headers: {
          authorization: await this.authorizationHeader(),
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });

      const raw = await readBounded(response, this.maxResponseBytes);
      let body: unknown;
      try {
        body = raw.length === 0 ? undefined : JSON.parse(raw);
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        throw mapAzureError(
          {
            statusCode: response.status,
            details: body,
            message: `ARM request failed with status ${response.status}`,
          },
          `${method} ${url.pathname}`,
        );
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      return { status: response.status, body: body as T, headers };
    } catch (error) {
      throw mapAzureError(error, `${method} ${url.pathname}`);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  public async get<T>(path: string, options: ArmRequestOptions = {}): Promise<T> {
    return (await this.send<T>('GET', path, options)).body;
  }

  /** GET that exposes the status code, used for polling long-running operations. */
  public getRaw<T>(path: string, options: ArmRequestOptions = {}): Promise<ArmResponse<T>> {
    return this.send<T>('GET', path, options);
  }

  public post<T>(path: string, options: ArmRequestOptions = {}): Promise<ArmResponse<T>> {
    return this.send<T>('POST', path, options);
  }

  public put<T>(path: string, options: ArmRequestOptions = {}): Promise<ArmResponse<T>> {
    return this.send<T>('PUT', path, options);
  }
}
