import { defineEvent, z } from '../../../kernel/public.js';
import { definePermissions } from '../../iam/public/permissions.js';

/** P3 public interface: permissions, events, and the registries that other modules extend (F-15). */
export const WORKFLOW_PERMISSIONS = definePermissions([
  {
    code: 'workflow:definition:read',
    description: 'Read workflow definitions',
    scopes: ['organization'],
  },
  {
    code: 'workflow:definition:manage',
    description: 'Create and publish workflow definitions',
    scopes: ['organization'],
  },
  {
    code: 'workflow:instance:start',
    description: 'Start workflow instances',
    scopes: ['organization', 'property'],
  },
  {
    code: 'workflow:instance:read',
    description: 'Read workflow instances and their execution history',
    scopes: ['organization', 'property'],
  },
  {
    code: 'workflow:instance:cancel',
    description: 'Cancel workflow instances',
    scopes: ['organization', 'property'],
  },
  {
    code: 'workflow:approval:read',
    description: 'Read approval requests',
    scopes: ['organization', 'property'],
  },
  {
    code: 'workflow:approval:decide',
    description: 'Approve or reject approval requests',
    scopes: ['organization', 'property', 'department'],
  },
  {
    code: 'workflow:scheduled_task:manage',
    description: 'Create and pause scheduled tasks',
    scopes: ['organization'],
  },
  {
    code: 'workflow:dead_letter:read',
    description: 'Read events that could not be processed',
    scopes: ['organization'],
  },
  {
    code: 'workflow:dead_letter:replay',
    description: 'Replay dead-lettered events (audited)',
    scopes: ['organization'],
  },
]);

const id = z.string().uuid();
export const WorkflowInstanceStarted = defineEvent({
  type: 'workflow.instance.started',
  version: 1,
  schema: z.strictObject({ instance_id: id, definition_code: z.string() }),
});
export const WorkflowInstanceCompleted = defineEvent({
  type: 'workflow.instance.completed',
  version: 1,
  schema: z.strictObject({ instance_id: id }),
});
export const WorkflowInstanceFailed = defineEvent({
  type: 'workflow.instance.failed',
  version: 1,
  schema: z.strictObject({ instance_id: id, error: z.string() }),
});
export const ApprovalRequested = defineEvent({
  type: 'workflow.approval.requested',
  version: 1,
  schema: z.strictObject({ approval_id: id, instance_id: id, approval_type: z.string() }),
});
export const ApprovalApproved = defineEvent({
  type: 'workflow.approval.approved',
  version: 1,
  schema: z.strictObject({ approval_id: id, instance_id: id }),
});
export const ApprovalRejected = defineEvent({
  type: 'workflow.approval.rejected',
  version: 1,
  schema: z.strictObject({ approval_id: id, instance_id: id }),
});

/**
 * Workflow actions: steps call module public interfaces through registered actions, never module
 * tables (map P3 "Does not own"). Each action declares the permission it needs; the engine checks
 * it against the INITIATOR's grants at execution time (permission boundary, G6), and runs the
 * action under the initiator's grants so the called module authorizes again (F-16).
 */
export interface WorkflowAction {
  readonly name: string;
  readonly permission: string;
  /** `operationId` is deterministic per instance, step and attempt (E-03): actions must be idempotent on it. */
  run(input: unknown, operationId: string): Promise<Record<string, unknown>>;
}

const actions = new Map<string, WorkflowAction>();
export function defineWorkflowAction(action: WorkflowAction): WorkflowAction {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(action.name))
    throw new Error(`invalid workflow action name ${action.name}`);
  if (actions.has(action.name) && actions.get(action.name) !== action)
    throw new Error(`workflow action ${action.name} defined twice`);
  actions.set(action.name, action);
  return action;
}
export function workflowAction(name: string): WorkflowAction | undefined {
  return actions.get(name);
}

/** Approval types: each names the permission required to decide (scoped per approval type). */
const approvalTypes = new Map<string, { readonly permission: string }>();
export function defineApprovalType(name: string, permission = 'workflow:approval:decide'): void {
  approvalTypes.set(name, { permission });
}
export function approvalType(name: string): { readonly permission: string } | undefined {
  return approvalTypes.get(name);
}
defineApprovalType('general');

export const StepSchema = z.discriminatedUnion('type', [
  z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    type: z.literal('action'),
    action: z.string().max(64),
    retry: z
      .strictObject({
        max_attempts: z.number().int().min(1).max(10),
        backoff_seconds: z.number().int().min(1).max(3600),
      })
      .default({ max_attempts: 3, backoff_seconds: 5 }),
  }),
  z.strictObject({
    key: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    type: z.literal('approval'),
    approval_type: z.string().max(64),
  }),
]);
export type WorkflowStep = z.infer<typeof StepSchema>;
