import type pg from 'pg';
import type { AppConfig } from '../../config/app-config.js';
import {
  defineSubscription,
  registeredSubscriptions,
  type Subscription,
} from '../../kernel/outbox/subscriptions.js';
import { PostgresQueue } from '../../kernel/queue/queue.js';
import { errorFields } from '../../kernel/public.js';
import { createRequestContext } from '../../kernel/context/context-factory.js';
import { runWithContext } from '../../kernel/context/context-store.js';
import {
  definePlatformIdentity,
  PrincipalGrants,
  runWithGrants,
} from '../../modules/iam/public/index.js';

/** The P5 retention job identity (cell machine identity). */
export const DOCUMENT_RETENTION = definePlatformIdentity('documents.retention', []);
import {
  WORKFLOW_MANIFEST,
  type WorkflowTables,
} from '../../modules/workflow/workflow.manifest.js';
import { PlatformServices } from '../platform-services.js';
import { ConsumerRuntime, type ConsumerRuntimeOptions } from './consumer-runtime.js';
import { OutboxRelay } from './outbox-relay.js';
import { WorkflowRunner } from './workflow-runner.js';

/**
 * Permissions GRANTED to each platform consumer identity (CX-12). A consumer whose declared
 * permissions are not all granted here is denied on every event (H-JOB-05).
 */
export const CONSUMER_GRANTS: Readonly<Record<string, readonly string[]>> = {
  'workflow.triggers': ['workflow:instance:start'],
  'configuration.property_provisioned': ['config:property:change'],
  'iam.data_request_erasure': ['iam:user:manage'],
  'security.data_request_completion': ['compliance:data_request:process'],
};

/** The worker process: outbox relay, queue consumers, workflow runner and scheduler. */
export class WorkerRuntime {
  readonly services: PlatformServices;
  readonly relayPool: pg.Pool;
  readonly queue: PostgresQueue;
  readonly relay: OutboxRelay;
  readonly consumers: ConsumerRuntime;
  readonly workflowRunner: WorkflowRunner;
  private running = false;
  private loops: Promise<void>[] = [];

  constructor(
    config: AppConfig,
    grants: Readonly<Record<string, readonly string[]>> = CONSUMER_GRANTS,
    consumerOptions: Partial<ConsumerRuntimeOptions> = {},
  ) {
    this.services = new PlatformServices(config, 'worker');
    this.relayPool = this.services.openPool(config.database.relayUrl ?? '', 'relay', 4);
    this.queue = new PostgresQueue(this.relayPool);
    this.relay = new OutboxRelay(
      this.relayPool,
      this.queue,
      this.services.logger.child('relay'),
      this.services.metrics,
    );
    this.consumers = new ConsumerRuntime(
      this.queue,
      this.relayPool,
      this.services.tenantDb,
      this.services.tenantLookup,
      this.services.logger.child('consumers'),
      this.services.metrics,
      {
        visibilityMs: 30_000,
        defaultMaxReceives: 5,
        backoffBaseMs: 1_000,
        backoffCapMs: 300_000,
        ...consumerOptions,
      },
      grants,
      (ctx, permission) => this.services.authorization.recordDenial(ctx, permission, {}),
    );
    this.workflowRunner = new WorkflowRunner(
      this.relayPool,
      this.services.workflow,
      this.services.authorization,
      this.services.logger.child('workflow'),
      this.services.metrics,
    );
    registerPlatformSubscriptions(this.services);
  }

  /** One deterministic pass of every background duty (tests and the loop use it). */
  async tick(): Promise<{ relayed: number; handled: number; steps: number; scheduled: number }> {
    const relayed = (await this.relay.relayBatch()) + (await this.relay.replayBatch());
    let handled = 0;
    for (const subscription of registeredSubscriptions())
      handled += (await this.consumers.poll(subscription)).length;
    const scheduled = await this.workflowRunner.runDueScheduledTasks();
    const steps = await this.workflowRunner.runDueInstances();
    await this.runDocumentRetention();
    await this.recordGauges();
    return { relayed, handled, steps, scheduled };
  }

  /**
   * Document retention (P5; E-17, E-33, CX-13): the relay lists expired documents across tenants;
   * each is deleted in its own tenant transaction under the retention identity, audited.
   */
  async runDocumentRetention(limit = 100): Promise<number> {
    const due = await this.relayPool.query<{ id: string; organization_id: string }>(
      "SELECT id, organization_id FROM app.doc_document WHERE status = 'active' AND retention_until IS NOT NULL AND retention_until <= now() ORDER BY retention_until LIMIT $1",
      [limit],
    );
    let expired = 0;
    for (const document of due.rows) {
      const context = createRequestContext({
        entryPoint: 'scheduled_task',
        actor: { id: DOCUMENT_RETENTION.id, realm: 'machine', kind: 'service_identity' },
        organizationId: document.organization_id,
        properties: { kind: 'all_in_organization' },
      });
      try {
        const done = await runWithContext(context, () =>
          runWithGrants(
            new PrincipalGrants(document.organization_id, DOCUMENT_RETENTION.id, []),
            () => this.services.documents.expire(document.id),
          ),
        );
        if (done) expired += 1;
      } catch (error) {
        this.services.metrics.increment('hos_retention_failures_total', {});
        this.services.logger.error('document_retention_failed', errorFields(error));
      }
    }
    if (expired > 0) this.services.metrics.increment('hos_documents_expired_total', {}, expired);
    return expired;
  }

  /** Background job monitoring (P6): queue depth, outbox lag. */
  async recordGauges(): Promise<void> {
    try {
      const lag = await this.relay.lag();
      this.services.metrics.set('hos_outbox_pending', {}, lag.pending);
      this.services.metrics.set('hos_outbox_oldest_seconds', {}, lag.oldestSeconds);
      for (const subscription of registeredSubscriptions()) {
        this.services.metrics.set(
          'hos_queue_depth',
          { queue: subscription.name },
          await this.queue.depth(subscription.name),
        );
      }
      this.services.metrics.set(
        'hos_worker_last_tick_timestamp_seconds',
        {},
        Math.floor(Date.now() / 1000),
      );
    } catch (error) {
      this.services.logger.warn('worker_gauges_failed', errorFields(error));
    }
  }

  start(intervalMs = 500): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      while (this.running) {
        const result = await this.tick().catch((error: unknown) => {
          this.services.logger.error('worker_tick_failed', errorFields(error));
          return { relayed: 0, handled: 0, steps: 0, scheduled: 0 };
        });
        const busy = result.relayed + result.handled + result.steps + result.scheduled > 0;
        if (!busy) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    };
    this.loops.push(loop());
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.loops);
    this.loops = [];
    await this.services.close();
  }
}

/** Subscriptions of the platform modules, wired to their services. */
export function registerPlatformSubscriptions(services: PlatformServices): readonly Subscription[] {
  return [
    defineSubscription<WorkflowTables>({
      name: 'workflow.triggers',
      manifest: WORKFLOW_MANIFEST,
      events: [],
      allEvents: true,
      permissions: ['workflow:instance:start'],
      handle: async (envelope, tx) => {
        await services.workflow.handleTrigger(envelope, tx);
      },
    }),
    ...services.moduleSubscriptions(),
  ];
}
