import { randomBytes } from 'node:crypto';
import {
  appendAudit,
  currentContext,
  etag,
  NotFoundError,
  pageLimit,
  publishEvent,
  StateConflictError,
  uuidv7,
  ValidationError,
  VersionConflictError,
  type IdempotencyStore,
  type IdempotentRequest,
  type Selectable,
  type TenantDatabase,
  type TenantTx,
  type WriteResult,
} from '../../kernel/public.js';
import { requirePermission } from '../iam/public/authorizer.js';
import {
  INTEGRATION_MANIFEST,
  type InstanceStatus,
  type IntegrationTables,
} from './integration.manifest.js';
import type { AttemptRecord, OutboundHttp } from './outbound-http.js';
import {
  ConnectorActivated,
  ConnectorErrored,
  connectorCatalogue,
  connectorDefinition,
  ConnectorSuspended,
  WebhookReceived,
} from './public/contracts.js';
import type { SecretStore } from './secret-store.js';

type Tx = TenantTx<IntegrationTables>;
type Row = Selectable<IntegrationTables['app.int_connector_instance']>;

export interface ConnectorInstanceView {
  readonly id: string;
  readonly scope_level: string;
  readonly property_id: string | null;
  readonly connector_type: string;
  readonly connector_version: number;
  readonly display_name: string;
  readonly status: InstanceStatus;
  readonly settings: unknown;
  readonly has_credentials: boolean;
  readonly webhook_path: string;
  readonly provider_account_id: string | null;
  readonly last_health_status: string | null;
  readonly version: number;
}

const view = (r: Row): ConnectorInstanceView => ({
  id: r.id,
  scope_level: r.scope_level,
  property_id: r.property_id,
  connector_type: r.connector_type,
  connector_version: r.connector_version,
  display_name: r.display_name,
  status: r.status,
  settings: r.settings,
  has_credentials: r.credential_ref !== null,
  webhook_path: `/v1/webhooks/${r.connector_type}/${r.webhook_endpoint_id}`,
  provider_account_id: r.provider_account_id,
  last_health_status: r.last_health_status,
  version: r.version,
});

/**
 * P4 Integration Hub (module map P4; D-012 lifecycle: configure -> verify -> activate (explicit,
 * separate permission, audited) -> suspend -> retire). External calls never happen inside a database
 * transaction (B-24). Credentials are written to the secret store before the transaction and removed
 * again if it fails; they are never returned, logged or audited (E-26, G12).
 */
export class IntegrationService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly idempotency: IdempotencyStore,
    private readonly secrets: SecretStore,
    private readonly http: OutboundHttp,
    private readonly allowInsecureHttp: boolean,
  ) {}

  catalogue() {
    return connectorCatalogue().map((c) => ({
      type: c.type,
      version: c.version,
      display_name: c.displayName,
      scopes: c.scopes,
      capabilities: c.capabilities,
      credential_fields: c.credentialFields,
    }));
  }

  async list(): Promise<ConnectorInstanceView[]> {
    return this.db.transaction<IntegrationTables, ConnectorInstanceView[]>(
      INTEGRATION_MANIFEST,
      async (tx) => {
        const rows = await tx.db
          .selectFrom('app.int_connector_instance')
          .selectAll()
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .orderBy('created_at')
          .limit(500)
          .execute();
        return rows.filter((r) => allowed('integration:connector:read', r.property_id)).map(view);
      },
    );
  }

  async configure(
    input: {
      type: string;
      version: number;
      scopeLevel: 'organization' | 'property';
      propertyId: string | null;
      displayName: string;
      settings: Record<string, unknown>;
      credentials: Record<string, string>;
      providerAccountId: string | null;
    },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('integration:connector:configure', { propertyId: input.propertyId });
    const definition = connectorDefinition(input.type, input.version);
    if (definition === undefined)
      throw new ValidationError([
        { path: 'connector_type', message: 'not in the connector catalogue' },
      ]);
    if (
      !definition.scopes.includes(input.scopeLevel) ||
      (input.scopeLevel === 'property') !== (input.propertyId !== null)
    ) {
      throw new ValidationError([
        { path: 'scope_level', message: 'scope not supported by this connector' },
      ]);
    }
    const settings = definition.settingsSchema.safeParse(input.settings);
    if (!settings.success)
      throw new ValidationError([{ path: 'settings', message: 'invalid connector settings' }]);
    const fields = Object.keys(input.credentials).sort();
    if (fields.join(',') !== [...definition.credentialFields].sort().join(',')) {
      throw new ValidationError([
        {
          path: 'credentials',
          message: `expected exactly: ${definition.credentialFields.join(', ')}`,
        },
      ]);
    }
    const ctx = currentContext();
    const reference = await this.secrets.put(ctx.tenant.organizationId, input.credentials);
    try {
      const result = await this.db.transaction<IntegrationTables, WriteResult>(
        INTEGRATION_MANIFEST,
        (tx) =>
          this.idempotency.run(tx, INTEGRATION_MANIFEST, request, async () => {
            const id = uuidv7();
            const row = await tx.db
              .insertInto('app.int_connector_instance')
              .values({
                id,
                organization_id: ctx.tenant.organizationId,
                scope_level: input.scopeLevel,
                property_id: input.propertyId,
                connector_type: definition.type,
                connector_version: definition.version,
                display_name: input.displayName,
                status: 'configured',
                settings: JSON.stringify(settings.data),
                credential_ref: reference,
                webhook_endpoint_id: randomBytes(32).toString('base64url'),
                provider_account_id: input.providerAccountId,
                created_by: ctx.actor.id,
                updated_by: ctx.actor.id,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            await this.audit(tx, row, 1, 'integration.connector.configured', {
              connector_type: { after: definition.type },
              connector_version: { after: definition.version },
              status: { after: 'configured' },
              settings: { after: settings.data },
            });
            return { status: 201, headers: { etag: etag(1) }, body: view(row) };
          }),
      );
      if (result.replayed === true)
        await this.secrets.delete(ctx.tenant.organizationId, reference).catch(() => undefined);
      return result;
    } catch (error) {
      await this.secrets.delete(ctx.tenant.organizationId, reference).catch(() => undefined);
      throw error;
    }
  }

  /** Health check: calls the external system OUTSIDE any transaction, then records the result. */
  async verify(instanceId: string): Promise<ConnectorInstanceView> {
    const ctx = currentContext();
    const row = await this.load(instanceId);
    requirePermission('integration:connector:configure', { propertyId: row.property_id });
    if (row.status === 'retired') throw new StateConflictError('integration.instance_retired');
    const definition = connectorDefinition(row.connector_type, row.connector_version);
    if (definition === undefined || row.credential_ref === null)
      throw new StateConflictError('integration.instance_unusable');
    const credentials = await this.secrets.get(ctx.tenant.organizationId, row.credential_ref);
    const started = Date.now();
    const result = await definition.verify({
      instanceId,
      settings: row.settings as Record<string, unknown>,
      credentials,
      http: this.http,
      allowInsecure: this.allowInsecureHttp,
    });
    return this.db.transaction<IntegrationTables, ConnectorInstanceView>(
      INTEGRATION_MANIFEST,
      async (tx) => {
        const current = await this.lock(tx, instanceId);
        const next: InstanceStatus = result.healthy
          ? current.status === 'configured' || current.status === 'error'
            ? 'verified'
            : current.status
          : 'error';
        const updated = await tx.db
          .updateTable('app.int_connector_instance')
          .set({
            status: next,
            last_health_status: result.healthy ? 'healthy' : 'unhealthy',
            last_health_at: new Date(),
            version: current.version + 1,
            updated_at: new Date(),
            updated_by: ctx.actor.id,
          })
          .where('organization_id', '=', current.organization_id)
          .where('id', '=', current.id)
          .where('version', '=', current.version)
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.writeLogs(
          tx,
          current.id,
          'health',
          'health_check',
          result.attempts.length > 0
            ? result.attempts
            : [
                {
                  attempt: 1,
                  outcome: result.healthy ? 'success' : 'failure',
                  statusCode: null,
                  durationMs: Date.now() - started,
                  errorCode: result.errorCode,
                },
              ],
        );
        await this.audit(tx, updated, updated.version, 'integration.connector.verified', {
          status: { before: current.status, after: next },
          last_health_status: { after: updated.last_health_status },
        });
        if (!result.healthy)
          await publishEvent(
            tx,
            ConnectorErrored,
            {
              connector_instance_id: current.id,
              error: result.errorCode ?? 'integration.unhealthy',
            },
            { propertyId: current.property_id },
          );
        return view(updated);
      },
    );
  }

  async activate(instanceId: string, expectedVersion: number): Promise<ConnectorInstanceView> {
    return this.transition(
      instanceId,
      expectedVersion,
      'integration:connector:activate',
      ['verified', 'suspended'],
      'active',
      async (tx, row) => {
        await publishEvent(
          tx,
          ConnectorActivated,
          { connector_instance_id: row.id, connector_type: row.connector_type },
          { propertyId: row.property_id },
        );
      },
    );
  }

  async suspend(instanceId: string, expectedVersion: number): Promise<ConnectorInstanceView> {
    return this.transition(
      instanceId,
      expectedVersion,
      'integration:connector:configure',
      ['active', 'verified', 'error'],
      'suspended',
      async (tx, row) => {
        await publishEvent(
          tx,
          ConnectorSuspended,
          { connector_instance_id: row.id },
          { propertyId: row.property_id },
        );
      },
    );
  }

  async retire(instanceId: string, expectedVersion: number): Promise<ConnectorInstanceView> {
    const result = await this.transition(
      instanceId,
      expectedVersion,
      'integration:connector:configure',
      ['configured', 'verified', 'active', 'suspended', 'error'],
      'retired',
      () => Promise.resolve(),
    );
    return result;
  }

  /** Rotates credentials: a new secret value behind the same reference; the instance must be re-verified. */
  async rotateCredentials(
    instanceId: string,
    expectedVersion: number,
    credentials: Record<string, string>,
  ): Promise<ConnectorInstanceView> {
    const ctx = currentContext();
    const row = await this.load(instanceId);
    requirePermission('integration:connector:configure', { propertyId: row.property_id });
    const definition = connectorDefinition(row.connector_type, row.connector_version);
    if (definition === undefined || row.credential_ref === null || row.status === 'retired')
      throw new StateConflictError('integration.instance_unusable');
    if (
      Object.keys(credentials).sort().join(',') !==
      [...definition.credentialFields].sort().join(',')
    ) {
      throw new ValidationError([
        {
          path: 'credentials',
          message: `expected exactly: ${definition.credentialFields.join(', ')}`,
        },
      ]);
    }
    if (row.version !== expectedVersion) throw new VersionConflictError(row.version);
    await this.secrets.replace(ctx.tenant.organizationId, row.credential_ref, credentials);
    return this.transition(
      instanceId,
      expectedVersion,
      'integration:connector:configure',
      ['configured', 'verified', 'active', 'suspended', 'error'],
      'configured',
      () => Promise.resolve(),
      'integration.connector.credentials_rotated',
    );
  }

  async logs(instanceId: string, limitRaw: string | undefined): Promise<unknown[]> {
    const row = await this.load(instanceId);
    requirePermission('integration:log:read', { propertyId: row.property_id });
    return this.db.transaction<IntegrationTables, unknown[]>(INTEGRATION_MANIFEST, (tx) =>
      tx.db
        .selectFrom('app.int_integration_log')
        .select([
          'direction',
          'operation',
          'outcome',
          'status_code',
          'attempt',
          'duration_ms',
          'error_code',
          'recorded_at',
        ])
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .where('connector_instance_id', '=', instanceId)
        .orderBy('recorded_at', 'desc')
        .limit(pageLimit(limitRaw))
        .execute(),
    );
  }

  /** Webhook intake (called by the webhook entry point after signature verification, CX-14). */
  async recordWebhook(
    instanceId: string,
    connectorType: string,
    event: { eventId: string; eventType: string },
    raw: Buffer,
    contentType: string,
  ): Promise<{ receiptId: string; duplicate: boolean }> {
    return this.db.transaction<IntegrationTables, { receiptId: string; duplicate: boolean }>(
      INTEGRATION_MANIFEST,
      async (tx) => {
        const receiptId = uuidv7();
        const inserted = await tx.db
          .insertInto('app.int_webhook_receipt')
          .values({
            id: receiptId,
            organization_id: tx.context.tenant.organizationId,
            connector_instance_id: instanceId,
            provider_event_id: event.eventId,
            raw_payload: raw,
            content_type: contentType.slice(0, 200),
            status: 'received',
          })
          .onConflict((oc) =>
            oc
              .columns(['organization_id', 'connector_instance_id', 'provider_event_id'])
              .doNothing(),
          )
          .returning('id')
          .executeTakeFirst();
        const duplicate = inserted === undefined;
        await this.writeLogs(
          tx,
          instanceId,
          'inbound',
          'webhook',
          [
            {
              attempt: 1,
              outcome: duplicate ? 'failure' : 'success',
              statusCode: 202,
              durationMs: 0,
              errorCode: duplicate ? 'integration.duplicate_event' : null,
            },
          ],
          duplicate ? 'duplicate' : undefined,
        );
        if (!duplicate) {
          const scope = tx.context.tenant.properties;
          await publishEvent(
            tx,
            WebhookReceived,
            {
              connector_instance_id: instanceId,
              receipt_id: receiptId,
              connector_type: connectorType,
              event_type: event.eventType,
              provider_event_id: event.eventId,
            },
            { propertyId: scope.kind === 'listed' ? (scope.propertyIds[0] ?? null) : null },
          );
        }
        return { receiptId: inserted?.id ?? receiptId, duplicate };
      },
    );
  }

  private async transition(
    instanceId: string,
    expectedVersion: number,
    permission: string,
    from: readonly InstanceStatus[],
    to: InstanceStatus,
    after: (tx: Tx, row: Row) => Promise<void>,
    action = `integration.connector.${to}`,
  ): Promise<ConnectorInstanceView> {
    const ctx = currentContext();
    const result = await this.db.transaction<
      IntegrationTables,
      { view: ConnectorInstanceView; ref: string | null }
    >(INTEGRATION_MANIFEST, async (tx) => {
      const current = await this.lock(tx, instanceId);
      requirePermission(permission, { propertyId: current.property_id });
      if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
      if (!from.includes(current.status))
        throw new StateConflictError('integration.invalid_transition');
      const updated = await tx.db
        .updateTable('app.int_connector_instance')
        .set({
          status: to,
          version: current.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', current.organization_id)
        .where('id', '=', current.id)
        .where('version', '=', current.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(tx, updated, updated.version, action, {
        status: { before: current.status, after: to },
      });
      await after(tx, updated);
      return { view: view(updated), ref: current.credential_ref };
    });
    if (to === 'retired' && result.ref !== null)
      await this.secrets.delete(ctx.tenant.organizationId, result.ref).catch(() => undefined);
    return result.view;
  }

  private async load(instanceId: string): Promise<Row> {
    return this.db.transaction<IntegrationTables, Row>(INTEGRATION_MANIFEST, async (tx) => {
      const row = await tx.db
        .selectFrom('app.int_connector_instance')
        .selectAll()
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .where('id', '=', instanceId)
        .executeTakeFirst();
      if (row === undefined || !allowed('integration:connector:read', row.property_id))
        throw new NotFoundError();
      return row;
    });
  }

  private async lock(tx: Tx, instanceId: string): Promise<Row> {
    const row = await tx.db
      .selectFrom('app.int_connector_instance')
      .selectAll()
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('id', '=', instanceId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError();
    return row;
  }

  private async writeLogs(
    tx: Tx,
    instanceId: string,
    direction: 'outbound' | 'inbound' | 'health',
    operation: string,
    attempts: readonly AttemptRecord[],
    override?: 'duplicate',
  ): Promise<void> {
    for (const attempt of attempts.slice(0, 20)) {
      await tx.db
        .insertInto('app.int_integration_log')
        .values({
          id: uuidv7(),
          organization_id: tx.context.tenant.organizationId,
          connector_instance_id: instanceId,
          direction,
          operation,
          outcome: override ?? attempt.outcome,
          status_code: attempt.statusCode,
          attempt: attempt.attempt,
          duration_ms: attempt.durationMs,
          error_code: attempt.errorCode,
        })
        .execute();
    }
  }

  private audit(
    tx: Tx,
    row: Row,
    version: number,
    action: string,
    changes: Record<string, { before?: unknown; after?: unknown }>,
  ): Promise<string> {
    return appendAudit(tx, INTEGRATION_MANIFEST, {
      table: 'app.int_connector_instance',
      action,
      entityType: 'connector_instance',
      entityId: row.id,
      entityVersion: version,
      propertyId: row.property_id,
      changes,
    });
  }
}

function allowed(permission: string, propertyId: string | null): boolean {
  try {
    requirePermission(permission, { propertyId });
    return true;
  } catch {
    return false;
  }
}
