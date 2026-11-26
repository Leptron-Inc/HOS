import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { etag, NotFoundError, parse, text, uuid, z } from '../../../kernel/public.js';
import { PlatformServices } from '../../platform-services.js';
import { idempotentRequest, queryString, requiredVersion, sendWrite } from '../http-helpers.js';
import { TenantRoute } from '../route-scope.js';

const Configure = z.strictObject({
  connector_type: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  connector_version: z.number().int().min(1),
  scope_level: z.enum(['organization', 'property']),
  property_id: uuid().nullable().default(null),
  display_name: text(200),
  settings: z.record(z.string(), z.unknown()).default({}),
  credentials: z.record(z.string().max(64), z.string().min(1).max(4096)),
  provider_account_id: text(200).nullable().default(null),
});
const Rotate = z.strictObject({
  credentials: z.record(z.string().max(64), z.string().min(1).max(4096)),
});

/** P4 API (module map P4: /v1/connectors, /v1/connector-instances). Credentials go in, never come out. */
@Controller('v1/organizations/:organizationId')
export class IntegrationController {
  constructor(private readonly services: PlatformServices) {}

  @Get('connectors')
  @TenantRoute('organization')
  catalogue() {
    return { data: this.services.integration.catalogue() };
  }

  @Get('connector-instances')
  @TenantRoute('organization')
  instances() {
    return this.services.integration.list().then((data) => ({ data }));
  }

  @Post('connector-instances')
  @TenantRoute('organization')
  async configure(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(Configure, body);
    return sendWrite(
      response,
      await this.services.integration.configure(
        {
          type: input.connector_type,
          version: input.connector_version,
          scopeLevel: input.scope_level,
          propertyId: input.property_id,
          displayName: input.display_name,
          settings: input.settings,
          credentials: input.credentials,
          providerAccountId: input.provider_account_id,
        },
        idempotentRequest(request),
      ),
    );
  }

  @Post('connector-instances/:instanceId/health-check')
  @TenantRoute('organization')
  async verify(
    @Param('instanceId') instanceId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.integration.verify(instanceId);
    response.status(200).setHeader('ETag', etag(view.version));
    return view;
  }

  @Post('connector-instances/:instanceId/:transition')
  @TenantRoute('organization')
  async transition(
    @Param('instanceId') instanceId: string,
    @Param('transition') transition: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const version = requiredVersion(request);
    const integration = this.services.integration;
    const view =
      transition === 'activate'
        ? await integration.activate(instanceId, version)
        : transition === 'suspend'
          ? await integration.suspend(instanceId, version)
          : transition === 'retire'
            ? await integration.retire(instanceId, version)
            : transition === 'rotate-credentials'
              ? await integration.rotateCredentials(
                  instanceId,
                  version,
                  parse(Rotate, body).credentials,
                )
              : undefined;
    if (view === undefined) throw new NotFoundError();
    response.status(200).setHeader('ETag', etag(view.version));
    return view;
  }

  @Get('connector-instances/:instanceId/logs')
  @TenantRoute('organization')
  logs(@Param('instanceId') instanceId: string, @Req() request: Request) {
    return this.services.integration
      .logs(instanceId, queryString(request, 'limit'))
      .then((data) => ({ data }));
  }
}
