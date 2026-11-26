import { appendAudit, type RequestContext, type TenantDatabase } from '../../kernel/public.js';
import { IAM_MANIFEST } from './iam.manifest.js';
import type { IamTables } from './iam.tables.js';
import {
  platformIdentity,
  PrincipalGrants,
  type AuthorizationTarget,
  type Grant,
} from './public/grants.js';

/**
 * The HOS permission engine (P2, layer L2; D-021; tenancy specification CX-06, CX-07, CX-19).
 */
export interface PrincipalState {
  readonly status: 'active' | 'inactive';
  readonly realm: 'hotel_employee' | 'guest' | 'machine';
  readonly kind: 'user' | 'service_identity';
  readonly sessionsValidAfter: Date;
}

export interface Evaluation {
  readonly principal: PrincipalState;
  readonly grants: PrincipalGrants;
}

/** Department activity comes from P1 through its public interface (G2), never from P2 SQL. */
export type ActiveDepartmentResolver = (
  ctx: RequestContext,
  departmentIds: readonly string[],
) => Promise<ReadonlySet<string>>;

export interface AuthorizationServiceOptions {
  /** CX-19: how long evaluated grants are reused. Changes invalidate them immediately. */
  readonly cacheTtlMs: number;
  readonly now?: () => number;
}

export class AuthorizationService {
  private readonly cache = new Map<string, { evaluation: Evaluation; expires: number }>();

  constructor(
    private readonly db: TenantDatabase,
    private readonly activeDepartments: ActiveDepartmentResolver,
    private readonly options: AuthorizationServiceOptions,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Evaluates the actor's assignments in the organization. `evaluationContext` is built by the
   * trusted entry point after the principal was verified active in this organization (CX-06); it
   * has the organization-wide scope only so that P2 can read the actor's own assignments.
   */
  async evaluate(evaluationContext: RequestContext): Promise<Evaluation | undefined> {
    const organizationId = evaluationContext.tenant.organizationId;
    const actor = evaluationContext.actor;
    const platform = platformIdentity(actor.id);
    if (platform !== undefined) {
      return {
        principal: {
          status: 'active',
          realm: 'machine',
          kind: 'service_identity',
          sessionsValidAfter: new Date(0),
        },
        grants: new PrincipalGrants(organizationId, actor.id, [
          { permissions: platform.permissions, propertyId: null, departmentId: null },
        ]),
      };
    }
    const key = `${organizationId}:${actor.id}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.expires > this.now()) return cached.evaluation;

    const loaded = await this.db.transactionFor<
      IamTables,
      | {
          principal: PrincipalState;
          rows: { permissions: string[]; property: string | null; department: string | null }[];
        }
      | undefined
    >(evaluationContext, IAM_MANIFEST, async (tx) => {
      const user = await tx.db
        .selectFrom('app.iam_user')
        .select(['status', 'realm', 'kind', 'sessions_valid_after'])
        .where('organization_id', '=', organizationId)
        .where('id', '=', actor.id)
        .executeTakeFirst();
      if (user === undefined) return undefined;
      const rows = await tx.db
        .selectFrom('app.iam_role_assignment as a')
        .innerJoin('app.iam_role as r', (join) =>
          join.onRef('r.organization_id', '=', 'a.organization_id').onRef('r.id', '=', 'a.role_id'),
        )
        .select([
          'r.permissions as permissions',
          'a.scope_property_id as property',
          'a.scope_department_id as department',
        ])
        .where('a.organization_id', '=', organizationId)
        .where('a.user_id', '=', actor.id)
        .where('a.status', '=', 'active')
        .where('r.status', '=', 'active')
        .limit(1000)
        .execute();
      return {
        principal: {
          status: user.status,
          realm: user.realm,
          kind: user.kind,
          sessionsValidAfter: user.sessions_valid_after,
        },
        rows,
      };
    });
    if (loaded === undefined) return undefined;

    // CX-19: an assignment scoped to an inactive department grants nothing.
    const departmentIds = loaded.rows
      .map((row) => row.department)
      .filter((d): d is string => d !== null);
    const active =
      departmentIds.length > 0
        ? await this.activeDepartments(evaluationContext, departmentIds)
        : new Set<string>();
    const grants: Grant[] = loaded.rows
      .filter((row) => row.department === null || active.has(row.department))
      .map((row) => ({
        permissions: new Set(row.permissions),
        propertyId: row.property,
        departmentId: row.department,
      }));
    const evaluation: Evaluation = {
      principal: loaded.principal,
      grants: new PrincipalGrants(organizationId, actor.id, grants),
    };
    this.cache.set(key, { evaluation, expires: this.now() + this.options.cacheTtlMs });
    return evaluation;
  }

  /** CX-19: called when assignments, roles or users change (locally and from iam events). */
  invalidate(organizationId: string, actorId?: string): void {
    if (actorId !== undefined) {
      this.cache.delete(`${organizationId}:${actorId}`);
      return;
    }
    for (const key of this.cache.keys())
      if (key.startsWith(`${organizationId}:`)) this.cache.delete(key);
  }

  /**
   * Records an in-tenant authorization denial (map P2: every authorization denial is recorded).
   * Runs in its own short tenant transaction after the business transaction was abandoned.
   */
  async recordDenial(
    ctx: RequestContext,
    permission: string,
    target: AuthorizationTarget,
  ): Promise<void> {
    await this.db.transactionFor(ctx, IAM_MANIFEST, (tx) =>
      appendAudit(tx, IAM_MANIFEST, {
        table: 'authorization_denial',
        action: 'iam.authorization.denied',
        entityType: 'principal',
        entityId: ctx.actor.id,
        entityVersion: null,
        propertyId: target.propertyId ?? null,
        changes: {
          permission: { after: permission },
          property_id: { after: target.propertyId ?? null },
          department_id: { after: target.departmentId ?? null },
        },
      }),
    );
  }
}
