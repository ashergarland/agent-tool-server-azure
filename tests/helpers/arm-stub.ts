import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TokenCredential } from '@azure/core-auth';

export interface RecordedRequest {
  readonly method: string;
  /** Path only, without the query string. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface StubReply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** Sent verbatim, for testing malformed or oversized payloads. */
  readonly raw?: string;
}

export type StubHandler = (request: RecordedRequest, index: number) => StubReply;

export interface ArmStub {
  readonly origin: string;
  readonly requests: RecordedRequest[];
  respond(handler: StubHandler): void;
  close(): Promise<void>;
}

/**
 * A real HTTP server standing in for Azure Resource Manager.
 *
 * The point is to exercise the actual `ArmRestClient` and `ArmDeploymentClient` — their URL
 * construction, api-versions, long-running-operation polling and response bounding — over a real
 * socket. A hand-written fake of those classes could only ever confirm that the code agrees with my
 * own assumptions about ARM; this at least pins the wire contract those assumptions produce.
 */
export const startArmStub = async (initial: StubHandler): Promise<ArmStub> => {
  const requests: RecordedRequest[] = [];
  let handler = initial;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const rawBody = Buffer.concat(chunks).toString('utf8');

      let body: unknown;
      try {
        body = rawBody.length === 0 ? undefined : JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }

      const recorded: RecordedRequest = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(',') : (value ?? ''),
          ]),
        ),
        body,
      };
      requests.push(recorded);

      const reply = handler(recorded, requests.length - 1);
      const payload = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
      response.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...reply.headers,
      });
      response.end(payload);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    respond(next) {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

/** Credential double. The real one would need a tenant; this only has to produce a bearer token. */
export const stubCredential = (token = 'stub-access-token'): TokenCredential => ({
  getToken: () => Promise.resolve({ token, expiresOnTimestamp: Date.now() + 3_600_000 }),
});
