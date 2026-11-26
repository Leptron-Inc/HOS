import { defineEvent, z } from '../../../kernel/public.js';
import { definePermissions } from '../../iam/public/permissions.js';

/** P5 public interface (F-15): per-class permissions (`document:{class}:read/write`) and events. */
export const DOCUMENT_CLASSES = ['identity', 'financial', 'contract', 'general'] as const;
/** Sensitive classes: always streamed through P5 and every read is audited (map P5 protection model). */
export const SENSITIVE_CLASSES: ReadonlySet<string> = new Set(['identity']);

export const DOCUMENT_PERMISSIONS = definePermissions(
  DOCUMENT_CLASSES.flatMap((documentClass) => [
    {
      code: `document:${documentClass}:read`,
      description: `Read ${documentClass} documents`,
      scopes: ['organization', 'property'] as const,
    },
    {
      code: `document:${documentClass}:write`,
      description: `Upload, version and delete ${documentClass} documents`,
      scopes: ['organization', 'property'] as const,
    },
  ]),
);

const id = z.string().uuid();
export const DocumentUploaded = defineEvent({
  type: 'document.uploaded',
  version: 1,
  schema: z.strictObject({ document_id: id, document_class: z.enum(DOCUMENT_CLASSES) }),
});
export const DocumentVersionCreated = defineEvent({
  type: 'document.version_created',
  version: 1,
  schema: z.strictObject({ document_id: id, version_number: z.number().int() }),
});
export const DocumentDeleted = defineEvent({
  type: 'document.deleted',
  version: 1,
  schema: z.strictObject({ document_id: id }),
});
export const DocumentRetentionExpired = defineEvent({
  type: 'document.retention_expired',
  version: 1,
  schema: z.strictObject({ document_id: id }),
});
