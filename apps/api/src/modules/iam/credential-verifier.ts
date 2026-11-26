import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

/**
 * Credential verifier (tenancy specification CX-04). Hides the identity provider, which is not yet
 * chosen (D-021, technical architecture §13): any standards-based issuer of signed JWT access
 * tokens (OIDC / OAuth 2.0) can be configured, each bound to exactly one cell realm. Leptron
 * employees (realm 1) never authenticate in a cell (map §1.2): no issuer can be bound to them.
 * Role, permission and tenant claims in the token are ignored (CX-04, H-CTX-08).
 */
export type CellRealm = 'hotel_employee' | 'guest' | 'machine';

export interface TrustedIssuer {
  readonly issuer: string;
  readonly audience: string;
  readonly realm: CellRealm;
  /** Either a JWKS URL (production identity provider) or an inline JWKS (tests, local). */
  readonly jwksUrl?: string;
  readonly jwks?: { readonly keys: readonly Record<string, unknown>[] };
  /** Accepted signature algorithms (no `none`, no HMAC shared secrets). */
  readonly algorithms?: readonly string[];
}

export interface VerifiedCredential {
  readonly issuer: string;
  readonly subject: string;
  readonly realm: CellRealm;
  readonly issuedAt: Date;
  readonly authTime: Date | null;
  readonly mfa: boolean;
}

export type CredentialFailure =
  | 'credential_missing'
  | 'credential_malformed'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'signature_invalid'
  | 'issuer_unknown'
  | 'audience_invalid';

export class CredentialError extends Error {
  constructor(readonly reason: CredentialFailure) {
    super(`credential rejected: ${reason}`);
    this.name = 'CredentialError';
  }
}

const DEFAULT_ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const MAX_TOKEN_LENGTH = 8192;

export class CredentialVerifier {
  private readonly issuers = new Map<string, { config: TrustedIssuer; keys: JWTVerifyGetKey }>();

  constructor(
    issuers: readonly TrustedIssuer[],
    private readonly clockToleranceSeconds = 30,
  ) {
    for (const config of issuers) {
      if (this.issuers.has(config.issuer))
        throw new Error(`issuer configured twice: ${config.issuer}`);
      const keys =
        config.jwks !== undefined
          ? createLocalJWKSet(config.jwks as Parameters<typeof createLocalJWKSet>[0])
          : config.jwksUrl !== undefined
            ? createRemoteJWKSet(new URL(config.jwksUrl), {
                timeoutDuration: 5_000,
                cooldownDuration: 30_000,
              })
            : undefined;
      if (keys === undefined) throw new Error(`issuer ${config.issuer} has no key source`);
      this.issuers.set(config.issuer, { config, keys });
    }
  }

  /** Extracts the bearer token from an Authorization header value. */
  static bearer(header: string | undefined): string {
    if (header === undefined || header === '') throw new CredentialError('credential_missing');
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
    if (!match || header.length > MAX_TOKEN_LENGTH)
      throw new CredentialError('credential_malformed');
    return match[1] ?? '';
  }

  async verify(token: string): Promise<VerifiedCredential> {
    const issuer = unverifiedIssuer(token);
    const entry = this.issuers.get(issuer);
    if (entry === undefined) throw new CredentialError('issuer_unknown');
    try {
      const { payload } = await jwtVerify(token, entry.keys, {
        issuer: entry.config.issuer,
        audience: entry.config.audience,
        algorithms: [...(entry.config.algorithms ?? DEFAULT_ALGORITHMS)],
        clockTolerance: this.clockToleranceSeconds,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const subject = payload.sub ?? '';
      if (subject === '' || subject.length > 500) throw new CredentialError('credential_malformed');
      const amr = Array.isArray(payload.amr)
        ? payload.amr.filter((v): v is string => typeof v === 'string')
        : [];
      return {
        issuer: entry.config.issuer,
        subject,
        realm: entry.config.realm,
        issuedAt: new Date((payload.iat ?? 0) * 1000),
        authTime: typeof payload.auth_time === 'number' ? new Date(payload.auth_time * 1000) : null,
        mfa:
          amr.includes('mfa') || amr.includes('otp') || amr.includes('hwk') || amr.includes('swk'),
      };
    } catch (error) {
      if (error instanceof CredentialError) throw error;
      if (error instanceof joseErrors.JWTExpired) throw new CredentialError('token_expired');
      if (error instanceof joseErrors.JWTClaimValidationFailed) {
        if (error.claim === 'aud') throw new CredentialError('audience_invalid');
        if (error.claim === 'nbf' || error.claim === 'iat')
          throw new CredentialError('token_not_yet_valid');
        throw new CredentialError('credential_malformed');
      }
      if (
        error instanceof joseErrors.JWSSignatureVerificationFailed ||
        error instanceof joseErrors.JWKSNoMatchingKey
      ) {
        throw new CredentialError('signature_invalid');
      }
      throw new CredentialError('credential_malformed');
    }
  }
}

/** Reads `iss` without trusting it, only to choose which configured key set to verify against. */
function unverifiedIssuer(token: string): string {
  const part = token.split('.')[1];
  if (part === undefined) throw new CredentialError('credential_malformed');
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as {
      iss?: unknown;
    };
    if (typeof payload.iss !== 'string') throw new CredentialError('credential_malformed');
    return payload.iss;
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError('credential_malformed');
  }
}
