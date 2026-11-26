import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { parse, text, ValidationError, versionFromIfMatch, z } from '../../../kernel/public.js';
import { PlatformServices } from '../../platform-services.js';
import { ProvisioningRoute, TenantRoute } from '../route-scope.js';

const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/;
const OrganizationChange = z.strictObject({ value: z.unknown(), reason: text(500) });
const PropertyChange = z.strictObject({
  value: z.unknown(),
  reason: text(500),
  effective_from: z.iso.datetime({ offset: false }).optional(),
});
const Snapshot = z.strictObject({
  template_code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  template_version: z.number().int().min(1),
  values: z.record(z.string().regex(KEY), z.unknown()),
  locked_keys: z.array(z.string().regex(KEY)).max(200).default([]),
});

function settingKey(key: string): string {
  if (!KEY.test(key)) throw new ValidationError([{ path: 'key', message: 'invalid setting key' }]);
  return key;
}

/** P8 API (module map P8: /v1/configuration). */
@Controller('v1/organizations/:organizationId')
export class ConfigurationController {
  constructor(private readonly services: PlatformServices) {}

  @Get('configuration')
  @TenantRoute('organization')
  organization() {
    return this.services.configuration.effective(null);
  }

  @Put('configuration/:key')
  @TenantRoute('organization')
  setOrganization(@Param('key') key: string, @Body() body: unknown, @Req() request: Request) {
    const input = parse(OrganizationChange, body);
    const header = request.headers['if-match'];
    return this.services.configuration.setOrganizationSetting(
      settingKey(key),
      input.value ?? null,
      input.reason,
      versionFromIfMatch(typeof header === 'string' ? header : undefined),
    );
  }

  @Get('configuration/:key/history')
  @TenantRoute('organization')
  organizationHistory(@Param('key') key: string) {
    return this.services.configuration.history(null, settingKey(key)).then((data) => ({ data }));
  }

  @Get('properties/:propertyId/configuration')
  @TenantRoute('property')
  property(@Param('propertyId') propertyId: string) {
    return this.services.configuration.effective(propertyId);
  }

  @Put('properties/:propertyId/configuration/:key')
  @TenantRoute('property')
  setProperty(
    @Param('propertyId') propertyId: string,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    const input = parse(PropertyChange, body);
    const effectiveFrom =
      input.effective_from !== undefined ? new Date(input.effective_from) : new Date();
    return this.services.configuration.setPropertySetting(
      propertyId,
      settingKey(key),
      input.value ?? null,
      input.reason,
      effectiveFrom,
    );
  }

  @Get('properties/:propertyId/configuration/:key/history')
  @TenantRoute('property')
  propertyHistory(@Param('propertyId') propertyId: string, @Param('key') key: string) {
    return this.services.configuration
      .history(propertyId, settingKey(key))
      .then((data) => ({ data }));
  }
}

/** The provisioning configuration snapshot (CX-15): template values from the Control Plane. */
@Controller('v1/provisioning/organizations/:organizationId/properties/:propertyId')
export class ConfigurationProvisioningController {
  constructor(private readonly services: PlatformServices) {}

  @Put('configuration-snapshot')
  @ProvisioningRoute()
  snapshot(@Param('propertyId') propertyId: string, @Body() body: unknown) {
    const input = parse(Snapshot, body);
    return this.services.configuration.applySnapshot(propertyId, {
      templateCode: input.template_code,
      templateVersion: input.template_version,
      values: input.values,
      lockedKeys: input.locked_keys,
    });
  }
}
