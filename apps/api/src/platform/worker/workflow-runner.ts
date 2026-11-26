import type pg from 'pg';
import { createRequestContext, type ContextInput } from '../../kernel/context/context-factory.js';
import { runWithContext } from '../../kernel/context/context-store.js';
import {
  errorFields,
  uuidv7,
  type Logger,
  type MetricsRegistry,
  type RequestContext,
} from '../../kernel/public.js';
import {
  definePlatformIdentity,
  PermissionDeniedError,
  PrincipalGrants,
  runWithGrants,
  type AuthorizationService,
} from '../../modules/iam/public/index.js';
import { workflowAction, type WorkflowService } from '../../modules/workflow/public/index.js';

/** Code-defined identities of the workflow engine and scheduler (map §1.2 cell machine identities). */
export const WORKFLOW_ENGINE = definePlatformIdentity('workflow.engine', []);
export const WORKFLOW_SCHEDULER = definePlatformIdentity('workflow.scheduler', []);

/**
 * Workflow runner and scheduler: trusted entry points for background work (CX-01, CX-13). Due work
 * is listed across tenants by hos_relay (column-level SELECT only); every instance or task is then
 * processed in its own tenant transaction under the engine or scheduler identity. Actions run
 * OUTSIDE any transaction, on behalf of the initiator, after the permission boundary check.
 */
export class WorkflowRunner {
  constructor(
    private readonly relayPool: pg.Pool,
    private readonly workflow: WorkflowService,
    private readonly authorization: AuthorizationService,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry,
  ) {}

  private context(
    organizationId: string,
    actorId: string,
    onBehalfOf: NonNullable<ContextInput['onBehalfOf']> | null,
    propertyId: string | null,
    entryPoint: 'scheduled_task' = 'scheduled_task',
  ): RequestContext {
    return createRequestContext({
      entryPoint,
      actor: { id: actorId, realm: 'machine', kind: 'service_identity' },
      onBehalfOf,
      organizationId,
      properties:
        propertyId !== null
          ? { kind: 'listed', propertyIds: [propertyId] }
          : { kind: 'all_in_organization' },
      requestId: uuidv7(),
    });
  }

  /** Executes due steps; returns the number of steps processed. */
  async runDueInstances(limit = 50): Promise<number> {
    const due = await this.relayPool.query<{ id: string; organization_id: string }>(
      `SELECT id, organization_id FROM app.wf_instance
        WHERE state IN ('pending', 'running') AND next_run_at <= now() AND (lease_until IS NULL OR lease_until < now())
        ORDER BY next_run_at LIMIT $1`,
      [limit],
    );
    let processed = 0;
    for (const item of due.rows) {
      try {
        if (await this.runInstanceStep(item.organization_id, item.id)) processed += 1;
      } catch (error) {
        this.logger.error('workflow_step_failed', { instance_id: item.id, ...errorFields(error) });
      }
    }
    return processed;
  }

  private async runInstanceStep(organizationId: string, instanceId: string): Promise<boolean> {
    const engineGrants = new PrincipalGrants(organizationId, WORKFLOW_ENGINE.id, []);
    const claimContext = this.context(organizationId, WORKFLOW_ENGINE.id, null, null);
    const claim = await runWithContext(claimContext, () =>
      runWithGrants(engineGrants, () => this.workflow.claimStep(instanceId)),
    );
    if (claim === null) return true;
    const started = process.hrtime.bigint();
    const action = workflowAction(claim.step.action);
    const actionContext = this.context(
      organizationId,
      WORKFLOW_ENGINE.id,
      claim.initiator,
      claim.propertyId,
    );
    // Permission boundary (G6): the initiator must hold the action's permission at execution time.
    const evaluation = await this.authorization.evaluate(
      createRequestContext({
        entryPoint: 'scheduled_task',
        actor: claim.initiator,
        organizationId,
        properties: { kind: 'all_in_organization' },
        requestId: uuidv7(),
      }),
    );
    const grants = evaluation?.principal.status === 'active' ? evaluation.grants : undefined;
    let outcome: Parameters<WorkflowService['recordOutcome']>[1];
    if (action === undefined) {
      outcome = { ok: false, error: 'workflow.action_unknown', retryable: false };
    } else if (
      grants === undefined ||
      !grants.allows(action.permission, { propertyId: claim.propertyId })
    ) {
      await this.authorization
        .recordDenial(actionContext, action.permission, { propertyId: claim.propertyId })
        .catch(() => undefined);
      outcome = { ok: false, error: 'workflow.permission_denied', retryable: false };
    } else {
      try {
        const actingGrants = new PrincipalGrants(organizationId, WORKFLOW_ENGINE.id, grants.grants);
        const output = await runWithContext(actionContext, () =>
          runWithGrants(actingGrants, () => action.run(claim.input, claim.operationId)),
        );
        outcome = { ok: true, output };
      } catch (error) {
        if (error instanceof PermissionDeniedError) {
          outcome = { ok: false, error: 'workflow.permission_denied', retryable: false };
        } else {
          this.logger.warn('workflow_action_failed', {
            instance_id: instanceId,
            action: claim.step.action,
            ...errorFields(error),
          });
          outcome = { ok: false, error: 'workflow.action_failed', retryable: true };
        }
      }
    }
    await runWithContext(claimContext, () =>
      runWithGrants(engineGrants, () => this.workflow.recordOutcome(claim, outcome)),
    );
    this.metrics.increment('hos_workflow_steps_total', {
      outcome: outcome.ok ? 'succeeded' : outcome.error,
    });
    this.metrics.observe(
      'hos_workflow_step_duration_seconds',
      {},
      Number(process.hrtime.bigint() - started) / 1e9,
    );
    return true;
  }

  /** Starts instances for due scheduled tasks. */
  async runDueScheduledTasks(limit = 50): Promise<number> {
    const due = await this.relayPool.query<{ id: string; organization_id: string }>(
      "SELECT id, organization_id FROM app.wf_scheduled_task WHERE status = 'active' AND next_run_at <= now() ORDER BY next_run_at LIMIT $1",
      [limit],
    );
    let started = 0;
    for (const task of due.rows) {
      const context = this.context(task.organization_id, WORKFLOW_SCHEDULER.id, null, null);
      try {
        const instance = await runWithContext(context, () =>
          runWithGrants(new PrincipalGrants(task.organization_id, WORKFLOW_SCHEDULER.id, []), () =>
            this.workflow.runScheduledTask(task.id),
          ),
        );
        if (instance !== null) started += 1;
      } catch (error) {
        this.metrics.increment('hos_scheduled_task_failures_total', {});
        this.logger.error('scheduled_task_failed', { task_id: task.id, ...errorFields(error) });
      }
    }
    return started;
  }
}
