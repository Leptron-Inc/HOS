import { Body, Controller, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { code, etag, parse, text, z } from '../../../kernel/public.js';
import { PlatformServices } from '../../platform-services.js';
import { idempotentRequest, queryString, requiredVersion, sendWrite } from '../http-helpers.js';
import { ProvisioningRoute, TenantRoute } from '../route-scope.js';

const DepartmentCreate = z.strictObject({ code: code(), name: text(200) });
const DepartmentUpdate = z.strictObject({
  name: text(200).optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
const ProvisionOrganization = z.strictObject({
  display_name: text(200),
  first_administrator: z.strictObject({ display_name: text(200) }),
});
const ProvisionProperty = z.strictObject({
  display_name: text(200),
  status: z.enum(['active', 'inactive']).default('active'),
});

/** P1 API: organization and property reads, department administration (module map P1). */
@Controller('v1/organizations/:organizationId')
export class TenancyController {
  constructor(private readonly services: PlatformServices) {}

  @Get()
  @TenantRoute('organization')
  organization() {
    return this.services.tenancy.getOrganization();
  }

  @Get('properties')
  @TenantRoute('organization')
  properties(@Req() request: Request) {
    return this.services.tenancy.listProperties(
      queryString(request, 'cursor'),
      queryString(request, 'limit'),
    );
  }

  @Get('properties/:propertyId/departments')
  @TenantRoute('property')
  departments(@Param('propertyId') propertyId: string, @Req() request: Request) {
    return this.services.tenancy.listDepartments(
      propertyId,
      queryString(request, 'cursor'),
      queryString(request, 'limit'),
    );
  }

  @Post('properties/:propertyId/departments')
  @TenantRoute('property')
  async createDepartment(
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(DepartmentCreate, body);
    return sendWrite(
      response,
      await this.services.tenancy.createDepartment(propertyId, input, idempotentRequest(request)),
    );
  }

  @Get('properties/:propertyId/departments/:departmentId')
  @TenantRoute('property')
  async department(
    @Param('propertyId') propertyId: string,
    @Param('departmentId') departmentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.tenancy.getDepartment(propertyId, departmentId);
    response.setHeader('ETag', etag(view.version));
    return view;
  }

  @Patch('properties/:propertyId/departments/:departmentId')
  @TenantRoute('property')
  async updateDepartment(
    @Param('propertyId') propertyId: string,
    @Param('departmentId') departmentId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const changes = parse(DepartmentUpdate, body);
    const view = await this.services.tenancy.updateDepartment(
      propertyId,
      departmentId,
      requiredVersion(request),
      changes,
    );
    response.setHeader('ETag', etag(view.version));
    return view;
  }
}

/**
 * The cell's provisioning API (CX-15; map §7.1 "The first tenant"). Accepts only the Control
 * Plane provisioning identity; creates or updates the organization (with the first-administrator
 * invitation) and properties with the Control Plane's IDs. PUT is idempotent (H-PROV-02).
 */
@Controller('v1/provisioning/organizations/:organizationId')
export class ProvisioningController {
  constructor(private readonly services: PlatformServices) {}

  @Put()
  @ProvisioningRoute()
  async organization(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const input = parse(ProvisionOrganization, body);
    const result = await this.services.tenancy.provisionOrganization(input.display_name);
    // Separate unit of work in P2 (B-20): system role and first administrator invitation, idempotent.
    const admin = await this.services.iam.provisionFirstAdministrator(
      input.first_administrator.display_name,
    );
    response.status(result.created ? 201 : 200);
    return { organization: result.organization, first_administrator_invitation: admin.invitation };
  }

  @Put('properties/:propertyId')
  @ProvisioningRoute()
  async property(
    @Param('propertyId') propertyId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(ProvisionProperty, body);
    const result = await this.services.tenancy.provisionProperty(propertyId, {
      displayName: input.display_name,
      status: input.status,
    });
    response.status(result.created ? 201 : 200);
    return result.property;
  }
}
