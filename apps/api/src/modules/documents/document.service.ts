import { createHash } from 'node:crypto';
import {
  appendAudit,
  currentContext,
  decodeCursor,
  etag,
  NotFoundError,
  pageLimit,
  publishEvent,
  StateConflictError,
  toPage,
  uuidv7,
  VersionConflictError,
  type IdempotencyStore,
  type IdempotentRequest,
  type Page,
  type Selectable,
  type TenantDatabase,
  type TenantTx,
  type WriteResult,
} from '../../kernel/public.js';
import { hasPermission, requirePermission } from '../iam/public/authorizer.js';
import type { ConfigurationService } from '../configuration/public/index.js';
import type { DocumentStorage } from './document-storage.js';
import {
  DOCUMENTS_MANIFEST,
  type DocumentClass,
  type DocumentTables,
} from './documents.manifest.js';
import {
  DocumentDeleted,
  DocumentRetentionExpired,
  DocumentUploaded,
  DocumentVersionCreated,
  SENSITIVE_CLASSES,
} from './public/contracts.js';

type Tx = TenantTx<DocumentTables>;
type Row = Selectable<DocumentTables['app.doc_document']>;

export interface DocumentView {
  readonly id: string;
  readonly scope_level: string;
  readonly property_id: string | null;
  readonly document_class: DocumentClass;
  readonly title: string;
  readonly status: string;
  readonly current_version: number;
  readonly retention_until: string | null;
  readonly version: number;
}
const view = (r: Row): DocumentView => ({
  id: r.id,
  scope_level: r.scope_level,
  property_id: r.property_id,
  document_class: r.document_class,
  title: r.title,
  status: r.status,
  current_version: r.current_version,
  retention_until: r.retention_until?.toISOString() ?? null,
  version: r.version,
});

const RETENTION_SETTING: Partial<Record<DocumentClass, string>> = {
  general: 'documents.retention_days.general',
  identity: 'documents.retention_days.identity',
};

/**
 * P5 Document Management (module map P5 and its protection model). Contents go to storage BEFORE
 * the transaction (B-24) and are removed again if it fails. Every access is authorized per class and
 * scope; P5 always streams in this phase (no presigned URLs without the S3 adapter); sensitive reads
 * are audited. Retention comes from P8 configuration; without a configured value nothing is deleted
 * automatically (E-31).
 */
export class DocumentService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly idempotency: IdempotencyStore,
    private readonly storage: DocumentStorage,
    private readonly configuration: ConfigurationService,
    private readonly maxBytes: number,
  ) {}

  async create(
    input: {
      documentClass: DocumentClass;
      title: string;
      scopeLevel: 'organization' | 'property';
      propertyId: string | null;
    },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission(`document:${input.documentClass}:write`, { propertyId: input.propertyId });
    const ctx = currentContext();
    const retentionUntil = await this.retentionUntil(input.documentClass, input.propertyId);
    return this.db.transaction<DocumentTables, WriteResult>(DOCUMENTS_MANIFEST, (tx) =>
      this.idempotency.run(tx, DOCUMENTS_MANIFEST, request, async () => {
        const id = uuidv7();
        const row = await tx.db
          .insertInto('app.doc_document')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            scope_level: input.scopeLevel,
            property_id: input.propertyId,
            document_class: input.documentClass,
            title: input.title,
            status: 'active',
            retention_until: retentionUntil,
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit(tx, row, 1, 'document.created', {
          document_class: { after: input.documentClass },
          title: { after: input.title },
          retention_until: { after: retentionUntil?.toISOString() ?? null },
        });
        await publishEvent(
          tx,
          DocumentUploaded,
          { document_id: id, document_class: input.documentClass },
          { propertyId: input.propertyId },
        );
        return { status: 201, headers: { etag: etag(1) }, body: view(row) };
      }),
    );
  }

  /** Uploads a new version of the content (append-only versions). */
  async upload(
    documentId: string,
    expectedVersion: number,
    content: Buffer,
    contentType: string,
  ): Promise<DocumentView> {
    const ctx = currentContext();
    const document = await this.load(documentId);
    requirePermission(`document:${document.document_class}:write`, {
      propertyId: document.property_id,
    });
    if (document.status !== 'active') throw new StateConflictError('document.deleted');
    if (content.length > this.maxBytes) throw new StateConflictError('document.too_large');
    const storageContext = {
      organizationId: ctx.tenant.organizationId,
      propertyId: document.property_id,
    };
    const key = await this.storage.put(storageContext, content);
    try {
      return await this.db.transaction<DocumentTables, DocumentView>(
        DOCUMENTS_MANIFEST,
        async (tx) => {
          const current = await this.lock(tx, documentId);
          if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
          if (current.status !== 'active') throw new StateConflictError('document.deleted');
          const versionNumber = current.current_version + 1;
          await tx.db
            .insertInto('app.doc_document_version')
            .values({
              id: uuidv7(),
              organization_id: current.organization_id,
              document_id: current.id,
              version_number: versionNumber,
              storage_key: key,
              content_type: contentType,
              size_bytes: content.length,
              sha256: createHash('sha256').update(content).digest('hex'),
              created_by: ctx.actor.id,
            })
            .execute();
          const updated = await tx.db
            .updateTable('app.doc_document')
            .set({
              current_version: versionNumber,
              version: current.version + 1,
              updated_at: new Date(),
              updated_by: ctx.actor.id,
            })
            .where('organization_id', '=', current.organization_id)
            .where('id', '=', current.id)
            .where('version', '=', current.version)
            .returningAll()
            .executeTakeFirstOrThrow();
          await this.audit(tx, updated, updated.version, 'document.version_created', {
            current_version: { before: current.current_version, after: versionNumber },
          });
          await publishEvent(
            tx,
            DocumentVersionCreated,
            { document_id: current.id, version_number: versionNumber },
            { propertyId: current.property_id },
          );
          return view(updated);
        },
      );
    } catch (error) {
      await this.storage.delete(storageContext, key).catch(() => undefined);
      throw error;
    }
  }

  /** Streams a version through P5 after authorization; sensitive classes are audited on every read. */
  async download(
    documentId: string,
    versionNumber: number | null,
  ): Promise<{ content: Buffer; contentType: string; sha256: string; versionNumber: number }> {
    const ctx = currentContext();
    const document = await this.load(documentId);
    requirePermission(`document:${document.document_class}:read`, {
      propertyId: document.property_id,
    });
    if (document.status !== 'active') throw new NotFoundError();
    const target = versionNumber ?? document.current_version;
    const version = await this.db.transaction<
      DocumentTables,
      Selectable<DocumentTables['app.doc_document_version']> | undefined
    >(DOCUMENTS_MANIFEST, async (tx) => {
      const row = await tx.db
        .selectFrom('app.doc_document_version')
        .selectAll()
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('document_id', '=', documentId)
        .where('version_number', '=', target)
        .executeTakeFirst();
      if (row !== undefined && SENSITIVE_CLASSES.has(document.document_class)) {
        await appendAudit(tx, DOCUMENTS_MANIFEST, {
          table: 'document_read',
          action: 'document.read',
          entityType: 'document',
          entityId: documentId,
          entityVersion: document.version,
          propertyId: document.property_id,
          changes: {
            version_number: { after: target },
            document_class: { after: document.document_class },
            delivery: { after: 'streamed' },
          },
        });
      }
      return row;
    });
    if (version === undefined) throw new NotFoundError();
    const content = await this.storage.get(
      { organizationId: ctx.tenant.organizationId, propertyId: document.property_id },
      version.storage_key,
    );
    if (createHash('sha256').update(content).digest('hex') !== version.sha256)
      throw new StateConflictError('document.integrity_check_failed');
    return {
      content,
      contentType: version.content_type,
      sha256: version.sha256,
      versionNumber: target,
    };
  }

  /** Metadata search (cursor pagination), filtered to the classes and properties the caller may read. */
  async search(filters: {
    documentClass: DocumentClass | null;
    titlePrefix: string | null;
    cursor: string | undefined;
    limit: string | undefined;
  }): Promise<Page<DocumentView>> {
    const limit = pageLimit(filters.limit);
    const filterKey = { class: filters.documentClass, title: filters.titlePrefix };
    const position = decodeCursor(filters.cursor, filterKey);
    return this.db.transaction<DocumentTables, Page<DocumentView>>(
      DOCUMENTS_MANIFEST,
      async (tx) => {
        let query = tx.db
          .selectFrom('app.doc_document')
          .selectAll()
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .where('status', '=', 'active')
          .orderBy('title')
          .orderBy('id')
          .limit(limit + 1);
        if (filters.documentClass !== null)
          query = query.where('document_class', '=', filters.documentClass);
        if (filters.titlePrefix !== null)
          query = query.where(
            'title',
            'like',
            `${filters.titlePrefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
          );
        if (position !== null) {
          const sort = String(position.sort);
          query = query.where((eb) =>
            eb.or([
              eb('title', '>', sort),
              eb.and([eb('title', '=', sort), eb('id', '>', position.id)]),
            ]),
          );
        }
        const rows = (await query.execute()).map(view);
        const page = toPage(rows, limit, (r) => ({ sort: r.title, id: r.id }), filterKey);
        return {
          ...page,
          data: page.data.filter((d) =>
            hasPermission(`document:${d.document_class}:read`, { propertyId: d.property_id }),
          ),
        };
      },
    );
  }

  async get(documentId: string): Promise<DocumentView> {
    const document = await this.load(documentId);
    requirePermission(`document:${document.document_class}:read`, {
      propertyId: document.property_id,
    });
    return view(document);
  }

  async delete(documentId: string, expectedVersion: number): Promise<DocumentView> {
    const document = await this.load(documentId);
    requirePermission(`document:${document.document_class}:write`, {
      propertyId: document.property_id,
    });
    return this.remove(documentId, expectedVersion, 'user_request');
  }

  /** Retention job (one tenant per transaction, CX-13): deletes an expired document's contents. */
  async expire(documentId: string): Promise<boolean> {
    const row = await this.db.transaction<DocumentTables, Row | undefined>(
      DOCUMENTS_MANIFEST,
      (tx) =>
        tx.db
          .selectFrom('app.doc_document')
          .selectAll()
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .where('id', '=', documentId)
          .where('status', '=', 'active')
          .where('retention_until', '<=', new Date())
          .executeTakeFirst(),
    );
    if (row === undefined) return false;
    await this.remove(documentId, row.version, 'retention_expired');
    return true;
  }

  private async remove(
    documentId: string,
    expectedVersion: number,
    reason: 'user_request' | 'retention_expired',
  ): Promise<DocumentView> {
    const ctx = currentContext();
    const result = await this.db.transaction<
      DocumentTables,
      { view: DocumentView; keys: string[]; propertyId: string | null }
    >(DOCUMENTS_MANIFEST, async (tx) => {
      const current = await this.lock(tx, documentId);
      if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
      if (current.status !== 'active') throw new StateConflictError('document.deleted');
      const keys = (
        await tx.db
          .selectFrom('app.doc_document_version')
          .select('storage_key')
          .where('organization_id', '=', current.organization_id)
          .where('document_id', '=', documentId)
          .execute()
      ).map((k) => k.storage_key);
      const updated = await tx.db
        .updateTable('app.doc_document')
        .set({
          status: 'deleted',
          deleted_at: new Date(),
          deletion_reason: reason,
          version: current.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', current.organization_id)
        .where('id', '=', documentId)
        .where('version', '=', current.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(
        tx,
        updated,
        updated.version,
        reason === 'retention_expired' ? 'document.retention_expired' : 'document.deleted',
        { status: { before: 'active', after: 'deleted' }, deletion_reason: { after: reason } },
      );
      await publishEvent(
        tx,
        reason === 'retention_expired' ? DocumentRetentionExpired : DocumentDeleted,
        { document_id: documentId },
        { propertyId: current.property_id },
      );
      return { view: view(updated), keys, propertyId: current.property_id };
    });
    // The metadata stays as a tombstone for audit references; the contents are removed after commit.
    for (const key of result.keys)
      await this.storage
        .delete({ organizationId: ctx.tenant.organizationId, propertyId: result.propertyId }, key)
        .catch(() => undefined);
    return result.view;
  }

  private async retentionUntil(
    documentClass: DocumentClass,
    propertyId: string | null,
  ): Promise<Date | null> {
    const setting = RETENTION_SETTING[documentClass];
    if (setting === undefined) return null; // financial and contract retention need legal input (E-31)
    const resolved = await this.configuration.resolve(propertyId);
    const days = resolved.settings[setting]?.value;
    return typeof days === 'number' ? new Date(Date.now() + days * 86_400_000) : null;
  }

  private async load(documentId: string): Promise<Row> {
    return this.db.transaction<DocumentTables, Row>(DOCUMENTS_MANIFEST, async (tx) => {
      const row = await tx.db
        .selectFrom('app.doc_document')
        .selectAll()
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .where('id', '=', documentId)
        .executeTakeFirst();
      if (row === undefined) throw new NotFoundError();
      return row;
    });
  }

  private async lock(tx: Tx, documentId: string): Promise<Row> {
    const row = await tx.db
      .selectFrom('app.doc_document')
      .selectAll()
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('id', '=', documentId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError();
    return row;
  }

  private audit(
    tx: Tx,
    row: Row,
    version: number,
    action: string,
    changes: Record<string, { before?: unknown; after?: unknown }>,
  ): Promise<string> {
    return appendAudit(tx, DOCUMENTS_MANIFEST, {
      table: 'app.doc_document',
      action,
      entityType: 'document',
      entityId: row.id,
      entityVersion: version,
      propertyId: row.property_id,
      changes,
    });
  }
}
