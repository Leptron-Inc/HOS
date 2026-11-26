import { defineEvent, z } from '../../../kernel/public.js';

/** P2 events (module map P2, proposed names). Payloads carry IDs and states, no personal data. */
export const UserCreated = defineEvent({
  type: 'iam.user.created',
  version: 1,
  schema: z.strictObject({
    user_id: z.string().uuid(),
    kind: z.enum(['user', 'service_identity']),
    realm: z.enum(['hotel_employee', 'guest', 'machine']),
  }),
});
export const UserStatusChanged = defineEvent({
  type: 'iam.user.status_changed',
  version: 1,
  schema: z.strictObject({
    user_id: z.string().uuid(),
    status: z.enum(['active', 'inactive']),
    version: z.number().int(),
  }),
});
export const UserSessionsRevoked = defineEvent({
  type: 'iam.user.sessions_revoked',
  version: 1,
  schema: z.strictObject({ user_id: z.string().uuid() }),
});
export const RoleChanged = defineEvent({
  type: 'iam.role.changed',
  version: 1,
  schema: z.strictObject({ role_id: z.string().uuid(), version: z.number().int() }),
});
export const RoleAssignmentChanged = defineEvent({
  type: 'iam.role_assignment.changed',
  version: 1,
  schema: z.strictObject({
    assignment_id: z.string().uuid(),
    user_id: z.string().uuid(),
    status: z.enum(['active', 'revoked']),
    version: z.number().int(),
  }),
});
