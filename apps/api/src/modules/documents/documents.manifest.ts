import type { Generated, ModuleManifest } from '../../kernel/public.js';

const versioned = {
  version: 'internal',
  created_at: 'internal',
  created_by: 'internal',
  updated_at: 'internal',
  updated_by: 'internal',
} as const;

/** P5 Document Management: table manifest (B-05). Contents are in storage, not in these tables. */
export const DOCUMENTS_MANIFEST: ModuleManifest = {
  module: 'doc',
  prefix: 'doc_',
  auditRecords: {
    document_read: { version_number: 'internal', document_class: 'internal', delivery: 'internal' },
  },
  tables: [
    {
      table: 'app.doc_document',
      scope: 'organization',
      retention: 'operational',
      history: 'app.doc_document_history',
      lookupIndexes: ['doc_document_retention_idx'],
      columns: {
        id: 'internal',
        organization_id: 'internal',
        scope_level: 'internal',
        property_id: 'internal',
        document_class: 'internal',
        title: 'personal',
        status: 'internal',
        current_version: 'internal',
        retention_until: 'internal',
        deleted_at: 'internal',
        deletion_reason: 'internal',
        ...versioned,
      },
    },
    {
      table: 'app.doc_document_version',
      scope: 'organization',
      retention: 'operational',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        document_id: 'internal',
        version_number: 'internal',
        storage_key: 'internal',
        content_type: 'internal',
        size_bytes: 'internal',
        sha256: 'internal',
        created_at: 'internal',
        created_by: 'internal',
      },
    },
    {
      table: 'app.doc_idempotency_key',
      scope: 'organization',
      retention: 'transient',
      deletableBy: ['hos_worker'],
      columns: {
        organization_id: 'internal',
        actor_id: 'internal',
        operation: 'internal',
        idempotency_key: 'internal',
        request_fingerprint: 'internal',
        response_status: 'internal',
        response_headers: 'internal',
        response_body: 'personal',
        created_at: 'internal',
        completed_at: 'internal',
        expires_at: 'internal',
      },
    },
  ],
};

interface Versioned {
  version: Generated<number>;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  updated_by: string;
}
export type DocumentClass = 'identity' | 'financial' | 'contract' | 'general';

export interface DocumentTables {
  'app.doc_document': Versioned & {
    id: string;
    organization_id: string;
    scope_level: 'organization' | 'property';
    property_id: string | null;
    document_class: DocumentClass;
    title: string;
    status: 'active' | 'deleted';
    current_version: Generated<number>;
    retention_until: Date | null;
    deleted_at: Date | null;
    deletion_reason: 'user_request' | 'retention_expired' | null;
  };
  'app.doc_document_version': {
    id: string;
    organization_id: string;
    document_id: string;
    version_number: number;
    storage_key: string;
    content_type: string;
    size_bytes: number;
    sha256: string;
    created_at: Generated<Date>;
    created_by: string;
  };
}
