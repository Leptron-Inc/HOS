import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { etag, isUuid, parse, text, uuid, z } from '../../../kernel/public.js';
import { PlatformServices } from '../../platform-services.js';
import { idempotentRequest, queryString, requiredVersion, sendWrite } from '../http-helpers.js';
import { TenantRoute } from '../route-scope.js';

const DefinitionCreate = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  name: text(200),
  steps: z.array(z.unknown()).min(1).max(50),
  trigger_event: z
    .string()
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/)
    .nullable()
    .default(null),
});
const InstanceStart = z.strictObject({
  definition_code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  property_id: uuid().nullable().default(null),
  input: z.record(z.string(), z.unknown()).default({}),
});
const Decision = z.strictObject({ decision: z.enum(['approve', 'reject']) });
const TaskCreate = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  definition_code: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  interval_seconds: z.number().int().min(60).max(31_536_000),
  property_id: uuid().nullable().default(null),
  input: z.record(z.string(), z.unknown()).default({}),
});

/** P3 API (module map P3: /v1/workflows, /v1/approvals, /v1/scheduled-tasks; dead-letter replay). */
@Controller('v1/organizations/:organizationId')
export class WorkflowController {
  constructor(private readonly services: PlatformServices) {}

  @Get('workflow-definitions')
  @TenantRoute('organization')
  definitions() {
    return this.services.workflow.listDefinitions().then((data) => ({ data }));
  }

  @Post('workflow-definitions')
  @TenantRoute('organization')
  async createDefinition(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    return sendWrite(
      response,
      await this.services.workflow.createDefinition(
        parse(DefinitionCreate, body),
        idempotentRequest(request),
      ),
    );
  }

  @Post('workflow-definitions/:definitionId/publish')
  @TenantRoute('organization')
  async publish(
    @Param('definitionId') definitionId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.workflow.publishDefinition(
      definitionId,
      requiredVersion(request),
    );
    response.status(200).setHeader('ETag', etag(view.version));
    return view;
  }

  @Post('workflow-instances')
  @TenantRoute('organization')
  async start(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(InstanceStart, body);
    return sendWrite(
      response,
      await this.services.workflow.startInstance(
        {
          definitionCode: input.definition_code,
          propertyId: input.property_id,
          input: input.input,
        },
        idempotentRequest(request),
      ),
    );
  }

  @Get('workflow-instances/:instanceId')
  @TenantRoute('organization')
  instance(@Param('instanceId') instanceId: string) {
    return this.services.workflow.getInstance(instanceId);
  }

  @Post('workflow-instances/:instanceId/cancel')
  @TenantRoute('organization')
  async cancel(
    @Param('instanceId') instanceId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.workflow.cancelInstance(instanceId, requiredVersion(request));
    response.status(200).setHeader('ETag', etag(view.version));
    return view;
  }

  @Get('approvals')
  @TenantRoute('organization')
  approvals(@Req() request: Request) {
    const status = queryString(request, 'status');
    const allowed = ['pending', 'approved', 'rejected', 'cancelled'] as const;
    return this.services.workflow
      .listApprovals(
        allowed.find((s) => s === status),
        queryString(request, 'limit'),
      )
      .then((data) => ({ data }));
  }

  @Post('approvals/:approvalId/decision')
  @TenantRoute('organization')
  async decide(
    @Param('approvalId') approvalId: string,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.workflow.decide(
      approvalId,
      requiredVersion(request),
      parse(Decision, body).decision,
    );
    response.status(200).setHeader('ETag', etag(view.version));
    return view;
  }

  @Post('scheduled-tasks')
  @TenantRoute('organization')
  async createTask(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(TaskCreate, body);
    return sendWrite(
      response,
      await this.services.workflow.createScheduledTask(
        {
          code: input.code,
          definitionCode: input.definition_code,
          intervalSeconds: input.interval_seconds,
          propertyId: input.property_id,
          input: input.input,
        },
        idempotentRequest(request),
      ),
    );
  }

  @Get('dead-letters')
  @TenantRoute('organization')
  deadLetters(@Req() request: Request) {
    const status = queryString(request, 'status');
    const after = queryString(request, 'after');
    const allowed = ['dead', 'replay_requested', 'replayed'] as const;
    return this.services.workflow
      .deadLetters(
        allowed.find((s) => s === status) ?? null,
        queryString(request, 'limit'),
        after !== undefined && isUuid(after) ? after : null,
      )
      .then((data) => ({ data }));
  }

  @Post('dead-letters/:deadLetterId/replay')
  @TenantRoute('organization')
  async replay(
    @Param('deadLetterId') deadLetterId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.workflow.replayDeadLetter(
      deadLetterId,
      requiredVersion(request),
    );
    response.status(200).setHeader('ETag', etag(view.version));
    return view;
  }
}
