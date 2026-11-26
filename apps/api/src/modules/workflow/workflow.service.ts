import {
  appendAudit,
  currentContext,
  etag,
  NotFoundError,
  pageLimit,
  publishEvent,
  StateConflictError,
  uuidv5,
  uuidv7,
  ValidationError,
  VersionConflictError,
  type IdempotencyStore,
  type IdempotentRequest,
  type Selectable,
  type TenantDatabase,
  type TenantTx,
  type WriteResult,
  listDeadLetters,
  requestDeadLetterReplay,
  type DeadLetterView,
  type EventEnvelope,
} from '../../kernel/public.js';
import { requirePermission } from '../iam/public/authorizer.js';
import { WORKFLOW_MANIFEST, type WorkflowTables } from './workflow.manifest.js';
import {
  ApprovalApproved,
  ApprovalRejected,
  ApprovalRequested,
  approvalType,
  StepSchema,
  workflowAction,
  WorkflowInstanceCompleted,
  WorkflowInstanceFailed,
  WorkflowInstanceStarted,
  type WorkflowStep,
} from './public/contracts.js';
import { z } from '../../kernel/public.js';

type Tx = TenantTx<WorkflowTables>;
type InstanceRow = Selectable<WorkflowTables['app.wf_instance']>;
const OPERATION_NAMESPACE = '5d1c7e3a-9b2f-4a6e-8c0d-1e2f3a4b5c6d';

export interface DefinitionView {
  readonly id: string;
  readonly code: string;
  readonly definition_version: number;
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
  readonly trigger_event: string | null;
  readonly status: string;
  readonly version: number;
}
export interface InstanceView {
  readonly id: string;
  readonly definition_id: string;
  readonly property_id: string | null;
  readonly state: string;
  readonly current_step: number;
  readonly attempt: number;
  readonly last_error: string | null;
  readonly outputs: unknown;
  readonly version: number;
}
export interface ApprovalView {
  readonly id: string;
  readonly instance_id: string;
  readonly property_id: string | null;
  readonly step_key: string;
  readonly approval_type: string;
  readonly status: string;
  readonly version: number;
}

const instanceView = (r: InstanceRow): InstanceView => ({
  id: r.id,
  definition_id: r.definition_id,
  property_id: r.property_id,
  state: r.state,
  current_step: r.current_step,
  attempt: r.attempt,
  last_error: r.last_error,
  outputs: r.outputs,
  version: r.version,
});

/** A claimed step, handed to the runner to execute outside any transaction (B-21, B-24). */
export interface ClaimedStep {
  readonly instanceId: string;
  readonly propertyId: string | null;
  readonly stepIndex: number;
  readonly attempt: number;
  readonly step: WorkflowStep & { type: 'action' };
  readonly input: unknown;
  readonly initiator: {
    readonly id: string;
    readonly realm: 'hotel_employee' | 'guest' | 'machine';
    readonly kind: 'user' | 'service_identity' | 'support_session';
  };
  readonly operationId: string;
}

/**
 * P3 workflow services (module map P3; technical architecture §5: database state machines).
 * Workflows call module public interfaces through registered actions and never write module
 * tables. Every state change is recorded in the execution history and audited.
 */
export class WorkflowService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly idempotency: IdempotencyStore,
    private readonly leaseMs = 60_000,
  ) {}

  // ---------- Definitions ----------

  async createDefinition(
    input: { code: string; name: string; steps: unknown; trigger_event: string | null },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('workflow:definition:manage');
    const steps = z.array(StepSchema).min(1).max(50).safeParse(input.steps);
    if (!steps.success)
      throw new ValidationError([{ path: 'steps', message: 'invalid step list' }]);
    const keys = new Set<string>();
    for (const step of steps.data) {
      if (keys.has(step.key))
        throw new ValidationError([{ path: 'steps', message: `duplicate step key ${step.key}` }]);
      keys.add(step.key);
      if (step.type === 'action' && workflowAction(step.action) === undefined)
        throw new ValidationError([{ path: 'steps', message: `unknown action ${step.action}` }]);
      if (step.type === 'approval' && approvalType(step.approval_type) === undefined)
        throw new ValidationError([
          { path: 'steps', message: `unknown approval type ${step.approval_type}` },
        ]);
    }
    const ctx = currentContext();
    return this.db.transaction<WorkflowTables, WriteResult>(WORKFLOW_MANIFEST, (tx) =>
      this.idempotency.run(tx, WORKFLOW_MANIFEST, request, async () => {
        const latest = await tx.db
          .selectFrom('app.wf_definition')
          .select((eb) => eb.fn.max('definition_version').as('v'))
          .where('organization_id', '=', ctx.tenant.organizationId)
          .where('code', '=', input.code)
          .executeTakeFirst();
        const definitionVersion = Number(latest?.v ?? 0) + 1;
        const id = uuidv7();
        await tx.db
          .insertInto('app.wf_definition')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            code: input.code,
            definition_version: definitionVersion,
            name: input.name,
            steps: JSON.stringify(steps.data),
            trigger_event: input.trigger_event,
            status: 'draft',
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .execute();
        await this.audit(
          tx,
          'app.wf_definition',
          'workflow.definition.created',
          'workflow_definition',
          id,
          1,
          null,
          {
            code: { after: input.code },
            definition_version: { after: definitionVersion },
            steps: { after: steps.data },
            trigger_event: { after: input.trigger_event },
          },
        );
        return {
          status: 201,
          headers: { etag: etag(1) },
          body: {
            id,
            code: input.code,
            definition_version: definitionVersion,
            name: input.name,
            steps: steps.data,
            trigger_event: input.trigger_event,
            status: 'draft',
            version: 1,
          },
        };
      }),
    );
  }

  /** Published definitions are immutable: a change is a new definition version (D-012 style). */
  async publishDefinition(definitionId: string, expectedVersion: number): Promise<DefinitionView> {
    requirePermission('workflow:definition:manage');
    const ctx = currentContext();
    return this.db.transaction<WorkflowTables, DefinitionView>(WORKFLOW_MANIFEST, async (tx) => {
      const current = await tx.db
        .selectFrom('app.wf_definition')
        .selectAll()
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', definitionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError();
      if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
      if (current.status !== 'draft') throw new StateConflictError('workflow.definition_not_draft');
      const updated = await tx.db
        .updateTable('app.wf_definition')
        .set({
          status: 'published',
          version: current.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', definitionId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(
        tx,
        'app.wf_definition',
        'workflow.definition.published',
        'workflow_definition',
        definitionId,
        updated.version,
        null,
        { status: { before: 'draft', after: 'published' } },
      );
      return {
        id: updated.id,
        code: updated.code,
        definition_version: updated.definition_version,
        name: updated.name,
        steps: updated.steps as WorkflowStep[],
        trigger_event: updated.trigger_event,
        status: updated.status,
        version: updated.version,
      };
    });
  }

  async listDefinitions(): Promise<DefinitionView[]> {
    requirePermission('workflow:definition:read');
    return this.db.transaction<WorkflowTables, DefinitionView[]>(WORKFLOW_MANIFEST, async (tx) =>
      (
        await tx.db
          .selectFrom('app.wf_definition')
          .selectAll()
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .orderBy('code')
          .orderBy('definition_version')
          .limit(500)
          .execute()
      ).map((d) => ({
        id: d.id,
        code: d.code,
        definition_version: d.definition_version,
        name: d.name,
        steps: d.steps as WorkflowStep[],
        trigger_event: d.trigger_event,
        status: d.status,
        version: d.version,
      })),
    );
  }

  // ---------- Instances ----------

  async startInstance(
    input: { definitionCode: string; propertyId: string | null; input: unknown },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('workflow:instance:start', { propertyId: input.propertyId });
    return this.db.transaction<WorkflowTables, WriteResult>(WORKFLOW_MANIFEST, (tx) =>
      this.idempotency.run(tx, WORKFLOW_MANIFEST, request, async () => {
        const instance = await this.createInstance(
          tx,
          input.definitionCode,
          input.propertyId,
          input.input,
          tx.context.actor,
        );
        return { status: 201, headers: { etag: etag(instance.version) }, body: instance };
      }),
    );
  }

  async getInstance(instanceId: string): Promise<{ instance: InstanceView; history: unknown[] }> {
    return this.db.transaction<WorkflowTables, { instance: InstanceView; history: unknown[] }>(
      WORKFLOW_MANIFEST,
      async (tx) => {
        const row = await tx.db
          .selectFrom('app.wf_instance')
          .selectAll()
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .where('id', '=', instanceId)
          .executeTakeFirst();
        if (row === undefined) throw new NotFoundError();
        requirePermission('workflow:instance:read', { propertyId: row.property_id });
        const history = await tx.db
          .selectFrom('app.wf_step_execution')
          .select([
            'step_index',
            'step_key',
            'attempt',
            'outcome',
            'error_code',
            'actor_id',
            'on_behalf_of_id',
            'correlation_id',
            'recorded_at',
          ])
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .where('instance_id', '=', instanceId)
          .orderBy('recorded_at')
          .orderBy('id')
          .limit(1000)
          .execute();
        return { instance: instanceView(row), history };
      },
    );
  }

  async cancelInstance(instanceId: string, expectedVersion: number): Promise<InstanceView> {
    const ctx = currentContext();
    return this.db.transaction<WorkflowTables, InstanceView>(WORKFLOW_MANIFEST, async (tx) => {
      const row = await this.lockInstance(tx, instanceId);
      requirePermission('workflow:instance:cancel', { propertyId: row.property_id });
      if (row.version !== expectedVersion) throw new VersionConflictError(row.version);
      if (['completed', 'failed', 'cancelled'].includes(row.state))
        throw new StateConflictError('workflow.instance_finished');
      const updated = await this.updateInstance(tx, row, {
        state: 'cancelled',
        next_run_at: null,
        lease_until: null,
      });
      await tx.db
        .updateTable('app.wf_approval_request')
        .set((eb) => ({
          status: 'cancelled',
          version: eb('version', '+', 1),
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        }))
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('instance_id', '=', instanceId)
        .where('status', '=', 'pending')
        .execute();
      await this.history(tx, row, row.current_step, 'cancelled', 'cancelled', null);
      await this.audit(
        tx,
        'app.wf_instance',
        'workflow.instance.cancelled',
        'workflow_instance',
        instanceId,
        updated.version,
        row.property_id,
        { state: { before: row.state, after: 'cancelled' } },
      );
      return instanceView(updated);
    });
  }

  // ---------- Engine (called by the worker runner under the engine identity) ----------

  /** Claims the instance's current step under a lease. Approval steps are resolved here. */
  async claimStep(instanceId: string): Promise<ClaimedStep | null> {
    return this.db.transaction<WorkflowTables, ClaimedStep | null>(
      WORKFLOW_MANIFEST,
      async (tx) => {
        const row = await tx.db
          .selectFrom('app.wf_instance')
          .selectAll()
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .where('id', '=', instanceId)
          .where('state', 'in', ['pending', 'running'])
          .where('next_run_at', '<=', new Date())
          .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<', new Date())]))
          .forUpdate()
          .skipLocked()
          .executeTakeFirst();
        if (row === undefined) return null;
        const steps = await this.steps(tx, row.definition_id);
        const step = steps[row.current_step];
        if (step === undefined) {
          await this.finish(tx, row, 'completed', null);
          return null;
        }
        if (step.type === 'approval') {
          const approvalId = uuidv7();
          await tx.db
            .insertInto('app.wf_approval_request')
            .values({
              id: approvalId,
              organization_id: row.organization_id,
              instance_id: row.id,
              property_id: row.property_id,
              step_key: step.key,
              approval_type: step.approval_type,
              status: 'pending',
              created_by: tx.context.actor.id,
              updated_by: tx.context.actor.id,
            })
            .execute();
          await this.updateInstance(tx, row, {
            state: 'waiting_approval',
            next_run_at: null,
            lease_until: null,
          });
          await this.history(tx, row, row.current_step, step.key, 'waiting_approval', null, 1);
          await publishEvent(
            tx,
            ApprovalRequested,
            { approval_id: approvalId, instance_id: row.id, approval_type: step.approval_type },
            { propertyId: row.property_id },
          );
          return null;
        }
        const attempt = row.attempt + 1;
        await this.updateInstance(tx, row, {
          state: 'running',
          attempt,
          lease_until: new Date(Date.now() + this.leaseMs),
        });
        await this.history(tx, row, row.current_step, step.key, 'started', null, attempt);
        return {
          instanceId: row.id,
          propertyId: row.property_id,
          stepIndex: row.current_step,
          attempt,
          step,
          input: row.input,
          initiator: { id: row.initiated_by, realm: row.initiated_realm, kind: row.initiated_kind },
          operationId: uuidv5(OPERATION_NAMESPACE, `${row.id}/${row.current_step}/${attempt}`),
        };
      },
    );
  }

  /** Records the outcome of a claimed action step: advance, retry with backoff, or fail. */
  async recordOutcome(
    claim: ClaimedStep,
    outcome:
      | { ok: true; output: Record<string, unknown> }
      | { ok: false; error: string; retryable: boolean },
  ): Promise<void> {
    await this.db.transaction<WorkflowTables, void>(WORKFLOW_MANIFEST, async (tx) => {
      const row = await this.lockInstance(tx, claim.instanceId);
      if (
        row.state !== 'running' ||
        row.current_step !== claim.stepIndex ||
        row.attempt !== claim.attempt
      )
        return; // superseded
      if (outcome.ok) {
        const outputs = {
          ...((row.outputs as Record<string, unknown> | null) ?? {}),
          [claim.step.key]: outcome.output,
        };
        const steps = await this.steps(tx, row.definition_id);
        await this.history(
          tx,
          row,
          claim.stepIndex,
          claim.step.key,
          'succeeded',
          null,
          claim.attempt,
        );
        const advanced = await this.updateInstance(tx, row, {
          outputs: JSON.stringify(outputs),
          current_step: claim.stepIndex + 1,
          attempt: 0,
          next_run_at: new Date(),
          lease_until: null,
        });
        if (claim.stepIndex + 1 >= steps.length) await this.finish(tx, advanced, 'completed', null);
        return;
      }
      const retry = outcome.retryable && claim.attempt < claim.step.retry.max_attempts;
      await this.history(
        tx,
        row,
        claim.stepIndex,
        claim.step.key,
        retry ? 'retrying' : outcome.error === 'workflow.permission_denied' ? 'denied' : 'failed',
        outcome.error,
        claim.attempt,
      );
      if (retry) {
        const delayMs = claim.step.retry.backoff_seconds * 1000 * 2 ** (claim.attempt - 1);
        await this.updateInstance(tx, row, {
          state: 'running',
          next_run_at: new Date(Date.now() + delayMs),
          lease_until: null,
          last_error: outcome.error,
        });
      } else {
        await this.finish(tx, row, 'failed', outcome.error);
      }
    });
  }

  // ---------- Approvals ----------

  async listApprovals(
    status: 'pending' | 'approved' | 'rejected' | 'cancelled' | undefined,
    limitRaw: string | undefined,
  ): Promise<ApprovalView[]> {
    const limit = pageLimit(limitRaw);
    return this.db.transaction<WorkflowTables, ApprovalView[]>(WORKFLOW_MANIFEST, async (tx) => {
      let query = tx.db
        .selectFrom('app.wf_approval_request')
        .selectAll()
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .orderBy('requested_at')
        .orderBy('id')
        .limit(limit);
      if (status !== undefined) query = query.where('status', '=', status);
      const rows = await query.execute();
      const visible = rows.filter((r) => {
        try {
          requirePermission('workflow:approval:read', { propertyId: r.property_id });
          return true;
        } catch {
          return false;
        }
      });
      return visible.map((r) => ({
        id: r.id,
        instance_id: r.instance_id,
        property_id: r.property_id,
        step_key: r.step_key,
        approval_type: r.approval_type,
        status: r.status,
        version: r.version,
      }));
    });
  }

  /** Decides an approval; the permission is the approval type's, in the instance's property scope. */
  async decide(
    approvalId: string,
    expectedVersion: number,
    decision: 'approve' | 'reject',
  ): Promise<ApprovalView> {
    const ctx = currentContext();
    return this.db.transaction<WorkflowTables, ApprovalView>(WORKFLOW_MANIFEST, async (tx) => {
      const approval = await tx.db
        .selectFrom('app.wf_approval_request')
        .selectAll()
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', approvalId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (approval === undefined) throw new NotFoundError();
      requirePermission(
        approvalType(approval.approval_type)?.permission ?? 'workflow:approval:decide',
        { propertyId: approval.property_id },
      );
      if (approval.version !== expectedVersion) throw new VersionConflictError(approval.version);
      if (approval.status !== 'pending')
        throw new StateConflictError('workflow.approval_not_pending');
      const status = decision === 'approve' ? 'approved' : 'rejected';
      const updated = await tx.db
        .updateTable('app.wf_approval_request')
        .set({
          status,
          decided_by: ctx.actor.id,
          decided_at: new Date(),
          version: approval.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', approvalId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      const instance = await this.lockInstance(tx, approval.instance_id);
      await this.history(tx, instance, instance.current_step, approval.step_key, status, null, 1);
      await this.audit(
        tx,
        'app.wf_approval_request',
        `workflow.approval.${status}`,
        'approval_request',
        approvalId,
        updated.version,
        approval.property_id,
        { status: { before: 'pending', after: status } },
      );
      if (status === 'approved') {
        await publishEvent(
          tx,
          ApprovalApproved,
          { approval_id: approvalId, instance_id: instance.id },
          { propertyId: approval.property_id },
        );
        const steps = await this.steps(tx, instance.definition_id);
        const advanced = await this.updateInstance(tx, instance, {
          state: 'running',
          current_step: instance.current_step + 1,
          attempt: 0,
          next_run_at: new Date(),
          lease_until: null,
        });
        if (instance.current_step + 1 >= steps.length)
          await this.finish(tx, advanced, 'completed', null);
      } else {
        await publishEvent(
          tx,
          ApprovalRejected,
          { approval_id: approvalId, instance_id: instance.id },
          { propertyId: approval.property_id },
        );
        await this.finish(tx, instance, 'failed', 'workflow.approval_rejected');
      }
      return {
        id: updated.id,
        instance_id: updated.instance_id,
        property_id: updated.property_id,
        step_key: updated.step_key,
        approval_type: updated.approval_type,
        status: updated.status,
        version: updated.version,
      };
    });
  }

  // ---------- Scheduled tasks and triggers ----------

  async createScheduledTask(
    input: {
      code: string;
      definitionCode: string;
      intervalSeconds: number;
      propertyId: string | null;
      input: unknown;
    },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('workflow:scheduled_task:manage');
    const ctx = currentContext();
    return this.db.transaction<WorkflowTables, WriteResult>(WORKFLOW_MANIFEST, (tx) =>
      this.idempotency.run(tx, WORKFLOW_MANIFEST, request, async () => {
        const id = uuidv7();
        const nextRunAt = new Date(Date.now() + input.intervalSeconds * 1000);
        await tx.db
          .insertInto('app.wf_scheduled_task')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            property_id: input.propertyId,
            code: input.code,
            definition_code: input.definitionCode,
            interval_seconds: input.intervalSeconds,
            input: JSON.stringify(input.input ?? {}),
            next_run_at: nextRunAt,
            status: 'active',
            owner_id: ctx.actor.id,
            owner_realm: ctx.actor.realm,
            owner_kind: ctx.actor.kind,
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .execute();
        await this.audit(
          tx,
          'app.wf_scheduled_task',
          'workflow.scheduled_task.created',
          'scheduled_task',
          id,
          1,
          input.propertyId,
          {
            code: { after: input.code },
            definition_code: { after: input.definitionCode },
            interval_seconds: { after: input.intervalSeconds },
          },
        );
        return {
          status: 201,
          headers: { etag: etag(1) },
          body: {
            id,
            code: input.code,
            next_run_at: nextRunAt.toISOString(),
            status: 'active',
            version: 1,
          },
        };
      }),
    );
  }

  /** Runs a due scheduled task (scheduler identity): starts an instance on behalf of the task owner. */
  async runScheduledTask(taskId: string): Promise<string | null> {
    return this.db.transaction<WorkflowTables, string | null>(WORKFLOW_MANIFEST, async (tx) => {
      const task = await tx.db
        .selectFrom('app.wf_scheduled_task')
        .selectAll()
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .where('id', '=', taskId)
        .where('status', '=', 'active')
        .where('next_run_at', '<=', new Date())
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (task === undefined) return null;
      const instance = await this.createInstance(
        tx,
        task.definition_code,
        task.property_id,
        task.input,
        { id: task.owner_id, realm: task.owner_realm, kind: task.owner_kind },
      );
      let next = task.next_run_at.getTime() + task.interval_seconds * 1000;
      if (next <= Date.now()) next = Date.now() + task.interval_seconds * 1000; // never a burst of catch-up runs
      await tx.db
        .updateTable('app.wf_scheduled_task')
        .set({
          next_run_at: new Date(next),
          last_run_at: new Date(),
          version: task.version + 1,
          updated_at: new Date(),
          updated_by: tx.context.actor.id,
        })
        .where('organization_id', '=', task.organization_id)
        .where('id', '=', task.id)
        .where('version', '=', task.version)
        .execute();
      return instance.id;
    });
  }

  /** Trigger consumer handler: starts instances of published definitions whose trigger matches. */
  async handleTrigger(envelope: EventEnvelope, tx: Tx): Promise<number> {
    if (envelope.type.startsWith('workflow.')) return 0;
    const definitions = await tx.db
      .selectFrom('app.wf_definition')
      .select(['code'])
      .distinct()
      .where('organization_id', '=', envelope.organization_id)
      .where('trigger_event', '=', envelope.type)
      .where('status', '=', 'published')
      .limit(50)
      .execute();
    for (const definition of definitions) {
      await this.createInstance(
        tx,
        definition.code,
        envelope.property_id,
        { event_id: envelope.event_id, payload: envelope.payload },
        envelope.actor,
      );
    }
    return definitions.length;
  }

  // ---------- Dead letters (P3: replay is audited) ----------

  async deadLetters(
    status: DeadLetterView['status'] | null,
    limitRaw: string | undefined,
    after: string | null,
  ): Promise<DeadLetterView[]> {
    requirePermission('workflow:dead_letter:read');
    return this.db.transaction<WorkflowTables, DeadLetterView[]>(WORKFLOW_MANIFEST, (tx) =>
      listDeadLetters(tx, status, pageLimit(limitRaw), after),
    );
  }

  async replayDeadLetter(id: string, expectedVersion: number): Promise<DeadLetterView> {
    requirePermission('workflow:dead_letter:replay');
    return this.db.transaction<WorkflowTables, DeadLetterView>(WORKFLOW_MANIFEST, async (tx) => {
      const view = await requestDeadLetterReplay(tx, id, expectedVersion);
      await this.audit(
        tx,
        'dead_letter_replay',
        'workflow.dead_letter.replay_requested',
        'dead_letter',
        id,
        view.version,
        null,
        {
          queue: { after: view.queue },
          event_type: { after: view.event_type },
          status: { before: 'dead', after: view.status },
        },
      );
      return view;
    });
  }

  // ---------- helpers ----------

  private async createInstance(
    tx: Tx,
    definitionCode: string,
    propertyId: string | null,
    input: unknown,
    initiator: {
      id: string;
      realm: 'hotel_employee' | 'guest' | 'machine';
      kind: 'user' | 'service_identity' | 'support_session';
    },
  ): Promise<InstanceView> {
    const definition = await tx.db
      .selectFrom('app.wf_definition')
      .select(['id', 'code'])
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('code', '=', definitionCode)
      .where('status', '=', 'published')
      .orderBy('definition_version', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (definition === undefined) throw new StateConflictError('workflow.definition_not_published');
    const id = uuidv7();
    const row = await tx.db
      .insertInto('app.wf_instance')
      .values({
        id,
        organization_id: tx.context.tenant.organizationId,
        property_id: propertyId,
        definition_id: definition.id,
        state: 'pending',
        next_run_at: new Date(),
        input: JSON.stringify(input ?? {}),
        initiated_by: initiator.id,
        initiated_realm: initiator.realm,
        initiated_kind: initiator.kind,
        created_by: tx.context.actor.id,
        updated_by: tx.context.actor.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit(
      tx,
      'app.wf_instance',
      'workflow.instance.started',
      'workflow_instance',
      id,
      1,
      propertyId,
      {
        definition_id: { after: definition.id },
        state: { after: 'pending' },
        initiated_by: { after: initiator.id },
      },
    );
    await publishEvent(
      tx,
      WorkflowInstanceStarted,
      { instance_id: id, definition_code: definition.code },
      { propertyId },
    );
    return instanceView(row);
  }

  private async finish(
    tx: Tx,
    row: InstanceRow,
    state: 'completed' | 'failed',
    error: string | null,
  ): Promise<void> {
    const updated = await this.updateInstance(tx, row, {
      state,
      next_run_at: null,
      lease_until: null,
      last_error: error,
    });
    await this.audit(
      tx,
      'app.wf_instance',
      `workflow.instance.${state}`,
      'workflow_instance',
      row.id,
      updated.version,
      row.property_id,
      { state: { before: row.state, after: state }, last_error: { after: error } },
    );
    if (state === 'completed')
      await publishEvent(
        tx,
        WorkflowInstanceCompleted,
        { instance_id: row.id },
        { propertyId: row.property_id },
      );
    else
      await publishEvent(
        tx,
        WorkflowInstanceFailed,
        { instance_id: row.id, error: error ?? 'failed' },
        { propertyId: row.property_id },
      );
  }

  private async steps(tx: Tx, definitionId: string): Promise<WorkflowStep[]> {
    const definition = await tx.db
      .selectFrom('app.wf_definition')
      .select('steps')
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('id', '=', definitionId)
      .executeTakeFirstOrThrow();
    return definition.steps as WorkflowStep[];
  }

  private async lockInstance(tx: Tx, id: string): Promise<InstanceRow> {
    const row = await tx.db
      .selectFrom('app.wf_instance')
      .selectAll()
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError();
    return row;
  }

  private async updateInstance(
    tx: Tx,
    row: InstanceRow,
    changes: Partial<{
      state: InstanceRow['state'];
      current_step: number;
      attempt: number;
      next_run_at: Date | null;
      lease_until: Date | null;
      outputs: string;
      last_error: string | null;
    }>,
  ): Promise<InstanceRow> {
    return tx.db
      .updateTable('app.wf_instance')
      .set({
        ...changes,
        version: row.version + 1,
        updated_at: new Date(),
        updated_by: tx.context.actor.id,
      })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  private async history(
    tx: Tx,
    row: InstanceRow,
    stepIndex: number,
    stepKey: string,
    outcome: Selectable<WorkflowTables['app.wf_step_execution']>['outcome'],
    error: string | null,
    attempt = Math.max(1, row.attempt),
  ): Promise<void> {
    await tx.db
      .insertInto('app.wf_step_execution')
      .values({
        id: uuidv7(),
        organization_id: row.organization_id,
        instance_id: row.id,
        step_index: stepIndex,
        step_key: stepKey,
        attempt,
        outcome,
        error_code: error,
        actor_id: tx.context.actor.id,
        on_behalf_of_id: tx.context.onBehalfOf?.id ?? null,
        correlation_id: tx.context.correlationId,
      })
      .execute();
  }

  private audit(
    tx: Tx,
    table: string,
    action: string,
    entityType: string,
    entityId: string,
    version: number | null,
    propertyId: string | null,
    changes: Record<string, { before?: unknown; after?: unknown }>,
  ): Promise<string> {
    return appendAudit(tx, WORKFLOW_MANIFEST, {
      table,
      action,
      entityType,
      entityId,
      entityVersion: version,
      propertyId,
      changes,
    });
  }
}
