import type { Generated, ModuleManifest } from '../../kernel/public.js';

/** P7 Security & Compliance services: table manifest (B-05). */
export const SECURITY_MANIFEST: ModuleManifest = {
  module: 'sec',
  prefix: 'sec_',
  tables: [
    {
      table: 'app.sec_data_request',
      scope: 'organization',
      retention: 'audit',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        request_type: 'internal',
        subject_type: 'internal',
        subject_id: 'internal',
        status: 'internal',
        required_modules: 'internal',
        completed_modules: 'internal',
        received_at: 'internal',
        completed_at: 'internal',
        version: 'internal',
        created_at: 'internal',
        created_by: 'internal',
        updated_at: 'internal',
        updated_by: 'internal',
      },
    },
    {
      table: 'app.sec_idempotency_key',
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
        response_body: 'internal',
        created_at: 'internal',
        completed_at: 'internal',
        expires_at: 'internal',
      },
    },
  ],
};

export interface SecurityTables {
  'app.sec_data_request': {
    id: string;
    organization_id: string;
    request_type: 'access' | 'erasure';
    subject_type: 'user';
    subject_id: string;
    status: 'received' | 'processing' | 'completed' | 'rejected';
    required_modules: string[];
    completed_modules: Generated<string[]>;
    received_at: Generated<Date>;
    completed_at: Date | null;
    version: Generated<number>;
    created_at: Generated<Date>;
    created_by: string;
    updated_at: Generated<Date>;
    updated_by: string;
  };
}
