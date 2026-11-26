/**
 * Environment configuration, validated once at start-up. Nothing here has a credential default:
 * connection strings must be supplied by the environment, and NODE_ENV must be stated explicitly so
 * a production process can never fall back to development settings. Error messages never echo
 * values, because values can contain secrets.
 *
 * Settings that only some processes need (the security-log connection for the API, the worker
 * and relay connections for workers) are format-checked here and required by each process at
 * start-up (requireSettings).
 */
export type NodeEnvironment = 'development' | 'test' | 'production';
export type CellRealm = 'hotel_employee' | 'guest' | 'machine';

export interface DatabaseConfig {
  /** hos_api (API) runtime connection string. May contain credentials: never log it. */
  readonly url: string;
  /** hos_seclog_writer: the P7 security-event writer (API and workers). */
  readonly seclogUrl: string | null;
  /** hos_worker: event consumers, workflows, purge jobs. */
  readonly workerUrl: string | null;
  /** hos_relay: outbox relay, local queue, scheduler due-listing. */
  readonly relayUrl: string | null;
  /** hos_monitor: integrity and catalog checks (E-46(4)). */
  readonly monitorUrl: string | null;
  readonly poolMax: number;
  /** Maximum time to obtain a connection from the server. */
  readonly connectTimeoutMs: number;
  /** Server-side `statement_timeout` applied to every pooled connection (protective safeguard). */
  readonly statementTimeoutMs: number;
  /** Bound for one readiness probe; the probe's statement is cancelled by PostgreSQL after it. */
  readonly healthTimeoutMs: number;
  /** `lock_timeout` of every tenant transaction (F-21). */
  readonly lockTimeoutMs: number;
  /** Reported to PostgreSQL as `application_name`. Not read from the environment. */
  readonly applicationName: string;
}

export interface HealthConfig {
  /** How long a readiness result is reused before the database is probed again. 0 disables. */
  readonly cacheTtlMs: number;
}

export interface TrustedIssuerConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly realm: CellRealm;
  readonly jwksUrl?: string;
  readonly jwks?: { readonly keys: readonly Record<string, unknown>[] };
}

export interface IdentityConfig {
  /** Trusted token issuers, each bound to one cell realm (CX-04). */
  readonly issuers: readonly TrustedIssuerConfig[];
  /** The Control Plane provisioning identity (CX-15), or null when provisioning is disabled. */
  readonly provisioning: { readonly issuer: string; readonly subject: string } | null;
  /** CX-19: evaluated grants are reused at most this long; changes invalidate them at once. */
  readonly grantsCacheTtlMs: number;
}

export interface SecurityConfig {
  /** Protective safeguards (D-013), not volume limits. */
  readonly rateLimitPerMinute: number;
  readonly bodyLimitBytes: number;
  /** Aggregation window of the security-event writer for unverified floods (map §7.2). */
  readonly seclogAggregationWindowMs: number;
}

export interface StorageConfig {
  /** Local encrypted secret store (development and tests only; production uses AWS Secrets Manager). */
  readonly localSecretsDir: string | null;
  readonly localSecretsKey: string | null;
  /** Local encrypted document storage (development and tests only; production uses S3 with KMS). */
  readonly documentStorageDir: string | null;
  readonly documentEncryptionKey: string | null;
  /** Allow plain-HTTP connector endpoints (never in production). */
  readonly allowInsecureIntegrationHttp: boolean;
  /** Maximum size of one uploaded document version (protective safeguard). */
  readonly documentMaxBytes: number;
}

export interface OpsConfig {
  /** Operations port for metrics and diagnostics (P6). 0 disables it. Never exposed to hotel staff. */
  readonly port: number;
  readonly host: string;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly host: string;
  readonly port: number;
  readonly buildVersion: string;
  /** This cell's ID (D-019). Required by every process (requireSettings). */
  readonly cellId: string | null;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly database: DatabaseConfig;
  readonly health: HealthConfig;
  readonly identity: IdentityConfig;
  readonly security: SecurityConfig;
  readonly ops: OpsConfig;
  readonly storage: StorageConfig;
}

export class ConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid HOS API configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigValidationError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const NODE_ENVIRONMENTS: readonly NodeEnvironment[] = ['development', 'test', 'production'];
const REALMS: readonly CellRealm[] = ['hotel_employee', 'guest', 'machine'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function integer(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${name} must be an integer from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

function nodeEnvironment(env: Env, problems: string[]): NodeEnvironment | undefined {
  const raw = env.NODE_ENV?.trim() ?? '';
  if (raw === '') {
    problems.push(`NODE_ENV is required (one of: ${NODE_ENVIRONMENTS.join(', ')})`);
    return undefined;
  }
  const value = NODE_ENVIRONMENTS.find((candidate) => candidate === raw);
  if (value === undefined)
    problems.push(`NODE_ENV must be one of: ${NODE_ENVIRONMENTS.join(', ')}`);
  return value;
}

function postgresUrl(env: Env, name: string, required: boolean, problems: string[]): string | null {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') {
    if (required) problems.push(`${name} is required`);
    return required ? '' : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    problems.push(`${name} must be a valid URL`);
    return required ? '' : null;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    problems.push(`${name} must use the postgres:// or postgresql:// scheme`);
  }
  if (parsed.hostname === '' || parsed.pathname.length <= 1)
    problems.push(`${name} must include a host and a database name`);
  return raw;
}

function issuers(env: Env, problems: string[]): TrustedIssuerConfig[] {
  const raw = env.HOS_IDENTITY_ISSUERS?.trim() ?? '';
  if (raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push('HOS_IDENTITY_ISSUERS must be a JSON array');
    return [];
  }
  if (!Array.isArray(parsed)) {
    problems.push('HOS_IDENTITY_ISSUERS must be a JSON array');
    return [];
  }
  const result: TrustedIssuerConfig[] = [];
  parsed.forEach((item: unknown, index) => {
    const entry = item as Partial<TrustedIssuerConfig> & Record<string, unknown>;
    const ok =
      typeof entry.issuer === 'string' &&
      entry.issuer !== '' &&
      typeof entry.audience === 'string' &&
      entry.audience !== '' &&
      REALMS.includes(entry.realm as CellRealm) &&
      ((typeof entry.jwksUrl === 'string' && entry.jwksUrl.startsWith('https://')) ||
        (typeof entry.jwks === 'object' &&
          entry.jwks !== null &&
          Array.isArray((entry.jwks as { keys?: unknown }).keys)));
    if (!ok) {
      problems.push(
        `HOS_IDENTITY_ISSUERS[${index}] needs issuer, audience, a cell realm and an https jwksUrl or an inline jwks`,
      );
      return;
    }
    const keys = entry.jwks?.keys ?? [];
    if (keys.some((key) => typeof key === 'object' && key !== null && ('d' in key || 'k' in key))) {
      problems.push(`HOS_IDENTITY_ISSUERS[${index}] must contain public keys only`);
      return;
    }
    result.push({
      issuer: entry.issuer,
      audience: entry.audience,
      realm: entry.realm as CellRealm,
      ...(entry.jwksUrl !== undefined ? { jwksUrl: entry.jwksUrl } : {}),
      ...(entry.jwks !== undefined ? { jwks: entry.jwks } : {}),
    });
  });
  return result;
}

function key32(env: Env, name: string, problems: string[]): string | null {
  const raw = env[name]?.trim() ?? '';
  if (raw === '') return null;
  if (Buffer.from(raw, 'base64').length !== 32)
    problems.push(`${name} must be 32 bytes, base64-encoded`);
  return raw;
}

function storage(
  env: Env,
  nodeEnv: NodeEnvironment | undefined,
  problems: string[],
): StorageConfig {
  const localSecretsDir = env.HOS_LOCAL_SECRETS_DIR?.trim() || null;
  const documentStorageDir = env.HOS_DOCUMENT_STORAGE_DIR?.trim() || null;
  if (nodeEnv === 'production' && (localSecretsDir !== null || documentStorageDir !== null)) {
    problems.push('local secret and document stores are not allowed in production');
  }
  const insecure = env.INTEGRATION_ALLOW_INSECURE_HTTP?.trim() === 'true';
  if (nodeEnv === 'production' && insecure)
    problems.push('INTEGRATION_ALLOW_INSECURE_HTTP is not allowed in production');
  const localSecretsKey = key32(env, 'HOS_LOCAL_SECRETS_KEY', problems);
  const documentEncryptionKey = key32(env, 'HOS_DOCUMENT_ENCRYPTION_KEY', problems);
  if ((localSecretsDir === null) !== (localSecretsKey === null))
    problems.push('HOS_LOCAL_SECRETS_DIR and HOS_LOCAL_SECRETS_KEY must be set together');
  if ((documentStorageDir === null) !== (documentEncryptionKey === null))
    problems.push('HOS_DOCUMENT_STORAGE_DIR and HOS_DOCUMENT_ENCRYPTION_KEY must be set together');
  return {
    localSecretsDir,
    localSecretsKey,
    documentStorageDir,
    documentEncryptionKey,
    allowInsecureIntegrationHttp: insecure && nodeEnv !== 'production',
    documentMaxBytes: integer(env, 'DOCUMENT_MAX_BYTES', 10_485_760, 1_024, 104_857_600, problems),
  };
}

function deepFreeze<T extends object>(value: T): T {
  for (const nested of Object.values(value)) {
    if (typeof nested === 'object' && nested !== null && !Object.isFrozen(nested))
      deepFreeze(nested as object);
  }
  return Object.freeze(value);
}

export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];

  const nodeEnv = nodeEnvironment(env, problems);
  // Port 0 (an ephemeral port) is only meaningful for automated tests.
  const minPort = nodeEnv === 'test' ? 0 : 1;
  const port = integer(env, 'PORT', 3000, minPort, 65_535, problems);
  const databaseUrl = postgresUrl(env, 'DATABASE_URL', true, problems) ?? '';
  const poolMax = integer(env, 'DB_POOL_MAX', 10, 1, 10_000, problems);
  const connectTimeoutMs = integer(env, 'DB_CONNECT_TIMEOUT_MS', 5_000, 1, 600_000, problems);
  const statementTimeoutMs = integer(
    env,
    'DB_STATEMENT_TIMEOUT_MS',
    30_000,
    1,
    3_600_000,
    problems,
  );
  const healthTimeoutMs = integer(env, 'DB_HEALTH_TIMEOUT_MS', 2_000, 1, 60_000, problems);
  const cacheTtlMs = integer(env, 'HEALTH_CACHE_TTL_MS', 2_000, 0, 60_000, problems);

  const cellRaw = env.HOS_CELL_ID?.trim() ?? '';
  if (cellRaw !== '' && !/^[a-z0-9-]{1,64}$/.test(cellRaw))
    problems.push('HOS_CELL_ID must be 1-64 lowercase letters, digits or hyphens');
  const logLevelRaw = env.LOG_LEVEL?.trim() ?? '';
  const logLevel = LOG_LEVELS.find((level) => level === logLevelRaw) ?? 'info';
  if (logLevelRaw !== '' && logLevel !== logLevelRaw)
    problems.push(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);

  const provisioningIssuer = env.HOS_PROVISIONING_ISSUER?.trim() ?? '';
  const provisioningSubject = env.HOS_PROVISIONING_SUBJECT?.trim() ?? '';
  if ((provisioningIssuer === '') !== (provisioningSubject === '')) {
    problems.push('HOS_PROVISIONING_ISSUER and HOS_PROVISIONING_SUBJECT must be set together');
  }

  const config: AppConfig = {
    nodeEnv: nodeEnv ?? 'production',
    host: env.HOST?.trim() || '127.0.0.1',
    port,
    buildVersion: env.HOS_BUILD_VERSION?.trim() || 'development',
    cellId: cellRaw === '' ? null : cellRaw,
    logLevel,
    database: {
      url: databaseUrl,
      seclogUrl: postgresUrl(env, 'SECLOG_DATABASE_URL', false, problems),
      workerUrl: postgresUrl(env, 'WORKER_DATABASE_URL', false, problems),
      relayUrl: postgresUrl(env, 'RELAY_DATABASE_URL', false, problems),
      monitorUrl: postgresUrl(env, 'MONITOR_DATABASE_URL', false, problems),
      poolMax,
      connectTimeoutMs,
      statementTimeoutMs,
      healthTimeoutMs,
      lockTimeoutMs: integer(env, 'DB_LOCK_TIMEOUT_MS', 5_000, 1, 600_000, problems),
      applicationName: 'hos-api',
    },
    health: { cacheTtlMs },
    identity: {
      issuers: issuers(env, problems),
      provisioning:
        provisioningIssuer === '' || provisioningSubject === ''
          ? null
          : { issuer: provisioningIssuer, subject: provisioningSubject },
      grantsCacheTtlMs: integer(env, 'IAM_GRANTS_CACHE_TTL_MS', 15_000, 0, 300_000, problems),
    },
    security: {
      rateLimitPerMinute: integer(env, 'RATE_LIMIT_PER_MINUTE', 600, 1, 1_000_000, problems),
      bodyLimitBytes: integer(
        env,
        'HTTP_BODY_LIMIT_BYTES',
        1_048_576,
        1_024,
        104_857_600,
        problems,
      ),
      seclogAggregationWindowMs: integer(
        env,
        'SECLOG_AGGREGATION_WINDOW_MS',
        10_000,
        100,
        600_000,
        problems,
      ),
    },
    ops: {
      port: integer(env, 'OPS_PORT', 0, 0, 65_535, problems),
      host: env.OPS_HOST?.trim() || '127.0.0.1',
    },
    storage: storage(env, nodeEnv, problems),
  };

  if (problems.length > 0) throw new ConfigValidationError(problems);
  return deepFreeze(config);
}

/** Each process states what it needs; missing settings stop it at start-up (fail closed). */
export function requireSettings(
  config: AppConfig,
  needs: readonly ('cellId' | 'seclogUrl' | 'workerUrl' | 'relayUrl' | 'monitorUrl' | 'issuers')[],
): void {
  const problems: string[] = [];
  for (const need of needs) {
    switch (need) {
      case 'cellId':
        if (config.cellId === null) problems.push('HOS_CELL_ID is required');
        break;
      case 'issuers':
        if (config.identity.issuers.length === 0)
          problems.push('HOS_IDENTITY_ISSUERS must configure at least one trusted issuer');
        break;
      case 'seclogUrl':
        if (config.database.seclogUrl === null) problems.push('SECLOG_DATABASE_URL is required');
        break;
      case 'workerUrl':
        if (config.database.workerUrl === null) problems.push('WORKER_DATABASE_URL is required');
        break;
      case 'relayUrl':
        if (config.database.relayUrl === null) problems.push('RELAY_DATABASE_URL is required');
        break;
      case 'monitorUrl':
        if (config.database.monitorUrl === null) problems.push('MONITOR_DATABASE_URL is required');
        break;
    }
  }
  if (problems.length > 0) throw new ConfigValidationError(problems);
}
