import { createHash, randomBytes } from 'node:crypto';
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
  uuidv5,
  uuidv7,
  ValidationError,
  VersionConflictError,
  type IdempotencyStore,
  type IdempotentRequest,
  type Page,
  type Selectable,
  type TenantDatabase,
  type TenantTx,
  type WriteResult,
  eraseHistory,
} from '../../kernel/public.js';
import { DataRequestModuleCompleted } from '../security/public/index.js';
import type { AuthorizationService } from './authorization.service.js';
import { IAM_MANIFEST } from './iam.manifest.js';
import type { IamTables } from './iam.tables.js';
import { requirePermission } from './public/authorizer.js';
import {
  RoleAssignmentChanged,
  RoleChanged,
  UserCreated,
  UserSessionsRevoked,
  UserStatusChanged,
} from './public/events.js';
import { isAssignablePermission, permissionCatalogue } from './public/permissions.js';

type Tx = TenantTx<IamTables>;
type UserRow = Selectable<IamTables['app.iam_user']>;

/** Invitation principals carry a placeholder identity until accepted; it can never verify. */
const INVITATION_ISSUER = 'urn:hos:invitation';
/** Erased principals keep their ID (audit references resolve, E-37) but no identity-provider link. */
const ERASED_ISSUER = 'urn:hos:erased';
const SYSTEM_ROLE_NAMESPACE = '2a6b9c8d-7e1f-4a3b-9c5d-6e7f8a9b0c1d';
export const ORGANIZATION_ADMINISTRATOR = 'organization_administrator';

export interface UserView {
  readonly id: string;
  readonly display_name: string;
  readonly status: 'active' | 'inactive';
  readonly realm: 'hotel_employee' | 'guest' | 'machine';
  readonly kind: 'user' | 'service_identity';
  readonly pending_invitation: boolean;
  readonly version: number;
}

export interface RoleView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly permissions: readonly string[];
  readonly is_system: boolean;
  readonly status: 'active' | 'inactive';
  readonly version: number;
}

export interface AssignmentView {
  readonly id: string;
  readonly user_id: string;
  readonly role_id: string;
  readonly scope_property_id: string | null;
  readonly scope_department_id: string | null;
  readonly status: 'active' | 'revoked';
  readonly version: number;
}

const userView = (row: UserRow): UserView => ({
  id: row.id,
  display_name: row.display_name,
  status: row.status,
  realm: row.realm,
  kind: row.kind,
  pending_invitation: row.idp_issuer === INVITATION_ISSUER,
  version: row.version,
});

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * P2 Identity & Access Management services (module map P2; D-021; tenancy specification CX-04,
 * CX-07, CX-18, CX-19). Authorization is evaluated by AuthorizationService; this service changes
 * the data it evaluates. Every change is audited and published in the same transaction, and
 * evaluated grants are invalidated at once (CX-19).
 */
export class IamService {
  constructor(
    private readonly db: TenantDatabase,
    private readonly idempotency: IdempotencyStore,
    private readonly authorization: AuthorizationService,
    private readonly invitationTtlHours = 72,
  ) {}

  // ---------- Users and service identities ----------

  async listUsers(
    cursor: string | undefined,
    limitRaw: string | undefined,
  ): Promise<Page<UserView>> {
    requirePermission('iam:user:read');
    const limit = pageLimit(limitRaw);
    const position = decodeCursor(cursor, { resource: 'users' });
    return this.db.transaction<IamTables, Page<UserView>>(IAM_MANIFEST, async (tx) => {
      let query = tx.db
        .selectFrom('app.iam_user')
        .selectAll()
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .orderBy('id')
        .limit(limit + 1);
      if (position !== null) query = query.where('id', '>', position.id);
      return toPage(
        (await query.execute()).map(userView),
        limit,
        (u) => ({ sort: u.id, id: u.id }),
        { resource: 'users' },
      );
    });
  }

  /** Invites a hotel employee or guest: an inactive principal plus a single-use, expiring invitation. */
  async inviteUser(
    input: { displayName: string; realm: 'hotel_employee' | 'guest' },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('iam:user:manage');
    return this.db.transaction<IamTables, WriteResult>(IAM_MANIFEST, (tx) =>
      this.idempotency.run(tx, IAM_MANIFEST, request, async () => {
        const { user, token, expiresAt } = await this.createInvitedUser(
          tx,
          input.displayName,
          input.realm,
        );
        return {
          status: 201,
          headers: { etag: etag(user.version) },
          // The token is returned once, to the inviting administrator, for out-of-band delivery. Only its digest is stored.
          body: { user, invitation: { token, expires_at: expiresAt.toISOString() } },
          // A replay confirms the invitation but never returns the token again: it is not stored (E-26).
          storedBody: {
            user,
            invitation: { token: null, expires_at: expiresAt.toISOString(), delivered: true },
          },
        };
      }),
    );
  }

  /**
   * Seeds the organization's system role and the first administrator invitation (map §7.1 "The
   * first tenant"). Called by provisioning; idempotent per organization.
   */
  async provisionFirstAdministrator(
    displayName: string,
  ): Promise<{ created: boolean; invitation: { token: string; expires_at: string } | null }> {
    requirePermission('tenant:provision');
    return this.db.transaction<
      IamTables,
      { created: boolean; invitation: { token: string; expires_at: string } | null }
    >(IAM_MANIFEST, async (tx) => {
      const organizationId = tx.context.tenant.organizationId;
      const roleId = uuidv5(
        SYSTEM_ROLE_NAMESPACE,
        `${organizationId}/${ORGANIZATION_ADMINISTRATOR}`,
      );
      const existing = await tx.db
        .selectFrom('app.iam_role')
        .select('id')
        .where('organization_id', '=', organizationId)
        .where('id', '=', roleId)
        .executeTakeFirst();
      if (existing !== undefined) return { created: false, invitation: null };
      const permissions = permissionCatalogue()
        .filter((p) => p.assignable !== false)
        .map((p) => p.code);
      await tx.db
        .insertInto('app.iam_role')
        .values({
          id: roleId,
          organization_id: organizationId,
          code: ORGANIZATION_ADMINISTRATOR,
          name: 'Organization administrator',
          permissions,
          is_system: true,
          status: 'active',
          created_by: tx.context.actor.id,
          updated_by: tx.context.actor.id,
        })
        .execute();
      await this.audit(tx, 'app.iam_role', 'iam.role.created', 'role', roleId, 1, {
        code: { after: ORGANIZATION_ADMINISTRATOR },
        permissions: { after: permissions },
      });
      const { user, token, expiresAt } = await this.createInvitedUser(
        tx,
        displayName,
        'hotel_employee',
      );
      const assignmentId = uuidv7();
      await tx.db
        .insertInto('app.iam_role_assignment')
        .values({
          id: assignmentId,
          organization_id: organizationId,
          user_id: user.id,
          role_id: roleId,
          scope_property_id: null,
          scope_department_id: null,
          status: 'active',
          created_by: tx.context.actor.id,
          updated_by: tx.context.actor.id,
        })
        .execute();
      await this.audit(
        tx,
        'app.iam_role_assignment',
        'iam.role_assignment.created',
        'role_assignment',
        assignmentId,
        1,
        {
          user_id: { after: user.id },
          role_id: { after: roleId },
          status: { after: 'active' },
        },
      );
      await publishEvent(tx, RoleAssignmentChanged, {
        assignment_id: assignmentId,
        user_id: user.id,
        status: 'active',
        version: 1,
      });
      return { created: true, invitation: { token, expires_at: expiresAt.toISOString() } };
    });
  }

  /** Registers a machine principal for an identity-provider client (issuer, subject); no secret is stored. */
  async registerServiceIdentity(
    input: { displayName: string; issuer: string; subject: string },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('iam:user:manage');
    const ctx = currentContext();
    return this.db.transaction<IamTables, WriteResult>(IAM_MANIFEST, (tx) =>
      this.idempotency.run(tx, IAM_MANIFEST, request, async () => {
        const id = uuidv7();
        const row = await tx.db
          .insertInto('app.iam_user')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            idp_issuer: input.issuer,
            idp_subject: input.subject,
            display_name: input.displayName,
            status: 'active',
            realm: 'machine',
            kind: 'service_identity',
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit(tx, 'app.iam_user', 'iam.service_identity.created', 'user', id, 1, {
          display_name: { after: input.displayName },
          idp_issuer: { after: input.issuer },
          status: { after: 'active' },
          kind: { after: 'service_identity' },
        });
        await publishEvent(tx, UserCreated, {
          user_id: id,
          kind: 'service_identity',
          realm: 'machine',
        });
        return { status: 201, headers: { etag: etag(row.version) }, body: userView(row) };
      }),
    );
  }

  async setUserStatus(
    userId: string,
    expectedVersion: number,
    status: 'active' | 'inactive',
  ): Promise<UserView> {
    requirePermission('iam:user:manage');
    const ctx = currentContext();
    if (userId === ctx.actor.id && status === 'inactive')
      throw new StateConflictError('iam.cannot_deactivate_self');
    const view = await this.db.transaction<IamTables, UserView>(IAM_MANIFEST, async (tx) => {
      const current = await this.lockUser(tx, userId);
      if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
      if (current.idp_issuer === INVITATION_ISSUER && status === 'active')
        throw new StateConflictError('iam.invitation_pending');
      const updated = await tx.db
        .updateTable('app.iam_user')
        .set({
          status,
          version: current.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', userId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(
        tx,
        'app.iam_user',
        'iam.user.status_changed',
        'user',
        userId,
        updated.version,
        { status: { before: current.status, after: status } },
      );
      await publishEvent(tx, UserStatusChanged, {
        user_id: userId,
        status,
        version: updated.version,
      });
      return userView(updated);
    });
    this.authorization.invalidate(ctx.tenant.organizationId, userId);
    return view;
  }

  /** Revokes every session: tokens issued before now are refused (session validation). */
  async revokeSessions(userId: string): Promise<void> {
    requirePermission('iam:user:manage');
    const ctx = currentContext();
    await this.db.transaction<IamTables, void>(IAM_MANIFEST, async (tx) => {
      const current = await this.lockUser(tx, userId);
      const updated = await tx.db
        .updateTable('app.iam_user')
        .set({
          sessions_valid_after: new Date(),
          version: current.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', userId)
        .where('version', '=', current.version)
        .returning('version')
        .executeTakeFirstOrThrow();
      await this.audit(
        tx,
        'app.iam_user',
        'iam.user.sessions_revoked',
        'user',
        userId,
        updated.version,
        { sessions_valid_after: { after: 'now' } },
      );
      await publishEvent(tx, UserSessionsRevoked, { user_id: userId });
    });
    this.authorization.invalidate(ctx.tenant.organizationId, userId);
  }

  /**
   * Accepts an invitation: binds the verified identity-provider subject to the invited principal and
   * activates it. Runs under the P2 invitation service identity in the claimed organization; the
   * 256-bit token is the authorization (PROVISIONAL design, recorded in CURRENT_STATE.md).
   */
  async acceptInvitation(
    token: string,
    credential: { issuer: string; subject: string; realm: string },
  ): Promise<UserView> {
    const ctx = currentContext();
    return this.db.transaction<IamTables, UserView>(IAM_MANIFEST, async (tx) => {
      const invitation = await tx.db
        .selectFrom('app.iam_invitation')
        .selectAll()
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('token_digest', '=', tokenDigest(token))
        .forUpdate()
        .executeTakeFirst();
      if (
        invitation === undefined ||
        invitation.status !== 'pending' ||
        invitation.expires_at <= new Date()
      )
        throw new NotFoundError();
      const user = await this.lockUser(tx, invitation.user_id);
      if (user.realm !== credential.realm) throw new NotFoundError();
      const taken = await tx.db
        .selectFrom('app.iam_user')
        .select('id')
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('idp_issuer', '=', credential.issuer)
        .where('idp_subject', '=', credential.subject)
        .executeTakeFirst();
      if (taken !== undefined) throw new StateConflictError('iam.identity_already_linked');
      const updated = await tx.db
        .updateTable('app.iam_user')
        .set({
          idp_issuer: credential.issuer,
          idp_subject: credential.subject,
          status: 'active',
          version: user.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', user.id)
        .where('version', '=', user.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx.db
        .updateTable('app.iam_invitation')
        .set({
          status: 'accepted',
          accepted_at: new Date(),
          version: invitation.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', invitation.id)
        .where('version', '=', invitation.version)
        .execute();
      await this.audit(
        tx,
        'app.iam_user',
        'iam.invitation.accepted',
        'user',
        user.id,
        updated.version,
        {
          idp_issuer: { before: INVITATION_ISSUER, after: credential.issuer },
          idp_subject: { after: credential.subject },
          status: { before: user.status, after: 'active' },
        },
      );
      await publishEvent(tx, UserStatusChanged, {
        user_id: user.id,
        status: 'active',
        version: updated.version,
      });
      return userView(updated);
    });
  }

  /**
   * Data-subject erasure for a principal (E-34 to E-37): the current record is pseudonymized and
   * deactivated, sessions are revoked, and every history version is erased through the allowlisted
   * definer function, leaving tombstones. Completion is reported to P7.
   */
  async eraseUserForRequest(tx: Tx, requestId: string, userId: string): Promise<void> {
    const organizationId = tx.context.tenant.organizationId;
    const user = await tx.db
      .selectFrom('app.iam_user')
      .selectAll()
      .where('organization_id', '=', organizationId)
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (user !== undefined && user.idp_issuer !== ERASED_ISSUER) {
      const updated = await tx.db
        .updateTable('app.iam_user')
        .set({
          display_name: '[erased]',
          idp_issuer: ERASED_ISSUER,
          idp_subject: userId,
          status: 'inactive',
          sessions_valid_after: new Date(),
          version: user.version + 1,
          updated_at: new Date(),
          updated_by: tx.context.actor.id,
        })
        .where('organization_id', '=', organizationId)
        .where('id', '=', userId)
        .where('version', '=', user.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      const erased = await eraseHistory(
        tx,
        IAM_MANIFEST,
        'app.iam_user',
        userId,
        'data_subject_request',
        requestId,
      );
      await this.audit(tx, 'app.iam_user', 'iam.user.erased', 'user', userId, updated.version, {
        display_name: { before: user.display_name, after: null },
        idp_subject: { before: user.idp_subject, after: null },
        status: { before: user.status, after: 'inactive' },
      });
      if (erased < 1) throw new Error('history erasure removed no versions');
      await publishEvent(tx, UserStatusChanged, {
        user_id: userId,
        status: 'inactive',
        version: updated.version,
      });
      this.authorization.invalidate(organizationId, userId);
    }
    await publishEvent(tx, DataRequestModuleCompleted, { request_id: requestId, module: 'iam' });
  }

  // ---------- Roles ----------

  async listRoles(): Promise<RoleView[]> {
    requirePermission('iam:role:read');
    return this.db.transaction<IamTables, RoleView[]>(IAM_MANIFEST, async (tx) =>
      (
        await tx.db
          .selectFrom('app.iam_role')
          .selectAll()
          .where('organization_id', '=', tx.context.tenant.organizationId)
          .orderBy('code')
          .limit(500)
          .execute()
      ).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        permissions: r.permissions,
        is_system: r.is_system,
        status: r.status,
        version: r.version,
      })),
    );
  }

  async createRole(
    input: { code: string; name: string; permissions: readonly string[] },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('iam:role:manage');
    this.assertPermissions(input.permissions);
    const ctx = currentContext();
    return this.db.transaction<IamTables, WriteResult>(IAM_MANIFEST, (tx) =>
      this.idempotency.run(tx, IAM_MANIFEST, request, async () => {
        const clash = await tx.db
          .selectFrom('app.iam_role')
          .select('id')
          .where('organization_id', '=', ctx.tenant.organizationId)
          .where('code', '=', input.code)
          .executeTakeFirst();
        if (clash !== undefined) throw new StateConflictError('iam.role_code_exists');
        const id = uuidv7();
        const row = await tx.db
          .insertInto('app.iam_role')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            code: input.code,
            name: input.name,
            permissions: [...new Set(input.permissions)].sort(),
            status: 'active',
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.audit(tx, 'app.iam_role', 'iam.role.created', 'role', id, 1, {
          code: { after: row.code },
          name: { after: row.name },
          permissions: { after: row.permissions },
        });
        await publishEvent(tx, RoleChanged, { role_id: id, version: 1 });
        return {
          status: 201,
          headers: { etag: etag(1) },
          body: {
            id,
            code: row.code,
            name: row.name,
            permissions: row.permissions,
            is_system: false,
            status: 'active',
            version: 1,
          },
        };
      }),
    );
  }

  async updateRole(
    roleId: string,
    expectedVersion: number,
    changes: {
      name?: string | undefined;
      permissions?: readonly string[] | undefined;
      status?: 'active' | 'inactive' | undefined;
    },
  ): Promise<RoleView> {
    requirePermission('iam:role:manage');
    if (changes.permissions !== undefined) this.assertPermissions(changes.permissions);
    const ctx = currentContext();
    const view = await this.db.transaction<IamTables, RoleView>(IAM_MANIFEST, async (tx) => {
      const current = await tx.db
        .selectFrom('app.iam_role')
        .selectAll()
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', roleId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError();
      if (current.is_system) throw new StateConflictError('iam.system_role_immutable');
      if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
      const next = {
        name: changes.name ?? current.name,
        permissions:
          changes.permissions !== undefined
            ? [...new Set(changes.permissions)].sort()
            : current.permissions,
        status: changes.status ?? current.status,
      };
      const updated = await tx.db
        .updateTable('app.iam_role')
        .set({
          ...next,
          version: current.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', roleId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(tx, 'app.iam_role', 'iam.role.updated', 'role', roleId, updated.version, {
        name: { before: current.name, after: next.name },
        permissions: { before: current.permissions, after: next.permissions },
        status: { before: current.status, after: next.status },
      });
      await publishEvent(tx, RoleChanged, { role_id: roleId, version: updated.version });
      return {
        id: updated.id,
        code: updated.code,
        name: updated.name,
        permissions: updated.permissions,
        is_system: updated.is_system,
        status: updated.status,
        version: updated.version,
      };
    });
    this.authorization.invalidate(ctx.tenant.organizationId);
    return view;
  }

  // ---------- Role assignments ----------

  async listAssignments(userId: string | undefined): Promise<AssignmentView[]> {
    requirePermission('iam:role:read');
    return this.db.transaction<IamTables, AssignmentView[]>(IAM_MANIFEST, async (tx) => {
      let query = tx.db
        .selectFrom('app.iam_role_assignment')
        .selectAll()
        .where('organization_id', '=', tx.context.tenant.organizationId)
        .orderBy('id')
        .limit(1000);
      if (userId !== undefined) query = query.where('user_id', '=', userId);
      return (await query.execute()).map((a) => ({
        id: a.id,
        user_id: a.user_id,
        role_id: a.role_id,
        scope_property_id: a.scope_property_id,
        scope_department_id: a.scope_department_id,
        status: a.status,
        version: a.version,
      }));
    });
  }

  /**
   * Assigns a role at organization, property or department scope. The composite foreign keys
   * reject a property of another organization and a department of another property (B-10, H-FK).
   */
  async assignRole(
    input: {
      userId: string;
      roleId: string;
      propertyId: string | null;
      departmentId: string | null;
    },
    request: IdempotentRequest,
  ): Promise<WriteResult> {
    requirePermission('iam:role:manage');
    if (input.departmentId !== null && input.propertyId === null) {
      throw new ValidationError([
        { path: 'scope_department_id', message: 'a department scope needs a property scope' },
      ]);
    }
    const ctx = currentContext();
    const result = await this.db.transaction<IamTables, WriteResult>(IAM_MANIFEST, (tx) =>
      this.idempotency.run(tx, IAM_MANIFEST, request, async () => {
        const user = await this.lockUser(tx, input.userId);
        const role = await tx.db
          .selectFrom('app.iam_role')
          .select(['id', 'status'])
          .where('organization_id', '=', ctx.tenant.organizationId)
          .where('id', '=', input.roleId)
          .executeTakeFirst();
        if (role === undefined) throw new NotFoundError();
        if (
          role.status !== 'active' ||
          (user.status === 'inactive' && user.idp_issuer !== INVITATION_ISSUER)
        )
          throw new StateConflictError('iam.assignment_target_inactive');
        const id = uuidv7();
        await tx.db
          .insertInto('app.iam_role_assignment')
          .values({
            id,
            organization_id: ctx.tenant.organizationId,
            user_id: input.userId,
            role_id: input.roleId,
            scope_property_id: input.propertyId,
            scope_department_id: input.departmentId,
            status: 'active',
            created_by: ctx.actor.id,
            updated_by: ctx.actor.id,
          })
          .execute();
        await this.audit(
          tx,
          'app.iam_role_assignment',
          'iam.role_assignment.created',
          'role_assignment',
          id,
          1,
          {
            user_id: { after: input.userId },
            role_id: { after: input.roleId },
            scope_property_id: { after: input.propertyId },
            scope_department_id: { after: input.departmentId },
            status: { after: 'active' },
          },
        );
        await publishEvent(tx, RoleAssignmentChanged, {
          assignment_id: id,
          user_id: input.userId,
          status: 'active',
          version: 1,
        });
        return {
          status: 201,
          headers: { etag: etag(1) },
          body: {
            id,
            user_id: input.userId,
            role_id: input.roleId,
            scope_property_id: input.propertyId,
            scope_department_id: input.departmentId,
            status: 'active',
            version: 1,
          },
        };
      }),
    );
    this.authorization.invalidate(ctx.tenant.organizationId, input.userId);
    return result;
  }

  async revokeAssignment(assignmentId: string, expectedVersion: number): Promise<AssignmentView> {
    requirePermission('iam:role:manage');
    const ctx = currentContext();
    const view = await this.db.transaction<IamTables, AssignmentView>(IAM_MANIFEST, async (tx) => {
      const current = await tx.db
        .selectFrom('app.iam_role_assignment')
        .selectAll()
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', assignmentId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError();
      if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
      if (current.status === 'revoked')
        throw new StateConflictError('iam.assignment_already_revoked');
      const updated = await tx.db
        .updateTable('app.iam_role_assignment')
        .set({
          status: 'revoked',
          version: current.version + 1,
          updated_at: new Date(),
          updated_by: ctx.actor.id,
        })
        .where('organization_id', '=', ctx.tenant.organizationId)
        .where('id', '=', assignmentId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit(
        tx,
        'app.iam_role_assignment',
        'iam.role_assignment.revoked',
        'role_assignment',
        assignmentId,
        updated.version,
        { status: { before: 'active', after: 'revoked' } },
      );
      await publishEvent(tx, RoleAssignmentChanged, {
        assignment_id: assignmentId,
        user_id: updated.user_id,
        status: 'revoked',
        version: updated.version,
      });
      return {
        id: updated.id,
        user_id: updated.user_id,
        role_id: updated.role_id,
        scope_property_id: updated.scope_property_id,
        scope_department_id: updated.scope_department_id,
        status: updated.status,
        version: updated.version,
      };
    });
    this.authorization.invalidate(ctx.tenant.organizationId, view.user_id);
    return view;
  }

  // ---------- helpers ----------

  private assertPermissions(permissions: readonly string[]): void {
    const invalid = permissions.filter((p) => !isAssignablePermission(p));
    if (invalid.length > 0)
      throw new ValidationError(
        invalid.slice(0, 20).map((p) => ({
          path: 'permissions',
          message: `unknown or non-assignable permission ${p}`,
        })),
      );
  }

  private async lockUser(tx: Tx, userId: string): Promise<UserRow> {
    const row = await tx.db
      .selectFrom('app.iam_user')
      .selectAll()
      .where('organization_id', '=', tx.context.tenant.organizationId)
      .where('id', '=', userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError();
    return row;
  }

  private async createInvitedUser(
    tx: Tx,
    displayName: string,
    realm: 'hotel_employee' | 'guest',
  ): Promise<{ user: UserView; token: string; expiresAt: Date }> {
    const ctx = tx.context;
    const id = uuidv7();
    const row = await tx.db
      .insertInto('app.iam_user')
      .values({
        id,
        organization_id: ctx.tenant.organizationId,
        idp_issuer: INVITATION_ISSUER,
        idp_subject: id,
        display_name: displayName,
        status: 'inactive',
        realm,
        kind: 'user',
        created_by: ctx.actor.id,
        updated_by: ctx.actor.id,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.invitationTtlHours * 3_600_000);
    const invitationId = uuidv7();
    await tx.db
      .insertInto('app.iam_invitation')
      .values({
        id: invitationId,
        organization_id: ctx.tenant.organizationId,
        user_id: id,
        token_digest: tokenDigest(token),
        expires_at: expiresAt,
        status: 'pending',
        created_by: ctx.actor.id,
        updated_by: ctx.actor.id,
      })
      .execute();
    await this.audit(tx, 'app.iam_user', 'iam.user.invited', 'user', id, 1, {
      display_name: { after: displayName },
      realm: { after: realm },
      status: { after: 'inactive' },
    });
    await this.audit(tx, 'invitation', 'iam.invitation.created', 'invitation', invitationId, 1, {
      user_id: { after: id },
      expires_at: { after: expiresAt.toISOString() },
      status: { after: 'pending' },
    });
    await publishEvent(tx, UserCreated, { user_id: id, kind: 'user', realm });
    return { user: userView(row), token, expiresAt };
  }

  private audit(
    tx: Tx,
    table: string,
    action: string,
    entityType: string,
    entityId: string,
    version: number | null,
    changes: Record<string, { before?: unknown; after?: unknown }>,
  ): Promise<string> {
    return appendAudit(tx, IAM_MANIFEST, {
      table,
      action,
      entityType,
      entityId,
      entityVersion: version,
      changes,
    });
  }
}
