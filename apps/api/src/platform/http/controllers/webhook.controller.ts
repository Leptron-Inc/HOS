import { Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { Denial } from '../../../kernel/audit/security-event-writer.js';
import { createRequestContext } from '../../../kernel/context/context-factory.js';
import { runWithContext } from '../../../kernel/context/context-store.js';
import { latestConnector } from '../../../modules/integration/public/index.js';
import {
  definePlatformIdentity,
  PrincipalGrants,
  runWithGrants,
} from '../../../modules/iam/public/index.js';
import { PlatformServices } from '../../platform-services.js';
import { ProblemError } from '../problem.js';
import { routeTemplate } from '../request-pipeline.interceptor.js';
import { requestState } from '../request-state.js';
import { WebhookRoute } from '../route-scope.js';

/** The P4 webhook receiver identity (cell machine identity, map §1.2): stores receipts only. */
export const WEBHOOK_RECEIVER = definePlatformIdentity('integration.webhook_receiver', []);

/**
 * Inbound webhooks: a trusted entry point (tenancy specification CX-14; map §7.1; H-HOOK).
 * 1. The endpoint ID (unguessable) is resolved by the allowlisted P4 lookup function.
 * 2. The signature is verified BEFORE anything else is processed; nothing is stored on failure.
 * 3. The payload's account is compared with the connector instance; it never chooses a tenant.
 * 4. The raw payload is stored unchanged under the instance's tenant; duplicates are acknowledged
 *    once (provider event ID); processing continues in the background (integration.webhook.received).
 */
@Controller('v1/webhooks')
export class WebhookController {
  constructor(private readonly services: PlatformServices) {}

  private denial(
    request: Request,
    outcome: Denial['outcome'],
    reason: string,
    extra: Partial<Denial> = {},
  ): Denial {
    return {
      component: 'webhooks',
      routeTemplate: routeTemplate(request),
      httpMethod: request.method,
      outcome,
      reason,
      requestId: requestState(request).requestId,
      actor: null,
      tenantStatus: 'not_evaluated',
      targetTenantId: null,
      claimedTenantUntrusted: null,
      clientCorrelationUntrusted: null,
      sourceAddress: request.socket.remoteAddress ?? null,
      ...extra,
    };
  }

  @Post(':provider/:endpointId')
  @WebhookRoute()
  @HttpCode(202)
  async receive(
    @Param('provider') provider: string,
    @Param('endpointId') endpointId: string,
    @Req() request: RawBodyRequest<Request>,
  ) {
    const reject = async (problem: ProblemError, denial: Denial): Promise<never> => {
      await this.services.securityLog.record(denial);
      throw problem;
    };
    const instance = /^[A-Za-z0-9_-]{43}$/.test(endpointId)
      ? await this.services.webhookLookup(endpointId)
      : undefined;
    if (
      instance === undefined ||
      instance.connector_type !== provider ||
      instance.status !== 'active' ||
      instance.credential_ref === null
    ) {
      return reject(
        new ProblemError('not_found'),
        this.denial(request, 'tenant_unknown', 'webhook_endpoint_unknown', {
          tenantStatus: 'unknown',
        }),
      );
    }
    const definition = latestConnector(instance.connector_type);
    const raw = request.rawBody ?? Buffer.alloc(0);
    if (definition?.webhook === undefined)
      return reject(
        new ProblemError('not_found'),
        this.denial(request, 'tenant_unknown', 'webhook_endpoint_unknown', {
          tenantStatus: 'unknown',
        }),
      );
    const credentials = await this.services.secretStore.get(
      instance.organization_id,
      instance.credential_ref,
    );
    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers))
      headers[name] = typeof value === 'string' ? value : undefined;
    if (
      !definition.webhook.verifySignature(raw, headers, credentials, Math.floor(Date.now() / 1000))
    ) {
      return reject(
        new ProblemError('unauthenticated'),
        this.denial(request, 'authn_failed', 'signature_invalid', {
          tenantStatus: 'not_evaluated',
        }),
      );
    }
    const event = definition.webhook.parse(raw);
    if (event === null)
      throw new ProblemError('validation_failed', 'The webhook payload is not valid.');
    if (instance.provider_account_id !== null && event.accountId !== instance.provider_account_id) {
      return reject(
        new ProblemError('validation_failed', 'The payload does not match this endpoint.'),
        this.denial(request, 'context_mismatch', 'webhook_account_mismatch', {
          tenantStatus: 'not_evaluated',
        }),
      );
    }
    const context = createRequestContext({
      entryPoint: 'webhook',
      actor: { id: WEBHOOK_RECEIVER.id, realm: 'machine', kind: 'service_identity' },
      organizationId: instance.organization_id,
      properties:
        instance.property_id !== null
          ? { kind: 'listed', propertyIds: [instance.property_id] }
          : { kind: 'all_in_organization' },
      requestId: requestState(request).requestId,
    });
    const result = await runWithContext(context, () =>
      runWithGrants(new PrincipalGrants(instance.organization_id, WEBHOOK_RECEIVER.id, []), () =>
        this.services.integration.recordWebhook(
          instance.connector_instance_id,
          instance.connector_type,
          event,
          raw,
          String(request.headers['content-type'] ?? 'application/octet-stream'),
        ),
      ),
    );
    return { receipt_id: result.receiptId, duplicate: result.duplicate };
  }
}
