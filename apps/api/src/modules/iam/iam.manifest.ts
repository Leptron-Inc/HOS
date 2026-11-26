import type { ModuleManifest } from '../../kernel/public.js';

const standard = {
  version: 'internal',
  created_at: 'internal',
  created_by: 'internal',
  updated_at: 'internal',
  updated_by: 'internal',
} as const;
const historyColumns = {
  organization_id: 'internal',
  entity_id: 'internal',
  version: 'internal',
  recorded_at: 'internal',
  correlation_id: 'internal',
  actor_id: 'internal',
  erased_at: 'internal',
  erasure_reason: 'internal',
  erasure_reference: 'internal',
} as const;

/** P2 Identity & Access Management: table manifest (B-05, E-26, E-30). */
export const IAM_MANIFEST: ModuleManifest = {
  module: 'iam',
  prefix: 'iam_',
  auditRecords: {
    authorization_denial: {
      permission: 'internal',
      property_id: 'internal',
      department_id: 'internal',
    },
    invitation: { user_id: 'internal', expires_at: 'internal', status: 'internal' },
  },
  tables: [
    {
      table: 'app.iam_user',
      scope: 'organization',
      retention: 'operational',
      history: 'app.iam_user_history',
      lookupIndexes: ['iam_user_subject_idx'],
      columns: {
        id: 'internal',
        organization_id: 'internal',
        idp_issuer: 'internal',
        idp_subject: 'personal',
        display_name: 'personal',
        status: 'internal',
        realm: 'internal',
        kind: 'internal',
        sessions_valid_after: 'internal',
        ...standard,
      },
    },
    {
      table: 'app.iam_role',
      scope: 'organization',
      retention: 'operational',
      history: 'app.iam_role_history',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        code: 'internal',
        name: 'internal',
        permissions: 'internal',
        is_system: 'internal',
        status: 'internal',
        ...standard,
      },
    },
    {
      table: 'app.iam_role_assignment',
      scope: 'organization',
      retention: 'operational',
      history: 'app.iam_role_assignment_history',
      columns: {
        id: 'internal',
        organization_id: 'internal',
        user_id: 'internal',
        role_id: 'internal',
        scope_property_id: 'internal',
        scope_department_id: 'internal',
        status: 'internal',
        ...standard,
      },
    },
    {
      table: 'app.iam_invitation',
      scope: 'organization',
      retention: 'transient',
      columns: {
        // The digest of a single-use 256-bit token: not the token itself, which is never stored.
        id: 'internal',
        organization_id: 'internal',
        user_id: 'internal',
        token_digest: 'internal',
        expires_at: 'internal',
        accepted_at: 'internal',
        status: 'internal',
        ...standard,
      },
    },
    {
      table: 'app.iam_idempotency_key',
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

/** Column classification of the history tables, for the catalog check. */
export const IAM_HISTORY_COLUMNS = historyColumns;
