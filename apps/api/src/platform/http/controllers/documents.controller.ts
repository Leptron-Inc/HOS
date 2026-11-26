import { Body, Controller, Delete, Get, Param, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { etag, parse, text, uuid, ValidationError, z } from '../../../kernel/public.js';
import { DOCUMENT_CLASSES } from '../../../modules/documents/public/index.js';
import { PlatformServices } from '../../platform-services.js';
import { idempotentRequest, queryString, requiredVersion, sendWrite } from '../http-helpers.js';
import { TenantRoute } from '../route-scope.js';

const Create = z.strictObject({
  document_class: z.enum(DOCUMENT_CLASSES),
  title: text(300),
  scope_level: z.enum(['organization', 'property']),
  property_id: uuid().nullable().default(null),
});
export const UPLOAD_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
  'application/octet-stream',
];

/** P5 API (module map P5: /v1/documents). Downloads are streamed by P5 (no presigned URLs in this phase). */
@Controller('v1/organizations/:organizationId/documents')
export class DocumentsController {
  constructor(private readonly services: PlatformServices) {}

  @Post()
  @TenantRoute('organization')
  async create(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(Create, body);
    if ((input.scope_level === 'property') !== (input.property_id !== null))
      throw new ValidationError([
        { path: 'property_id', message: 'required exactly for property scope' },
      ]);
    return sendWrite(
      response,
      await this.services.documents.create(
        {
          documentClass: input.document_class,
          title: input.title,
          scopeLevel: input.scope_level,
          propertyId: input.property_id,
        },
        idempotentRequest(request),
      ),
    );
  }

  @Get()
  @TenantRoute('organization')
  search(@Req() request: Request) {
    const documentClass = DOCUMENT_CLASSES.find((c) => c === queryString(request, 'class')) ?? null;
    const prefix = queryString(request, 'title_prefix');
    return this.services.documents.search({
      documentClass,
      titlePrefix: prefix !== undefined && prefix.length <= 100 ? prefix : null,
      cursor: queryString(request, 'cursor'),
      limit: queryString(request, 'limit'),
    });
  }

  @Get(':documentId')
  @TenantRoute('organization')
  async get(
    @Param('documentId') documentId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.documents.get(documentId);
    response.setHeader('ETag', etag(view.version));
    return view;
  }

  @Put(':documentId/content')
  @TenantRoute('organization')
  async upload(
    @Param('documentId') documentId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const contentType =
      String(request.headers['content-type'] ?? '')
        .split(';')[0]
        ?.trim() ?? '';
    if (!UPLOAD_CONTENT_TYPES.includes(contentType) || !Buffer.isBuffer(request.body)) {
      throw new ValidationError([
        { path: 'Content-Type', message: `must be one of ${UPLOAD_CONTENT_TYPES.join(', ')}` },
      ]);
    }
    const view = await this.services.documents.upload(
      documentId,
      requiredVersion(request),
      request.body,
      contentType,
    );
    response.setHeader('ETag', etag(view.version));
    return view;
  }

  @Get(':documentId/content')
  @TenantRoute('organization')
  async download(
    @Param('documentId') documentId: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const raw = queryString(request, 'version');
    const version = raw !== undefined && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
    const file = await this.services.documents.download(documentId, version);
    response
      .status(200)
      .setHeader('Content-Type', file.contentType)
      .setHeader('Content-Disposition', 'attachment')
      .setHeader('Cache-Control', 'no-store')
      .setHeader('Referrer-Policy', 'no-referrer')
      .setHeader('Digest', `sha-256=${Buffer.from(file.sha256, 'hex').toString('base64')}`)
      .send(file.content);
  }

  @Delete(':documentId')
  @TenantRoute('organization')
  async remove(
    @Param('documentId') documentId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const view = await this.services.documents.delete(documentId, requiredVersion(request));
    response.setHeader('ETag', etag(view.version));
    return view;
  }
}
