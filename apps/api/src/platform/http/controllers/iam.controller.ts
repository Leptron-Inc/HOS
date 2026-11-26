import { Body, Controller, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createRequestContext } from '../../../kernel/context/context-factory.js';
import { runWithContext } from '../../../kernel/context/context-store.js';
import { etag, isUuid, NotFoundError, parse, text, uuid, z } from '../../../kernel/public.js';
import { PrincipalGrants, runWithGrants } from '../../../modules/iam/public/index.js';
import { INVITATION_SERVICE, PlatformServices } from '../../platform-services.js';
import { idempotentRequest, queryString, requiredVersion, sendWrite } from '../http-helpers.js';
import { requestState } from '../request-state.js';
import { NonTenantRoute, TenantRoute } from '../route-scope.js';

const Invite = z.strictObject({
  display_name: text(200),
  realm: z.enum(['hotel_employee', 'guest']),
});
const ServiceIdentity = z.strictObject({
  display_name: text(200),
  issuer: text(500),
  subject: text(500),
});
const RoleCreate = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  name: text(200),
  permissions: z.array(text(128)).max(500),
});
const RoleUpdate = z.strictObject({
  name: text(200).optional(),
  permissions: z.array(text(128)).max(500).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
const AssignmentCreate = z.strictObject({
  user_id: uuid(),
  role_id: uuid(),
  scope_property_id: uuid().nullable().default(null),
  scope_department_id: uuid().nullable().default(null),
});
const Accept = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const Status = z.strictObject({ status: z.enum(['active', 'inactive']) });

/** P2 API (module map P2: /v1/users, /v1/roles, /v1/role-assignments, /v1/service-identities). */
@Controller('v1/organizations/:organizationId')
export class IamController {
  constructor(private readonly services: PlatformServices) {}

  @Get('users')
  @TenantRoute('organization')
  users(@Req() request: Request) {
    return this.services.iam.listUsers(
      queryString(request, 'cursor'),
      queryString(request, 'limit'),
    );
  }

  @Post('users')
  @TenantRoute('organization')
  async invite(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(Invite, body);
    return sendWrite(
      response,
      await this.services.iam.inviteUser(
        { displayName: input.display_name, realm: input.realm },
        idempotentRequest(request),
      ),
    );
  }

  @Post('users/:userId/status')
  @TenantRoute('organization')
  async status(
    @Param('userId') userId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(Status, body);
    const view = await this.services.iam.setUserStatus(
      userId,
      requiredVersion(request),
      input.status,
    );
    response.status(200).setHeader('ETag', etag(view.version));
    return view;
  }

  @Post('users/:userId/sessions/revoke')
  @TenantRoute('organization')
  async revokeSessions(
    @Param('userId') userId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.services.iam.revokeSessions(userId);
    response.status(204);
  }

  @Post('service-identities')
  @TenantRoute('organization')
  async serviceIdentity(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(ServiceIdentity, body);
    return sendWrite(
      response,
      await this.services.iam.registerServiceIdentity(
        { displayName: input.display_name, issuer: input.issuer, subject: input.subject },
        idempotentRequest(request),
      ),
    );
  }

  @Get('roles')
  @TenantRoute('organization')
  roles() {
    return this.services.iam.listRoles().then((data) => ({ data }));
  }

  @Post('roles')
  @TenantRoute('organization')
  async createRole(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(RoleCreate, body);
    return sendWrite(
      response,
      await this.services.iam.createRole(input, idempotentRequest(request)),
    );
  }

  @Patch('roles/:roleId')
  @TenantRoute('organization')
  async updateRole(
    @Param('roleId') roleId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.iam.updateRole(
      roleId,
      requiredVersion(request),
      parse(RoleUpdate, body),
    );
    response.setHeader('ETag', etag(view.version));
    return view;
  }

  @Get('role-assignments')
  @TenantRoute('organization')
  assignments(@Req() request: Request) {
    const userId = queryString(request, 'user_id');
    return this.services.iam
      .listAssignments(userId !== undefined && isUuid(userId) ? userId : undefined)
      .then((data) => ({ data }));
  }

  @Post('role-assignments')
  @TenantRoute('organization')
  async assign(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(AssignmentCreate, body);
    return sendWrite(
      response,
      await this.services.iam.assignRole(
        {
          userId: input.user_id,
          roleId: input.role_id,
          propertyId: input.scope_property_id,
          departmentId: input.scope_department_id,
        },
        idempotentRequest(request),
      ),
    );
  }

  @Post('role-assignments/:assignmentId/revoke')
  @TenantRoute('organization')
  async revoke(
    @Param('assignmentId') assignmentId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.iam.revokeAssignment(assignmentId, requiredVersion(request));
    response.status(200).setHeader('ETag', etag(view.version));
    return view;
  }
}

/** Non-tenant routes (CX-10): the caller's memberships, and invitation acceptance. */
@Controller('v1')
export class IdentityController {
  constructor(private readonly services: PlatformServices) {}

  /** Lists the organizations where the verified subject is active, only after verification (CX-10). */
  @Get('me')
  @NonTenantRoute(true)
  async me(@Req() request: Request) {
    const credential = requestState(request).credential;
    if (credential === undefined) throw new NotFoundError();
    const organizations = await this.services.tenantLookup.listMemberships(
      credential.issuer,
      credential.subject,
    );
    return { realm: credential.realm, organizations };
  }

  /**
   * Binds the verified identity to an invited principal. Runs as the P2 invitation service identity
   * in the named organization; the 256-bit single-use token is the authorization (PROVISIONAL).
   */
  @Post('organizations/:organizationId/invitations/accept')
  @NonTenantRoute(true)
  async accept(
    @Param('organizationId') organizationId: string,
    @Body() body: unknown,
    @Req() request: Request,
  ) {
    const credential = requestState(request).credential;
    if (credential === undefined || !isUuid(organizationId) || credential.realm === 'machine')
      throw new NotFoundError();
    const input = parse(Accept, body);
    if ((await this.services.tenantLookup.organizationStatus(organizationId)) !== 'active')
      throw new NotFoundError();
    const context = createRequestContext({
      entryPoint: 'api',
      actor: { id: INVITATION_SERVICE.id, realm: 'machine', kind: 'service_identity' },
      organizationId,
      properties: { kind: 'all_in_organization' },
      requestId: requestState(request).requestId,
      clientCorrelationId: requestState(request).clientCorrelationId,
    });
    return runWithContext(context, () =>
      runWithGrants(new PrincipalGrants(organizationId, INVITATION_SERVICE.id, []), () =>
        this.services.iam.acceptInvitation(input.token, credential),
      ),
    );
  }
}
