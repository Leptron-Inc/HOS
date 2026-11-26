import { defineEvent, z } from '../../../kernel/public.js';
import { definePermissions } from '../../iam/public/permissions.js';

/** P7 public interface (F-15): permissions, data-request events and the participant registry. */
export const SECURITY_PERMISSIONS = definePermissions([
  {
    code: 'audit:read',
    description: 'Read audit records and verify the audit chain',
    scopes: ['organization'],
  },
  {
    code: 'compliance:data_request:read',
    description: 'Read data-protection requests',
    scopes: ['organization'],
  },
  {
    code: 'compliance:data_request:process',
    description: 'Receive and process data-protection requests',
    scopes: ['organization'],
  },
]);

const id = z.string().uuid();
export const DataRequestReceived = defineEvent({
  type: 'compliance.data_request.received',
  version: 1,
  schema: z.strictObject({
    request_id: id,
    request_type: z.enum(['access', 'erasure']),
    subject_type: z.enum(['user']),
    subject_id: id,
  }),
});
export const DataRequestModuleCompleted = defineEvent({
  type: 'compliance.data_request.module_completed',
  version: 1,
  schema: z.strictObject({ request_id: id, module: z.string() }),
});
export const DataRequestCompleted = defineEvent({
  type: 'compliance.data_request.completed',
  version: 1,
  schema: z.strictObject({ request_id: id }),
});

/**
 * Modules that hold personal data about a subject type declare themselves here; a data request
 * completes only when every participant reports completion (E-34).
 */
const participants = new Map<string, Set<string>>();
export function declareDataSubjectParticipant(
  module: string,
  subjectTypes: readonly string[],
): void {
  for (const type of subjectTypes) {
    const set = participants.get(type) ?? new Set<string>();
    set.add(module);
    participants.set(type, set);
  }
}
export function dataSubjectParticipants(subjectType: string): string[] {
  return [...(participants.get(subjectType) ?? [])].sort();
}
