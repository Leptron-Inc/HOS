import {
  appendAudit,
  currentContext,
  NotFoundError,
  publishEvent,
  StateConflictError,
  uuidv7,
  ValidationError,
  VersionConflictError,
  type RequestContext,
  type TenantDatabase,
  type TenantTx,
} from '../../kernel/public.js';
import { requirePermission } from '../iam/public/authorizer.js';
import { CONFIGURATION_MANIFEST, type ConfigurationTables } from './configuration.manifest.js';
import {
  OrganizationConfigurationChanged,
  PropertyConfigurationActivated,
  PropertyConfigurationChanged,
  settingDefinition,
  settingDefinitions,
  type ResolvedConfiguration,
  type ResolvedSetting,
  type SettingLevel,
} from './public/contracts.js';

type Tx = TenantTx<ConfigurationTables>;

function validateValue(key: string, value: unknown, level: SettingLevel): void {
  const definition = settingDefinition(key);
  if (definition === undefined)
    throw new ValidationError([{ path: key, message: 'unknown setting' }]);
  if (!definition.levels.includes(level))
    throw new ValidationError([{ path: key, message: `cannot be set at ${level} level` }]);
  if (value === null) return; // clearing an override
  const parsed = definition.schema.safeParse(value);
  if (!parsed.success)
    throw new ValidationError([
      { path: key, message: parsed.error.issues[0]?.message ?? 'invalid value' },
    ]);
}

/**
 * P8 configuration (module map P8; D-012). Resolution order for one key, most specific first:
 * property override effective now -> organization override -> template snapshot -> platform default.
 * A key the template locks ignores overrides, and property overrides of it are refused. The cache is
 * keyed by organization and property, so one organization's settings never serve another (and every
 * read runs under row-level security). Writes invalidate it at once; other instances expire it by TTL.
 */
export class ConfigurationService {
  private readonly cache = new Map<string, { value: ResolvedConfiguration; expires: number }>();

  constructor(
    private readonly db: TenantDatabase,
    private readonly cacheTtlMs = 10_000,
  ) {}

  // ---------- Resolution ----------

  /** Effective configuration for the context's organization, optionally one property. */
  async resolve(propertyId: string | null): Promise<ResolvedConfiguration> {
    const ctx = currentContext();
    const key = `${ctx.tenant.organizationId}:${propertyId ?? '-'}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expires > Date.now()) return cached.value;
    const value = await this.db.transaction<ConfigurationTables, ResolvedConfiguration>(
      CONFIGURATION_MANIFEST,
      (tx) => this.resolveIn(tx, propertyId),
    );
    this.cache.set(key, { value, expires: Date.now() + this.cacheTtlMs });
    return value;
  }

  /** Authorized read of the effective configuration (API). */
  async effective(propertyId: string | null): Promise<ResolvedConfiguration> {
    requirePermission('config:read', { propertyId });
    return this.resolve(propertyId);
  }

  private async resolveIn(tx: Tx, propertyId: string | null): Promise<ResolvedConfiguration> {
    const organizationId = tx.context.tenant.organizationId;
    const orgRows = await tx.db
      .selectFrom('app.cfg_organization_setting')
      .select(['setting_key', 'setting_value'])
      .where('organization_id', '=', organizationId)
      .limit(1000)
      .execute();
    const orgValues = new Map(
      orgRows.filter((r) => r.setting_value !== null).map((r) => [r.setting_key, r.setting_value]),
    );
    let template: ResolvedConfiguration['template'] = null;
    let templateValues: Record<string, unknown> = {};
    let locked = new Set<string>();
    let configurationVersion: string | null = null;
    const propertyValues = new Map<string, unknown>();
    if (propertyId !== null) {
      const state = await tx.db
        .selectFrom('app.cfg_property_state')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('property_id', '=', propertyId)
        .executeTakeFirst();
      configurationVersion = state?.configuration_version ?? null;
      if (state?.active_snapshot_id) {
        const snapshot = await tx.db
          .selectFrom('app.cfg_template_snapshot')
          .selectAll()
          .where('organization_id', '=', organizationId)
          .where('id', '=', state.active_snapshot_id)
          .executeTakeFirstOrThrow();
        template = { code: snapshot.template_code, version: snapshot.template_version };
        templateValues = snapshot.setting_values as Record<string, unknown>;
        locked = new Set(snapshot.locked_keys);
      }
      const rows = await tx.db
        .selectFrom('app.cfg_property_setting')
        .select(['setting_key', 'setting_value', 'effective_from'])
        .where('organization_id', '=', organizationId)
        .where('property_id', '=', propertyId)
        .where('effective_from', '<=', new Date())
        .orderBy('setting_key')
        .orderBy('effective_from', 'desc')
        .limit(5000)
        .execute();
      for (const row of rows)
        if (!propertyValues.has(row.setting_key))
          propertyValues.set(row.setting_key, row.setting_value);
    }
    const settings: Record<string, ResolvedSetting> = {};
    for (const definition of settingDefinitions()) {
      const k = definition.key;
      const isLocked = locked.has(k);
      let resolved: ResolvedSetting = {
        key: k,
        value: definition.defaultValue,
        source: 'default',
        locked: isLocked,
      };
      if (k in templateValues)
        resolved = { key: k, value: templateValues[k], source: 'template', locked: isLocked };
      if (!isLocked && definition.levels.includes('organization') && orgValues.has(k))
        resolved = { key: k, value: orgValues.get(k), source: 'organization', locked: false };
      if (
        !isLocked &&
        definition.levels.includes('property') &&
        propertyValues.has(k) &&
        propertyValues.get(k) !== null
      ) {
        resolved = { key: k, value: propertyValues.get(k), source: 'property', locked: false };
      }
      settings[k] = resolved;
    }
    return {
      property_id: propertyId,
      configuration_version: configurationVersion,
      template,
      settings,
    };
  }

  invalidate(organizationId: string, propertyId?: string | null): void {
    for (const key of this.cache.keys()) {
      if (!key.startsWith(`${organizationId}:`)) continue;
      if (
        propertyId === undefined ||
        propertyId === null ||
        key === `${organizationId}:${propertyId}` ||
        key === `${organizationId}:-`
      )
        this.cache.delete(key);
    }
  }

  // ---------- Provisioning: the configuration snapshot (CX-15) ----------

  async applySnapshot(
    propertyId: string,
    input: {
      templateCode: string;
      templateVersion: number;
      values: Record<string, unknown>;
      lockedKeys: readonly string[];
    },
  ): Promise<{ created: boolean; configuration_version: string }> {
    requirePermission('tenant:provision');
    for (const [key, value] of Object.entries(input.values)) validateValue(key, value, 'template');
    for (const key of input.lockedKeys)
      if (!(key in input.values))
        throw new ValidationError([
          { path: 'locked_keys', message: `${key} has no template value` },
        ]);
    const ctx = currentContext();
    const result = await this.db.transaction<
      ConfigurationTables,
      { created: boolean; configuration_version: string }
    >(CONFIGURATION_MANIFEST, async (tx) => {
      const existing = await tx.db
        .selectFrom('app.cfg_template_snapshot')
        .select(['id'])
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('property_id', '=', propertyId)
        .where('template_code', '=', input.templateCode)
        .where('template_version', '=', input.templateVersion)
        .executeTakeFirst();
      const state = await this.lockState(tx, propertyId);
      if (existing !== undefined && state.active_snapshot_id === existing.id)
        return { created: false, configuration_version: state.configuration_version };
      const snapshotId = existing?.id ?? uuidv7();
      if (existing === undefined) {
        await tx.db
          .insertInto('app.cfg_template_snapshot')
          .values({
            id: snapshotId,
            organization_id: ctx.tenant.organizationId,
            property_id: propertyId,
            template_code: input.templateCode,
            template_version: input.templateVersion,
            setting_values: JSON.stringify(input.values),
            locked_keys: [...input.lockedKeys],
            created_by: ctx.actor.id,
          })
          .execute();
      }
      const configurationVersion = uuidv7();
      const updated = await tx.db
        .updateTable('app.cfg_property_state')
        .set({
          active_snapshot_id: snapshotId,
          configuration_version: configurationVersion,
          status: 'active',
          version: state.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', state.id)
        .where('version', '=', state.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await appendAudit(tx, CONFIGURATION_MANIFEST, {
        table: 'app.cfg_property_state',
        action: 'config.property.snapshot_applied',
        entityType: 'property_configuration',
        entityId: state.id,
        entityVersion: updated.version,
        propertyId,
        changes: {
          active_snapshot_id: { before: state.active_snapshot_id, after: snapshotId },
          configuration_version: {
            before: state.configuration_version,
            after: configurationVersion,
          },
          status: { before: state.status, after: 'active' },
        },
      });
      await publishEvent(
        tx,
        PropertyConfigurationActivated,
        {
          property_id: propertyId,
          template_code: input.templateCode,
          template_version: input.templateVersion,
          configuration_version: configurationVersion,
        },
        { propertyId },
      );
      return { created: existing === undefined, configuration_version: configurationVersion };
    });
    this.invalidate(ctx.tenant.organizationId, propertyId);
    return result;
  }

  /** Consumer of tenant.property.provisioned: creates the property's configuration state. */
  async initializeProperty(tx: Tx, propertyId: string): Promise<void> {
    const existing = await tx.db
      .selectFrom('app.cfg_property_state')
      .select('id')
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('property_id', '=', propertyId)
      .executeTakeFirst();
    if (existing !== undefined) return;
    await tx.db
      .insertInto('app.cfg_property_state')
      .values({
        id: uuidv7(),
        organization_id: tx.context.tenant.organizationId,
        property_id: propertyId,
        active_snapshot_id: null,
        configuration_version: uuidv7(),
        status: 'pending',
        created_by: tx.context.actor.id,
        updated_by: tx.context.actor.id,
      })
      .onConflict((oc) => oc.columns(['organization_id', 'property_id']).doNothing())
      .execute();
  }

  // ---------- Overrides (safe, explicit, versioned, audited with reason: D-012) ----------

  async setOrganizationSetting(
    key: string,
    value: unknown,
    reason: string,
    expectedVersion: number | null,
  ): Promise<ResolvedConfiguration> {
    requirePermission('config:organization:change');
    validateValue(key, value, 'organization');
    const ctx = currentContext();
    await this.db.transaction<ConfigurationTables, void>(CONFIGURATION_MANIFEST, async (tx) => {
      const current = await tx.db
        .selectFrom('app.cfg_organization_setting')
        .selectAll()
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('setting_key', '=', key)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (current === undefined) {
        if (expectedVersion !== null) throw new VersionConflictError(0);
        const id = uuidv7();
        await tx.db
          .insertInto('app.cfg_organization_setting')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            setting_key: key,
            setting_value: JSON.stringify(value),
            reason,
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .execute();
        await this.auditChange(
          tx,
          'app.cfg_organization_setting',
          id,
          1,
          null,
          key,
          null,
          value,
          reason,
        );
      } else {
        if (expectedVersion === null || current.version !== expectedVersion)
          throw new VersionConflictError(current.version);
        await tx.db
          .updateTable('app.cfg_organization_setting')
          .set({
            setting_value: JSON.stringify(value),
            reason,
            version: current.version + 1,
            updated_at: new Date(),
            updated_by: ctx.actor.id,
          })
          .where('organization_id', '=', ctx.tenant.organizationId)
          .where('id', '=', current.id)
          .where('version', '=', expectedVersion)
          .execute();
        await this.auditChange(
          tx,
          'app.cfg_organization_setting',
          current.id,
          current.version + 1,
          null,
          key,
          current.setting_value,
          value,
          reason,
        );
      }
      await publishEvent(tx, OrganizationConfigurationChanged, { setting_key: key });
    });
    this.invalidate(ctx.tenant.organizationId);
    return this.resolve(null);
  }

  /** Effective-dated property override; locked template keys are refused. */
  async setPropertySetting(
    propertyId: string,
    key: string,
    value: unknown,
    reason: string,
    effectiveFrom: Date,
  ): Promise<ResolvedConfiguration> {
    requirePermission('config:property:change', { propertyId });
    validateValue(key, value, 'property');
    const ctx = currentContext();
    await this.db.transaction<ConfigurationTables, void>(CONFIGURATION_MANIFEST, async (tx) => {
      const state = await this.lockState(tx, propertyId);
      if (state.active_snapshot_id !== null) {
        const snapshot = await tx.db
          .selectFrom('app.cfg_template_snapshot')
          .select('locked_keys')
          .where('organization_id', '=', ctx.tenant.organizationId)
          .where('id', '=', state.active_snapshot_id)
          .executeTakeFirstOrThrow();
        if (snapshot.locked_keys.includes(key))
          throw new StateConflictError('config.setting_locked_by_template');
      }
      const previous = await tx.db
        .selectFrom('app.cfg_property_setting')
        .select(['setting_value'])
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('property_id', '=', propertyId)
        .where('setting_key', '=', key)
        .where('effective_from', '<=', effectiveFrom)
        .orderBy('effective_from', 'desc')
        .limit(1)
        .executeTakeFirst();
      const id = uuidv7();
      await tx.db
        .insertInto('app.cfg_property_setting')
        .values({
          id,
          organization_id: ctx.tenant.organizationId,
          property_id: propertyId,
          setting_key: key,
          setting_value: JSON.stringify(value),
          effective_from: effectiveFrom,
          reason,
          created_by: ctx.actor.id,
          updated_by: ctx.actor.id,
        })
        .execute();
      const configurationVersion = uuidv7();
      await tx.db
        .updateTable('app.cfg_property_state')
        .set({
          configuration_version: configurationVersion,
          version: state.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', state.id)
        .where('version', '=', state.version)
        .execute();
      await this.auditChange(
        tx,
        'app.cfg_property_setting',
        id,
        1,
        propertyId,
        key,
        previous?.setting_value ?? null,
        value,
        reason,
        effectiveFrom,
      );
      await publishEvent(
        tx,
        PropertyConfigurationChanged,
        {
          property_id: propertyId,
          setting_key: key,
          effective_from: effectiveFrom.toISOString(),
          configuration_version: configurationVersion,
        },
        { propertyId },
      );
    });
    this.invalidate(ctx.tenant.organizationId, propertyId);
    return this.resolve(propertyId);
  }

  async history(propertyId: string | null, key: string): Promise<unknown[]> {
    requirePermission('config:read', { propertyId });
    return this.db.transaction<ConfigurationTables, unknown[]>(
      CONFIGURATION_MANIFEST,
      async (tx) => {
        if (propertyId === null) {
          return tx.db
            .selectFrom('app.cfg_organization_setting_history')
            .select([
              'version',
              'recorded_at',
              'actor_id',
              'correlation_id',
              'setting_value',
              'reason',
            ])
            .where('organization_id', '=', tx.context.tenant.organizationId)
            .where('setting_key', '=', key)
            .orderBy('recorded_at')
            .limit(500)
            .execute();
        }
        return tx.db
          .selectFrom('app.cfg_property_setting_history')
          .select([
            'entity_id',
            'version',
            'recorded_at',
            'actor_id',
            'correlation_id',
            'setting_value',
            'effective_from',
            'reason',
          ])
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .where('property_id', '=', propertyId)
          .where('setting_key', '=', key)
          .orderBy('recorded_at')
          .limit(500)
          .execute();
      },
    );
  }

  private async lockState(tx: Tx, propertyId: string) {
    await this.initializeProperty(tx, propertyId);
    const state = await tx.db
      .selectFrom('app.cfg_property_state')
      .selectAll()
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('property_id', '=', propertyId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (state === undefined) throw new NotFoundError();
    return state;
  }

  private auditChange(
    tx: Tx,
    table: string,
    id: string,
    version: number,
    propertyId: string | null,
    key: string,
    before: unknown,
    after: unknown,
    reason: string,
    effectiveFrom?: Date,
  ): Promise<string> {
    return appendAudit(tx, CONFIGURATION_MANIFEST, {
      table,
      action: propertyId === null ? 'config.organization.changed' : 'config.property.changed',
      entityType: 'setting',
      entityId: id,
      entityVersion: version,
      propertyId,
      changes: {
        setting_key: { after: key },
        setting_value: { before, after },
        reason: { after: reason },
        ...(effectiveFrom !== undefined
          ? { effective_from: { after: effectiveFrom.toISOString() } }
          : {}),
      },
    });
  }
}

export type { RequestContext };
