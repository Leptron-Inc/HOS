import { defineEvent, z } from '../../../kernel/public.js';
import { definePermissions } from '../../iam/public/permissions.js';

/** P8 public interface: settings registry, permissions, events and the resolution service (F-15). */
export const CONFIGURATION_PERMISSIONS = definePermissions([
  {
    code: 'config:read',
    description: 'Read effective configuration and its history',
    scopes: ['organization', 'property'],
  },
  {
    code: 'config:organization:change',
    description: 'Change organization-level settings',
    scopes: ['organization'],
  },
  {
    code: 'config:property:change',
    description: 'Change property-level settings',
    scopes: ['organization', 'property'],
  },
]);

export type SettingLevel = 'template' | 'organization' | 'property';

export interface SettingDefinition<T = unknown> {
  readonly key: string;
  readonly description: string;
  readonly schema: z.ZodType<T>;
  /** null: no value unless a template or override provides one. */
  readonly defaultValue: T | null;
  /** Explicit override rules: the levels that may set this key (D-012 platform boundaries). */
  readonly levels: readonly SettingLevel[];
}

const settings = new Map<string, SettingDefinition>();

export function defineSetting<T>(definition: SettingDefinition<T>): SettingDefinition<T> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/.test(definition.key))
    throw new Error(`invalid setting key ${definition.key}`);
  if (settings.has(definition.key) && settings.get(definition.key) !== definition)
    throw new Error(`setting ${definition.key} defined twice`);
  settings.set(definition.key, definition);
  return definition;
}

export function settingDefinition(key: string): SettingDefinition | undefined {
  return settings.get(key);
}

export function settingDefinitions(): readonly SettingDefinition[] {
  return [...settings.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

/** Platform settings used by the foundation modules. Values are configuration, never secrets (P4 holds credentials). */
export const TIME_ZONE = defineSetting({
  key: 'localization.time_zone',
  description: 'IANA time zone of the property (E-11, E-13)',
  schema: z.string().max(64).refine(isTimeZone, 'must be an IANA time zone'),
  defaultValue: null,
  levels: ['template', 'property'],
});
export const DEFAULT_LANGUAGE = defineSetting({
  key: 'localization.default_language',
  description: 'Default language (BCP 47)',
  schema: z.string().regex(/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/),
  defaultValue: 'en',
  levels: ['template', 'organization', 'property'],
});
export const CURRENCY = defineSetting({
  key: 'localization.currency',
  description: 'Default ISO 4217 currency for display (U-014: not an accounting currency)',
  schema: z.string().regex(/^[A-Z]{3}$/),
  defaultValue: null,
  levels: ['template', 'organization', 'property'],
});
export const BRANDING_NAME = defineSetting({
  key: 'branding.display_name',
  description: 'Display name used in branding',
  schema: z.string().min(1).max(200),
  defaultValue: null,
  levels: ['organization', 'property'],
});
export const FEATURE_WORKFLOW_TRIGGERS = defineSetting({
  key: 'features.workflow_triggers',
  description: 'Feature flag: event-triggered workflows (MM-15 effective value)',
  schema: z.boolean(),
  defaultValue: true,
  levels: ['template', 'organization', 'property'],
});
export const DOCUMENT_RETENTION_GENERAL = defineSetting({
  key: 'documents.retention_days.general',
  description: 'Retention of general documents in days (null: no automatic deletion, E-31)',
  schema: z.number().int().min(1).max(36_500),
  defaultValue: null,
  levels: ['template', 'organization'],
});
export const DOCUMENT_RETENTION_IDENTITY = defineSetting({
  key: 'documents.retention_days.identity',
  description: 'Retention of identity documents in days; jurisdiction rule, template only',
  schema: z.number().int().min(1).max(36_500),
  defaultValue: null,
  levels: ['template'],
});

export interface ResolvedSetting {
  readonly key: string;
  readonly value: unknown;
  readonly source: 'property' | 'organization' | 'template' | 'default';
  readonly locked: boolean;
}

export interface ResolvedConfiguration {
  readonly property_id: string | null;
  readonly configuration_version: string | null;
  readonly template: { readonly code: string; readonly version: number } | null;
  readonly settings: Readonly<Record<string, ResolvedSetting>>;
}

export const PropertyConfigurationActivated = defineEvent({
  type: 'config.property.activated',
  version: 1,
  schema: z.strictObject({
    property_id: z.string().uuid(),
    template_code: z.string(),
    template_version: z.number().int(),
    configuration_version: z.string().uuid(),
  }),
});
export const PropertyConfigurationChanged = defineEvent({
  type: 'config.property.changed',
  version: 1,
  schema: z.strictObject({
    property_id: z.string().uuid(),
    setting_key: z.string(),
    effective_from: z.string(),
    configuration_version: z.string().uuid(),
  }),
});
export const OrganizationConfigurationChanged = defineEvent({
  type: 'config.organization.changed',
  version: 1,
  schema: z.strictObject({ setting_key: z.string() }),
});
