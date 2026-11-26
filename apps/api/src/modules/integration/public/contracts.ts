import { createHmac, timingSafeEqual } from 'node:crypto';
import { defineEvent, z } from '../../../kernel/public.js';
import { definePermissions } from '../../iam/public/permissions.js';
import type { OutboundHttp } from '../outbound-http.js';

/** P4 public interface (F-15): permissions, events, the connector catalogue and contracts. */
export const INTEGRATION_PERMISSIONS = definePermissions([
  {
    code: 'integration:connector:read',
    description: 'Read connector instances and their health',
    scopes: ['organization', 'property'],
  },
  {
    code: 'integration:connector:configure',
    description: 'Configure, verify, suspend and retire connector instances',
    scopes: ['organization', 'property'],
  },
  {
    code: 'integration:connector:activate',
    description: 'Activate a verified connector instance (separate from configure)',
    scopes: ['organization', 'property'],
  },
  {
    code: 'integration:log:read',
    description: 'Read integration logs and diagnostics',
    scopes: ['organization', 'property'],
  },
]);

const id = z.string().uuid();
export const ConnectorActivated = defineEvent({
  type: 'integration.connector.activated',
  version: 1,
  schema: z.strictObject({ connector_instance_id: id, connector_type: z.string() }),
});
export const ConnectorSuspended = defineEvent({
  type: 'integration.connector.suspended',
  version: 1,
  schema: z.strictObject({ connector_instance_id: id }),
});
export const ConnectorErrored = defineEvent({
  type: 'integration.connector.error',
  version: 1,
  schema: z.strictObject({ connector_instance_id: id, error: z.string() }),
});
export const WebhookReceived = defineEvent({
  type: 'integration.webhook.received',
  version: 1,
  schema: z.strictObject({
    connector_instance_id: id,
    receipt_id: id,
    connector_type: z.string(),
    event_type: z.string(),
    provider_event_id: z.string(),
  }),
});

export type Capability = 'webhook_inbound' | 'outbound_http' | 'health_check';

/** A versioned connector contract (integration contracts are versioned: type + version). */
export interface ConnectorDefinition {
  readonly type: string;
  readonly version: number;
  readonly displayName: string;
  readonly scopes: readonly ('organization' | 'property')[];
  readonly capabilities: readonly Capability[];
  readonly settingsSchema: z.ZodType<Record<string, unknown>>;
  /** Names of the secret credential fields; their values live only in the secret store. */
  readonly credentialFields: readonly string[];
  verify(input: {
    instanceId: string;
    settings: Record<string, unknown>;
    credentials: Readonly<Record<string, string>>;
    http: OutboundHttp;
    allowInsecure: boolean;
  }): Promise<{
    healthy: boolean;
    errorCode: string | null;
    attempts: readonly import('../outbound-http.js').AttemptRecord[];
  }>;
  readonly webhook?: {
    verifySignature(
      raw: Buffer,
      headers: Readonly<Record<string, string | undefined>>,
      credentials: Readonly<Record<string, string>>,
      nowSeconds: number,
    ): boolean;
    parse(raw: Buffer): { eventId: string; accountId: string | null; eventType: string } | null;
  };
}

const catalogue = new Map<string, ConnectorDefinition>();
export function defineConnector(definition: ConnectorDefinition): ConnectorDefinition {
  const key = `${definition.type}@${definition.version}`;
  if (catalogue.has(key) && catalogue.get(key) !== definition)
    throw new Error(`connector ${key} defined twice`);
  catalogue.set(key, definition);
  return definition;
}
export function connectorDefinition(
  type: string,
  version: number,
): ConnectorDefinition | undefined {
  return catalogue.get(`${type}@${version}`);
}
export function latestConnector(type: string): ConnectorDefinition | undefined {
  return [...catalogue.values()]
    .filter((c) => c.type === type)
    .sort((a, b) => b.version - a.version)[0];
}
export function connectorCatalogue(): readonly ConnectorDefinition[] {
  return [...catalogue.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.version - b.version,
  );
}

const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Built-in connector: inbound webhooks signed with HMAC-SHA256 over `<timestamp>.<raw body>`
 * (headers `x-hos-timestamp`, `x-hos-signature: sha256=<hex>`), 5-minute replay window. The body is
 * JSON with `id` (provider event ID), `type` and optional `account_id`.
 */
export const SIGNED_WEBHOOK = defineConnector({
  type: 'hos.signed_webhook',
  version: 1,
  displayName: 'Signed webhook (HMAC-SHA256)',
  scopes: ['organization', 'property'],
  capabilities: ['webhook_inbound', 'health_check'],
  settingsSchema: z.strictObject({}),
  credentialFields: ['signing_secret'],
  verify: ({ credentials }) =>
    Promise.resolve(
      (credentials.signing_secret ?? '').length >= 32
        ? { healthy: true, errorCode: null, attempts: [] }
        : { healthy: false, errorCode: 'integration.secret_too_short', attempts: [] },
    ),
  webhook: {
    verifySignature(raw, headers, credentials, nowSeconds) {
      const secret = credentials.signing_secret ?? '';
      const timestamp = headers['x-hos-timestamp'] ?? '';
      const signature = headers['x-hos-signature'] ?? '';
      if (
        secret.length < 32 ||
        !/^\d{1,12}$/.test(timestamp) ||
        !/^sha256=[0-9a-f]{64}$/.test(signature)
      )
        return false;
      if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
      const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
      return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
    },
    parse(raw) {
      try {
        const body = JSON.parse(raw.toString('utf8')) as {
          id?: unknown;
          type?: unknown;
          account_id?: unknown;
        };
        if (
          typeof body.id !== 'string' ||
          body.id === '' ||
          body.id.length > 200 ||
          typeof body.type !== 'string' ||
          !/^[a-z][a-z0-9_.]{0,99}$/.test(body.type)
        )
          return null;
        return {
          eventId: body.id,
          eventType: body.type,
          accountId: typeof body.account_id === 'string' ? body.account_id : null,
        };
      } catch {
        return null;
      }
    },
  },
});

/** Built-in connector: a generic HTTPS endpoint with a health check (outbound framework). */
export const HTTP_ENDPOINT = defineConnector({
  type: 'hos.http_endpoint',
  version: 1,
  displayName: 'HTTP endpoint with health check',
  scopes: ['organization', 'property'],
  capabilities: ['outbound_http', 'health_check'],
  settingsSchema: z.strictObject({
    base_url: z.string().url().max(500),
    health_path: z
      .string()
      .regex(/^\/[A-Za-z0-9._~/-]{0,200}$/)
      .default('/health'),
  }),
  credentialFields: ['api_key'],
  verify: async ({ instanceId, settings, credentials, http, allowInsecure }) => {
    const base = new URL(String(settings.base_url));
    if (base.protocol !== 'https:' && !allowInsecure)
      return { healthy: false, errorCode: 'integration.https_required', attempts: [] };
    const result = await http.request(
      instanceId,
      'hos.http_endpoint',
      new URL(
        typeof settings.health_path === 'string' ? settings.health_path : '/health',
        base,
      ).toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${credentials.api_key ?? ''}`,
          accept: 'application/json',
        },
      },
    );
    return { healthy: result.ok, errorCode: result.errorCode, attempts: result.attempts };
  },
});
