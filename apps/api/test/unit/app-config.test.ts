import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from '../../src/config/app-config.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:s3cret@db.example.internal:5432/hos',
};

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (error: unknown) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('expected a ConfigValidationError');
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    expect(loadConfig(base)).toEqual({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 3000,
      buildVersion: 'development',
      cellId: null,
      logLevel: 'info',
      database: {
        url: base.DATABASE_URL,
        seclogUrl: null,
        workerUrl: null,
        relayUrl: null,
        monitorUrl: null,
        poolMax: 10,
        connectTimeoutMs: 5000,
        statementTimeoutMs: 30000,
        healthTimeoutMs: 2000,
        lockTimeoutMs: 5000,
        applicationName: 'hos-api',
      },
      health: { cacheTtlMs: 2000 },
      identity: { issuers: [], provisioning: null, grantsCacheTtlMs: 15000 },
      security: {
        rateLimitPerMinute: 600,
        bodyLimitBytes: 1048576,
        seclogAggregationWindowMs: 10000,
      },
      ops: { port: 0, host: '127.0.0.1' },
      storage: {
        localSecretsDir: null,
        localSecretsKey: null,
        documentStorageDir: null,
        documentEncryptionKey: null,
        allowInsecureIntegrationHttp: false,
        documentMaxBytes: 10485760,
      },
    });
  });

  it('reads explicit values', () => {
    const config = loadConfig({
      ...base,
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '8080',
      DB_POOL_MAX: '25',
      DB_STATEMENT_TIMEOUT_MS: '15000',
      DB_HEALTH_TIMEOUT_MS: '1000',
      HEALTH_CACHE_TTL_MS: '0',
      HOS_BUILD_VERSION: 'abc123',
    });
    expect(config.nodeEnv).toBe('production');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(8080);
    expect(config.database.poolMax).toBe(25);
    expect(config.database.statementTimeoutMs).toBe(15000);
    expect(config.database.healthTimeoutMs).toBe(1000);
    expect(config.health.cacheTtlMs).toBe(0);
    expect(config.buildVersion).toBe('abc123');
  });

  it('requires NODE_ENV explicitly (never defaults to development)', () => {
    expect(problemsOf({ DATABASE_URL: base.DATABASE_URL })).toEqual([
      'NODE_ENV is required (one of: development, test, production)',
    ]);
  });

  it('requires DATABASE_URL and has no credential default', () => {
    expect(problemsOf({ NODE_ENV: 'development' })).toContain('DATABASE_URL is required');
  });

  it.each([
    ['not a URL', 'not a url'],
    ['a non-PostgreSQL scheme', 'mysql://user@host:3306/db'],
    ['a URL without a database name', 'postgres://user@host:5432/'],
  ])('rejects DATABASE_URL that is %s', (_label, url) => {
    expect(problemsOf({ NODE_ENV: 'development', DATABASE_URL: url }).length).toBeGreaterThan(0);
  });

  it('accepts PORT=0 only when NODE_ENV=test', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'test', PORT: '0' }).port).toBe(0);
    expect(problemsOf({ ...base, NODE_ENV: 'production', PORT: '0' })).toEqual([
      'PORT must be an integer from 1 to 65535',
    ]);
    expect(problemsOf({ ...base, NODE_ENV: 'development', PORT: '0' })).toEqual([
      'PORT must be an integer from 1 to 65535',
    ]);
  });

  it('reports every problem at once', () => {
    expect(problemsOf({ NODE_ENV: 'staging', PORT: '70000', DB_POOL_MAX: '0' })).toEqual([
      'NODE_ENV must be one of: development, test, production',
      'PORT must be an integer from 1 to 65535',
      'DATABASE_URL is required',
      'DB_POOL_MAX must be an integer from 1 to 10000',
    ]);
  });

  it('deep-freezes the configuration', () => {
    const config = loadConfig(base);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.health)).toBe(true);
    expect(() => {
      (config.database as { url: string }).url = 'postgres://attacker@evil/db';
    }).toThrow(TypeError);
  });

  it('never echoes configuration values (which may hold secrets) in errors', () => {
    let message = '';
    try {
      loadConfig({ ...base, DB_POOL_MAX: 'many' });
    } catch (caught: unknown) {
      message = caught instanceof Error ? caught.message : '';
    }
    expect(message).toContain('DB_POOL_MAX');
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('many');
  });
});
