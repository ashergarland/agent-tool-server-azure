import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/index.js';
import { unauthorized } from '../errors.js';

export interface Principal {
  /** Stable identifier used in logs and audit records. Never the raw credential. */
  readonly id: string;
  readonly kind: 'api-key' | 'entra-jwt' | 'anonymous';
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<Principal>;
}

const bearerToken = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || undefined;
  }
  const apiKeyHeader = request.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0) return apiKeyHeader;
  return undefined;
};

/**
 * Per-process key used to derive fixed-width, non-reversible representations of bearer
 * credentials. Regenerated on every start so digests are never comparable across processes and
 * cannot be brute-forced offline if they leak through logs.
 */
const CREDENTIAL_HMAC_KEY = randomBytes(32);

/**
 * Derives the fixed-width comparison value for a credential.
 *
 * This is not password storage: API keys are high-entropy machine credentials that are never
 * persisted by this service, and the HMAC key is random per process. A deliberately slow KDF is
 * therefore inappropriate here — it would add no security while turning every unauthenticated
 * request into a CPU denial-of-service lever.
 */
// codeql[js/insufficient-password-hash]
const digest = (value: string): Buffer =>
  createHmac('sha256', CREDENTIAL_HMAC_KEY).update(value, 'utf8').digest();

/**
 * Compares two credentials without leaking their contents or their lengths: both sides are
 * reduced to a fixed-width keyed digest first, so the work performed and the bytes compared are
 * independent of the presented value.
 */
const constantTimeEquals = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

/** Stable-per-process, non-reversible label for a credential, safe to put in logs. */
const fingerprint = (value: string): string => digest(value).toString('hex').slice(0, 12);

class DisabledAuthenticator implements Authenticator {
  public authenticate(): Promise<Principal> {
    return Promise.resolve({ id: 'anonymous', kind: 'anonymous' });
  }
}

class ApiKeyAuthenticator implements Authenticator {
  public constructor(private readonly apiKeys: readonly string[]) {}

  public authenticate(request: FastifyRequest): Promise<Principal> {
    const presented = bearerToken(request);
    if (!presented) throw unauthorized('Missing bearer token or x-api-key header');

    const matched = this.apiKeys.some((key) => constantTimeEquals(key, presented));
    if (!matched) throw unauthorized('Invalid API key');

    return Promise.resolve({ id: `key:${fingerprint(presented)}`, kind: 'api-key' });
  }
}

class EntraJwtAuthenticator implements Authenticator {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuers: readonly string[];

  public constructor(
    private readonly tenantId: string,
    private readonly audience: string,
    private readonly allowedAppIds: readonly string[],
  ) {
    this.jwks = createRemoteJWKSet(
      new URL(`https://login.microsoftonline.com/${this.tenantId}/discovery/v2.0/keys`),
    );
    this.issuers = [
      `https://login.microsoftonline.com/${this.tenantId}/v2.0`,
      `https://sts.windows.net/${this.tenantId}/`,
    ];
  }

  public async authenticate(request: FastifyRequest): Promise<Principal> {
    const token = bearerToken(request);
    if (!token) throw unauthorized('Missing bearer token');

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        audience: this.audience,
        issuer: [...this.issuers],
        clockTolerance: 60,
      }));
    } catch {
      throw unauthorized('Invalid or expired access token');
    }

    const appId =
      typeof payload['appid'] === 'string'
        ? payload['appid']
        : typeof payload['azp'] === 'string'
          ? payload['azp']
          : undefined;

    if (this.allowedAppIds.length > 0 && (!appId || !this.allowedAppIds.includes(appId))) {
      throw unauthorized('Calling application is not allow-listed');
    }

    const subject = payload.sub ?? appId ?? 'unknown';
    return { id: `entra:${subject}`, kind: 'entra-jwt' };
  }
}

export const createAuthenticator = (config: AppConfig): Authenticator => {
  switch (config.auth.mode) {
    case 'disabled':
      return new DisabledAuthenticator();
    case 'api-key':
      return new ApiKeyAuthenticator(config.auth.apiKeys);
    case 'entra-jwt':
      return new EntraJwtAuthenticator(
        config.auth.tenantId,
        config.auth.audience,
        config.auth.allowedAppIds,
      );
  }
};
