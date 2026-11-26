import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig, requireSettings } from '../../src/config/app-config.js';

const base = { NODE_ENV: 'development', DATABASE_URL: 'postgres://u@h:5432/d' };
const problems = (env: Record<string, string>): readonly string[] => {
  try {
    loadConfig(env);
    return [];
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
};

describe('Phase 1 configuration safeguards', () => {
  it('trusted issuers need a cell realm and public keys only', () => {
    expect(
      problems({
        ...base,
        HOS_IDENTITY_ISSUERS:
          '[{"issuer":"x","audience":"a","realm":"leptron_employee","jwksUrl":"https://x"}]',
      }),
    ).toHaveLength(1);
    expect(
      problems({
        ...base,
        HOS_IDENTITY_ISSUERS:
          '[{"issuer":"x","audience":"a","realm":"guest","jwks":{"keys":[{"kty":"oct","k":"c2VjcmV0"}]}}]',
      }),
    ).toEqual(['HOS_IDENTITY_ISSUERS[0] must contain public keys only']);
    expect(
      problems({
        ...base,
        HOS_IDENTITY_ISSUERS:
          '[{"issuer":"x","audience":"a","realm":"guest","jwksUrl":"http://insecure"}]',
      }),
    ).toHaveLength(1);
    expect(problems({ ...base, HOS_IDENTITY_ISSUERS: 'not json' })).toEqual([
      'HOS_IDENTITY_ISSUERS must be a JSON array',
    ]);
  });

  it('local secret and document stores and plain-HTTP connectors are refused in production', () => {
    const key = Buffer.alloc(32, 1).toString('base64');
    const prod = {
      ...base,
      NODE_ENV: 'production',
      HOS_LOCAL_SECRETS_DIR: '/tmp/s',
      HOS_LOCAL_SECRETS_KEY: key,
      INTEGRATION_ALLOW_INSECURE_HTTP: 'true',
    };
    expect(problems(prod)).toEqual(
      expect.arrayContaining([
        'local secret and document stores are not allowed in production',
        'INTEGRATION_ALLOW_INSECURE_HTTP is not allowed in production',
      ]),
    );
    expect(
      problems({ ...base, HOS_LOCAL_SECRETS_DIR: '/tmp/s', HOS_LOCAL_SECRETS_KEY: 'short' }),
    ).toContain('HOS_LOCAL_SECRETS_KEY must be 32 bytes, base64-encoded');
    expect(problems({ ...base, HOS_LOCAL_SECRETS_DIR: '/tmp/s' })).toContain(
      'HOS_LOCAL_SECRETS_DIR and HOS_LOCAL_SECRETS_KEY must be set together',
    );
  });

  it('the provisioning identity needs both issuer and subject', () => {
    expect(problems({ ...base, HOS_PROVISIONING_ISSUER: 'https://cp' })).toEqual([
      'HOS_PROVISIONING_ISSUER and HOS_PROVISIONING_SUBJECT must be set together',
    ]);
  });

  it('each process states what it needs and stops without it', () => {
    const config = loadConfig(base);
    expect(() => requireSettings(config, ['cellId', 'seclogUrl', 'issuers'])).toThrow(
      ConfigValidationError,
    );
    const ready = loadConfig({
      ...base,
      HOS_CELL_ID: 'cell-1',
      SECLOG_DATABASE_URL: 'postgres://s@h:5432/d',
      HOS_IDENTITY_ISSUERS:
        '[{"issuer":"https://idp","audience":"a","realm":"hotel_employee","jwksUrl":"https://idp/jwks"}]',
    });
    expect(() => requireSettings(ready, ['cellId', 'seclogUrl', 'issuers'])).not.toThrow();
  });
});
