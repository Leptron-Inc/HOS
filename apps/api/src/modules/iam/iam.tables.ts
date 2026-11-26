import type { Generated } from '../../kernel/public.js';

interface Versioned {
  version: Generated<number>;
  created_at: Generated<Date>;
  created_by: string;
  updated_at: Generated<Date>;
  updated_by: string;
}

/** Kysely table types for P2 (own tables only, B-07). */
export interface IamTables {
  'app.iam_user': Versioned & {
    id: string;
    organization_id: string;
    idp_issuer: string;
    idp_subject: string;
    display_name: string;
    status: 'active' | 'inactive';
    realm: 'hotel_employee' | 'guest' | 'machine';
    kind: 'user' | 'service_identity';
    sessions_valid_after: Generated<Date>;
  };
  'app.iam_role': Versioned & {
    id: string;
    organization_id: string;
    code: string;
    name: string;
    permissions: string[];
    is_system: Generated<boolean>;
    status: 'active' | 'inactive';
  };
  'app.iam_role_assignment': Versioned & {
    id: string;
    organization_id: string;
    user_id: string;
    role_id: string;
    scope_property_id: string | null;
    scope_department_id: string | null;
    status: 'active' | 'revoked';
  };
  'app.iam_invitation': Versioned & {
    id: string;
    organization_id: string;
    user_id: string;
    token_digest: Buffer;
    expires_at: Date;
    accepted_at: Date | null;
    status: 'pending' | 'accepted' | 'revoked';
  };
}
