import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type {
  Denial,
  DenialOutcome,
  TenantStatus,
} from '../../kernel/audit/security-event-writer.js';
import { createRequestContext } from '../../kernel/context/context-factory.js';
import { runWithContext } from '../../kernel/context/context-store.js';
import { ContextMismatchError, isUuid, uuidv5, type RequestContext } from '../../kernel/public.js';
import {
  CredentialError,
  PermissionDeniedError,
  runWithGrants,
  type VerifiedCredential,
} from '../../modules/iam/public/index.js';
import { PlatformServices } from '../platform-services.js';
import { ProblemError } from './problem.js';
import { ROUTE_SCOPE, type RouteScope } from './route-scope.js';
import { requestState } from './request-state.js';

const PROVISIONING_NAMESPACE = '1f7e8a0c-3b2d-4c5e-8f9a-0b1c2d3e4f50';

/**
 * The trusted API entry point (module map §7.1; tenancy specification CX-01, CX-05, CX-06, CX-08,
 * CX-10, CX-15; map §7.2). Establishes the context in the required order BEFORE any tenant-scoped
 * database access, fails closed, records pre-tenant denials in the system security log, and runs
 * the handler as one unit of work under that context and the principal's evaluated grants.
 */
@Injectable()
export class RequestPipelineInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly services: PlatformServices,
  ) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const scope = this.reflector.getAllAndOverride<RouteScope | undefined>(ROUTE_SCOPE, [
      execution.getHandler(),
      execution.getClass(),
    ]);
    const request = execution.switchToHttp().getRequest<Request>();
    if (scope === undefined) throw new ProblemError('internal_error'); // unreachable: startup check (CX-10)
    switch (scope.type) {
      case 'non_tenant':
        return from(this.nonTenant(request, scope.authenticated, next));
      case 'webhook':
        return next.handle(); // the webhook receiver is its own entry point (CX-14)
      case 'provisioning':
        return from(this.provisioning(request, next));
      case 'tenant':
        return from(this.tenant(request, scope.level, next));
    }
  }

  private denial(
    request: Request,
    outcome: DenialOutcome,
    reason: string,
    extra: Partial<Denial> = {},
  ): Denial {
    const state = requestState(request);
    return {
      component: 'api',
      routeTemplate: routeTemplate(request),
      httpMethod: request.method,
      outcome,
      reason,
      requestId: state.requestId,
      actor: null,
      tenantStatus: 'not_evaluated',
      targetTenantId: null,
      claimedTenantUntrusted: null,
      clientCorrelationUntrusted: state.clientCorrelationId,
      sourceAddress: request.socket.remoteAddress ?? null,
      ...extra,
    };
  }

  private async reject(problem: ProblemError, denial: Denial): Promise<never> {
    await this.services.securityLog.record(denial); // never throws: a rejection never depends on logging
    this.services.metrics.increment('hos_security_denials_total', { outcome: denial.outcome });
    throw problem;
  }

  private async authenticate(
    request: Request,
    claimedTenant: string | null,
    tenantStatus: TenantStatus,
  ): Promise<VerifiedCredential> {
    try {
      return await this.services.credentialVerifier.verify(bearer(request));
    } catch (error) {
      const reason = error instanceof CredentialError ? error.reason : 'credential_malformed';
      return this.reject(
        new ProblemError('unauthenticated'),
        this.denial(request, 'authn_failed', reason, {
          claimedTenantUntrusted: claimedTenant,
          tenantStatus,
        }),
      );
    }
  }

  private async nonTenant(
    request: Request,
    authenticated: boolean,
    next: CallHandler,
  ): Promise<unknown> {
    if (authenticated)
      requestState(request).credential = await this.authenticate(request, null, 'not_provided');
    return lastValueFrom(next.handle(), { defaultValue: undefined });
  }

  /** CX-15: only the Control Plane provisioning identity; the context uses the command's IDs. */
  private async provisioning(request: Request, next: CallHandler): Promise<unknown> {
    const claimed = param(request, 'organizationId');
    const credential = await this.authenticate(
      request,
      isUuid(claimed) ? claimed : null,
      'not_evaluated',
    );
    const configured = this.services.config.identity.provisioning;
    if (
      configured === null ||
      credential.issuer !== configured.issuer ||
      credential.subject !== configured.subject ||
      credential.realm !== 'machine'
    ) {
      return this.reject(
        new ProblemError('not_found'),
        this.denial(request, 'authz_denied', 'provisioning_scope_only', {
          actor: null,
          claimedTenantUntrusted: isUuid(claimed) ? claimed : null,
        }),
      );
    }
    if (!isUuid(claimed)) {
      return this.reject(
        new ProblemError('not_found'),
        this.denial(request, 'context_missing', 'tenant_id_malformed'),
      );
    }
    const property = param(request, 'propertyId');
    const context = createRequestContext({
      entryPoint: 'provisioning',
      actor: { id: provisioningActorId(credential), realm: 'machine', kind: 'service_identity' },
      organizationId: claimed,
      properties: isUuid(property)
        ? { kind: 'listed', propertyIds: [property] }
        : { kind: 'all_in_organization' },
      requestId: requestState(request).requestId,
      clientCorrelationId: requestState(request).clientCorrelationId,
    });
    return this.run(
      request,
      context,
      this.services.provisioningGrants(claimed, context.actor.id),
      next,
    );
  }

  private async tenant(
    request: Request,
    level: 'organization' | 'property',
    next: CallHandler,
  ): Promise<unknown> {
    const organizationId = param(request, 'organizationId');
    const propertyId = level === 'property' ? param(request, 'propertyId') : undefined;
    const claimed = isUuid(organizationId) ? organizationId : null;
    // 1. Verify the credential.
    const credential = await this.authenticate(
      request,
      claimed,
      claimed === null ? 'not_provided' : 'not_evaluated',
    );
    if (claimed === null || (level === 'property' && !isUuid(propertyId))) {
      return this.reject(
        new ProblemError('not_found'),
        this.denial(request, 'context_missing', 'tenant_id_malformed'),
      );
    }
    const provisioning = this.services.config.identity.provisioning;
    if (
      provisioning !== null &&
      credential.issuer === provisioning.issuer &&
      credential.subject === provisioning.subject
    ) {
      // CX-15, H-PROV-03: the provisioning identity is denied every other route.
      return this.reject(
        new ProblemError('not_found'),
        this.denial(request, 'authz_denied', 'provisioning_scope_only', {
          claimedTenantUntrusted: claimed,
        }),
      );
    }
    // 2-3. The tenant: organization (and property) exist in this cell and are active.
    const lookup = this.services.tenantLookup;
    const orgStatus = await lookup.organizationStatus(claimed);
    if (orgStatus !== 'active') {
      return this.reject(
        new ProblemError('not_found'),
        this.denial(
          request,
          'tenant_unknown',
          orgStatus === 'not_found' ? 'organization_not_found' : 'organization_inactive',
          { tenantStatus: 'unknown', claimedTenantUntrusted: claimed },
        ),
      );
    }
    if (propertyId !== undefined) {
      const propStatus = await lookup.propertyStatus(claimed, propertyId);
      if (propStatus !== 'active') {
        return this.reject(
          new ProblemError('not_found'),
          this.denial(
            request,
            'tenant_unknown',
            propStatus === 'not_found' ? 'property_not_found' : 'property_inactive',
            { tenantStatus: 'unknown', claimedTenantUntrusted: claimed },
          ),
        );
      }
    }
    // 4. Resolve the principal in the claimed organization.
    const principal = await lookup.resolvePrincipal(claimed, credential.issuer, credential.subject);
    if (principal === undefined || principal.status !== 'active') {
      return this.reject(
        new ProblemError('not_found'),
        this.denial(
          request,
          'authn_failed',
          principal === undefined ? 'principal_unknown' : 'principal_inactive',
          {
            tenantStatus: 'verified_not_authorized',
            targetTenantId: claimed,
            claimedTenantUntrusted: claimed,
          },
        ),
      );
    }
    const actor = {
      id: principal.actorId,
      realm: credential.realm,
      kind: credential.realm === 'machine' ? 'service_identity' : 'user',
    } as const;
    // 5. Evaluate HOS-owned assignments (P2) and check the route's scope.
    const evaluation = await this.services.authorization.evaluate(
      createRequestContext({
        entryPoint: 'api',
        actor,
        organizationId: claimed,
        properties: { kind: 'all_in_organization' },
        requestId: requestState(request).requestId,
      }),
    );
    const verifiedActor = { id: actor.id, realm: actor.realm };
    const deny = (reason: string, outcome: DenialOutcome = 'authz_denied') =>
      this.reject(
        new ProblemError('not_found'),
        this.denial(request, outcome, reason, {
          actor: verifiedActor,
          tenantStatus: 'verified_not_authorized',
          targetTenantId: claimed,
          claimedTenantUntrusted: claimed,
        }),
      );
    if (evaluation === undefined || evaluation.principal.status !== 'active')
      return deny('no_role_in_scope');
    if (evaluation.principal.realm !== credential.realm) return deny('realm_mismatch');
    if (credential.issuedAt < evaluation.principal.sessionsValidAfter) {
      return this.reject(
        new ProblemError('unauthenticated'),
        this.denial(request, 'authn_failed', 'session_revoked', {
          tenantStatus: 'verified_not_authorized',
          targetTenantId: claimed,
          claimedTenantUntrusted: claimed,
        }),
      );
    }
    const grants = evaluation.grants;
    if (propertyId !== undefined ? !grants.coversProperty(propertyId) : grants.grants.length === 0)
      return deny('no_role_in_scope');
    // 6. Build the immutable context; the transaction opens only inside the handler.
    const context = createRequestContext({
      entryPoint: 'api',
      actor,
      organizationId: claimed,
      // A-14: a property route acts on exactly one property; organization routes use the evaluated scope.
      properties:
        propertyId !== undefined
          ? { kind: 'listed', propertyIds: [propertyId] }
          : grants.propertyScope(),
      requestId: requestState(request).requestId,
      clientCorrelationId: requestState(request).clientCorrelationId,
    });
    return this.run(request, context, grants, next);
  }

  private async run(
    request: Request,
    context: RequestContext,
    grants: Parameters<typeof runWithGrants>[0],
    next: CallHandler,
  ): Promise<unknown> {
    requestState(request).context = context;
    try {
      return await runWithContext(context, () =>
        runWithGrants(grants, () => lastValueFrom(next.handle(), { defaultValue: undefined })),
      );
    } catch (error) {
      if (error instanceof PermissionDeniedError) {
        await this.services.authorization
          .recordDenial(context, error.permission, error.target)
          .catch(() => {
            this.services.logger.error('authorization_denial_record_failed', {});
          });
        this.services.metrics.increment('hos_authorization_denials_total', {});
        throw new ProblemError('forbidden');
      }
      if (error instanceof ContextMismatchError) {
        await this.services.securityLog.record(
          this.denial(request, 'context_mismatch', error.reason, {
            actor: { id: context.actor.id, realm: context.actor.realm },
            tenantStatus: 'verified_not_authorized',
            targetTenantId: null,
          }),
        );
        throw new ProblemError(
          'validation_failed',
          'A tenant reference in the request does not match the route.',
        );
      }
      throw error;
    }
  }
}

function param(request: Request, name: string): string | undefined {
  const value = (request.params as Record<string, string | undefined>)[name];
  return typeof value === 'string' ? value : undefined;
}

function bearer(request: Request): string {
  const header = request.headers.authorization;
  if (header === undefined) throw new CredentialError('credential_missing');
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  if (!match || header.length > 8192) throw new CredentialError('credential_malformed');
  return match[1] ?? '';
}

/** Route template only (map §7.2): never path values or the query string. */
export function routeTemplate(request: Request): string | null {
  const route = (request as unknown as { route?: { path?: unknown } }).route;
  const base = typeof request.baseUrl === 'string' ? request.baseUrl : '';
  return route !== undefined && typeof route.path === 'string' ? `${base}${route.path}` : null;
}

export function provisioningActorId(credential: VerifiedCredential): string {
  return uuidv5(PROVISIONING_NAMESPACE, `${credential.issuer}\n${credential.subject}`);
}
