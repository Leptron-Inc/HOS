import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { isUuid, parse, uuid, z } from '../../../kernel/public.js';
import { PlatformServices } from '../../platform-services.js';
import { idempotentRequest, queryString, sendWrite } from '../http-helpers.js';
import { TenantRoute } from '../route-scope.js';

const DataRequest = z.strictObject({
  request_type: z.enum(['access', 'erasure']),
  subject_type: z.enum(['user']),
  subject_id: uuid(),
});

/** P7 API (module map P7: /v1/audit, /v1/data-requests). */
@Controller('v1/organizations/:organizationId')
export class SecurityController {
  constructor(private readonly services: PlatformServices) {}

  @Get('audit-records')
  @TenantRoute('organization')
  audit(@Req() request: Request) {
    const entityType = queryString(request, 'entity_type');
    const entityId = queryString(request, 'entity_id');
    const after = queryString(request, 'after_sequence');
    return this.services.security
      .auditRecords({
        entityType:
          entityType !== undefined && /^[a-z][a-z0-9_]{0,63}$/.test(entityType) ? entityType : null,
        entityId: entityId !== undefined && isUuid(entityId) ? entityId : null,
        afterSequence: after !== undefined && /^\d{1,15}$/.test(after) ? Number(after) : null,
        limit: queryString(request, 'limit'),
      })
      .then((data) => ({ data }));
  }

  @Get('audit-records/verification')
  @TenantRoute('organization')
  verification() {
    return this.services.security.verifyAuditChain();
  }

  @Post('data-requests')
  @TenantRoute('organization')
  async createDataRequest(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(DataRequest, body);
    return sendWrite(
      response,
      await this.services.security.createDataRequest(
        {
          requestType: input.request_type,
          subjectType: input.subject_type,
          subjectId: input.subject_id,
        },
        idempotentRequest(request),
      ),
    );
  }

  @Get('data-requests/:requestId')
  @TenantRoute('organization')
  dataRequest(@Param('requestId') requestId: string) {
    return this.services.security.getDataRequest(requestId);
  }
}
