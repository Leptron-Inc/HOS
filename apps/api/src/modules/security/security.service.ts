import {
  appendAudit,
  currentContext,
  etag,
  NotFoundError,
  pageLimit,
  publishEvent,
  uuidv7,
  ValidationError,
  type IdempotencyStore,
  type IdempotentRequest,
  type Selectable,
  type TenantDatabase,
  type TenantTx,
  type WriteResult,
  listAuditRecords,
  verifyTenantAuditChain,
  type AuditRecordView,
  type ChainVerification,
} from '../../kernel/public.js';
import { requirePermission } from '../iam/public/authorizer.js';
import { SECURITY_MANIFEST, type SecurityTables } from './security.manifest.js';
import {
  DataRequestCompleted,
  DataRequestReceived,
  dataSubjectParticipants,
} from './public/contracts.js';

type Row = Selectable<SecurityTables['app.sec_data_request']>;
export interface DataRequestView {
  readonly id: string;
  readonly request_type: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly status: string;
  readonly required_modules: readonly string[];
  readonly completed_modules: readonly string[];
  readonly received_at: string;
  readonly completed_at: string | null;
  readonly version: number;
}
const view = (r: Row): DataRequestView => ({
  id: r.id,
  request_type: r.request_type,
  subject_type: r.subject_type,
  subject_id: r.subject_id,
  status: r.status,
  required_modules: r.required_modules,
  completed_modules: r.completed_modules,
  received_at: r.received_at.toISOString(),
  completed_at: r.completed_at?.toISOString() ?? null,
  version: r.version,
});

/**
 * P7 services (module map P7): audit reads and chain verification for the tenant, and
 * data-protection requests (E-34: P7 receives and publishes; owning modules erase and report back).
 * Technical controls only: legal compliance is not claimed (retention values and the legal meaning of
 * data classes need legal input, E-27, E-31).
 */
export class SecurityService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async auditRecords(filters: {
    entityType: string | null;
    entityId: string | null;
    afterSequence: number | null;
    limit?: string | undefined;
  }): Promise<AuditRecordView[]> {
    requirePermission('audit:read');
    return this.db.transaction<SecurityTables, AuditRecordView[]>(SECURITY_MANIFEST, (tx) =>
      listAuditRecords(tx, { ...filters, limit: pageLimit(filters.limit) }),
    );
  }

  async verifyAuditChain(): Promise<ChainVerification> {
    requirePermission('audit:read');
    return this.db.transaction<SecurityTables, ChainVerification>(SECURITY_MANIFEST, (tx) =>
      verifyTenantAuditChain(tx),
    );
  }

  async createDataRequest(
    input: { requestType: 'access' | 'erasure'; subjectType: 'user'; subjectId: string },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('compliance:data_request:process');
    const required = dataSubjectParticipants(input.subjectType);
    if (required.length === 0)
      throw new ValidationError([
        { path: 'subject_type', message: 'no module holds data for this subject type' },
      ]);
    const ctx = currentContext();
    return this.db.transaction<SecurityTables, WriteResult>(SECURITY_MANIFEST, (tx) =>
      this.idempotency.run(tx, SECURITY_MANIFEST, request, async () => {
        const id = uuidv7();
        const row = await tx.db
          .insertInto('app.sec_data_request')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            request_type: input.requestType,
            subject_type: input.subjectType,
            subject_id: input.subjectId,
            status: input.requestType === 'erasure' ? 'processing' : 'received',
            required_modules: required,
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit(tx, id, 1, 'compliance.data_request.received', {
          request_type: { after: input.requestType },
          subject_type: { after: input.subjectType },
          subject_id: { after: input.subjectId },
          status: { after: row.status },
        });
        await publishEvent(tx, DataRequestReceived, {
          request_id: id,
          request_type: input.requestType,
          subject_type: input.subjectType,
          subject_id: input.subjectId,
        });
        return { status: 201, headers: { etag: etag(1) }, body: view(row) };
      }),
    );
  }

  async getDataRequest(id: string): Promise<DataRequestView> {
    requirePermission('compliance:data_request:read');
    return this.db.transaction<SecurityTables, DataRequestView>(SECURITY_MANIFEST, async (tx) => {
      const row = await tx.db
        .selectFrom('app.sec_data_request')
        .selectAll()
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError();
      return view(row);
    });
  }

  /** Consumer handler: a participant module reports completion; the request completes when all have. */
  async recordModuleCompletion(
    tx: TenantTx<SecurityTables>,
    requestId: string,
    module: string,
  ): Promise<void> {
    const row = await tx.db
      .selectFrom('app.sec_data_request')
      .selectAll()
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('id', '=', requestId)
      .forUpdate()
      .executeTakeFirst();
    if (
      row === undefined ||
      row.status === 'completed' ||
      !row.required_modules.includes(module) ||
      row.completed_modules.includes(module)
    )
      return;
    const completed = [...row.completed_modules, module].sort();
    const done = row.required_modules.every((m) => completed.includes(m));
    const updated = await tx.db
      .updateTable('app.sec_data_request')
      .set({
        completed_modules: completed,
        status: done ? 'completed' : row.status,
        completed_at: done ? new Date() : null,
        version: row.version + 1,
        updated_at: new Date(),
        updated_by: tx.context.actor.id,
      })
      .where('organization_id', '=', row.organization_id)
      .where('id', '=', row.id)
      .where('version', '=', row.version)
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.audit(
      tx,
      row.id,
      updated.version,
      done ? 'compliance.data_request.completed' : 'compliance.data_request.module_completed',
      {
        completed_modules: { before: row.completed_modules, after: completed },
        status: { before: row.status, after: updated.status },
      },
    );
    if (done) await publishEvent(tx, DataRequestCompleted, { request_id: row.id });
  }

  private audit(
    tx: TenantTx<SecurityTables>,
    id: string,
    version: number,
    action: string,
    changes: Record<string, { before?: unknown; after?: unknown }>,
  ): Promise<string> {
    return appendAudit(tx, SECURITY_MANIFEST, {
      table: 'app.sec_data_request',
      action,
      entityType: 'data_request',
      entityId: id,
      entityVersion: version,
      changes,
    });
  }
}
