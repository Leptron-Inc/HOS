import { hostname } from 'node:os';
import type pg from 'pg';
import { requireSettings, type AppConfig } from '../config/app-config.js';
import { SecurityEventWriter } from '../kernel/audit/security-event-writer.js';
import { createPool, endPool } from '../kernel/database/pools.js';
import {
  IdempotencyStore,
  Logger,
  MetricsRegistry,
  TenantDatabase,
  TenantLookup,
} from '../kernel/public.js';
import {
  AuthorizationService,
  CredentialVerifier,
  definePlatformIdentity,
  IamService,
  PrincipalGrants,
} from '../modules/iam/public/index.js';
import { TenancyService } from '../modules/tenancy/public/index.js';
import { WorkflowService } from '../modules/workflow/public/index.js';
import { defineSubscription, type Subscription } from '../kernel/outbox/subscriptions.js';
import { ConfigurationService } from '../modules/configuration/public/index.js';
import {
  CONFIGURATION_MANIFEST,
  type ConfigurationTables,
} from '../modules/configuration/configuration.manifest.js';
import { PropertyProvisioned } from '../modules/tenancy/public/index.js';
import {
  DataRequestModuleCompleted,
  DataRequestReceived,
  SecurityService,
} from '../modules/security/public/index.js';
import { SECURITY_MANIFEST, type SecurityTables } from '../modules/security/security.manifest.js';
import { IAM_MANIFEST } from '../modules/iam/iam.manifest.js';
import {
  IntegrationService,
  LocalEncryptedSecretStore,
  OutboundHttp,
  UnavailableSecretStore,
  type SecretStore,
} from '../modules/integration/public/index.js';
import type { WebhookEndpoint } from '../kernel/database/tenant-lookup.js';
import {
  DocumentService,
  LocalEncryptedDocumentStorage,
  UnavailableDocumentStorage,
} from '../modules/documents/public/index.js';
import type { IamTables } from '../modules/iam/iam.tables.js';

/**
 * Composition root of one process (API or worker): the pools for its login roles, the kernel
 * services, and the module services wired through their public interfaces. Created once at
 * start-up; closed on shutdown.
 */
export type ProcessRole = 'api' | 'worker';

/** The provisioning identity's code-defined grant (CX-15): provisioning only. */
export const PROVISIONING_PERMISSIONS = ['tenant:provision'] as const;
/** The P2 invitation service identity: accepts invitations, nothing else. */
export const INVITATION_SERVICE = definePlatformIdentity('iam.invitation_acceptance', []);

export class PlatformServices {
  readonly logger: Logger;
  readonly metrics = new MetricsRegistry();
  readonly runtimePool: pg.Pool;
  readonly seclogPool: pg.Pool;
  readonly tenantDb: TenantDatabase;
  readonly tenantLookup: TenantLookup;
  readonly securityLog: SecurityEventWriter;
  readonly credentialVerifier: CredentialVerifier;
  readonly idempotency = new IdempotencyStore();
  readonly authorization: AuthorizationService;
  readonly tenancy: TenancyService;
  readonly iam: IamService;
  readonly workflow: WorkflowService;
  readonly configuration: ConfigurationService;
  readonly security: SecurityService;
  readonly secretStore: SecretStore;
  readonly outboundHttp = new OutboundHttp();
  readonly integration: IntegrationService;
  readonly documents: DocumentService;
  private readonly extraPools: pg.Pool[] = [];

  constructor(
    readonly config: AppConfig,
    readonly role: ProcessRole,
  ) {
    requireSettings(
      config,
      role === 'api'
        ? ['cellId', 'seclogUrl', 'issuers']
        : ['cellId', 'seclogUrl', 'workerUrl', 'relayUrl'],
    );
    this.logger = new Logger(`hos-${role}`, config.logLevel);
    const pool = (url: string, name: string, max = config.database.poolMax) =>
      createPool({
        connectionString: url,
        max,
        connectTimeoutMs: config.database.connectTimeoutMs,
        statementTimeoutMs: config.database.statementTimeoutMs,
        applicationName: `${config.database.applicationName}-${name}`,
        onError: (error) =>
          this.logger.error('database_idle_client_error', { pool: name, error_class: error.name }),
      });
    this.runtimePool = pool(
      role === 'api' ? config.database.url : (config.database.workerUrl ?? ''),
      'runtime',
    );
    this.seclogPool = pool(config.database.seclogUrl ?? '', 'seclog', 2);
    this.tenantDb = new TenantDatabase(this.runtimePool, {
      lockTimeoutMs: config.database.lockTimeoutMs,
    });
    this.tenantLookup = new TenantLookup(this.runtimePool);
    this.securityLog = new SecurityEventWriter(this.seclogPool, {
      cellId: config.cellId ?? '',
      writerInstance: `${role}-${hostname()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .slice(0, 40)}-${process.pid}`,
      aggregationWindowMs: config.security.seclogAggregationWindowMs,
      onWriteFailure: (reason) => {
        // A failed security-log write never un-rejects a request; P6 raises an operational alert.
        this.metrics.increment('hos_security_log_write_failures_total', { reason });
        this.logger.error('security_log_write_failed', { reason });
      },
    });
    this.credentialVerifier = new CredentialVerifier(config.identity.issuers);
    this.tenancy = new TenancyService(this.tenantDb, this.idempotency);
    this.authorization = new AuthorizationService(
      this.tenantDb,
      (ctx, ids) => this.tenancy.activeDepartmentIds(ctx, ids),
      { cacheTtlMs: config.identity.grantsCacheTtlMs },
    );
    this.iam = new IamService(this.tenantDb, this.idempotency, this.authorization);
    this.workflow = new WorkflowService(this.tenantDb, this.idempotency);
    this.configuration = new ConfigurationService(this.tenantDb);
    this.security = new SecurityService(this.tenantDb, this.idempotency);
    const storage = config.storage;
    this.secretStore =
      storage.localSecretsDir !== null && storage.localSecretsKey !== null
        ? new LocalEncryptedSecretStore(storage.localSecretsDir, storage.localSecretsKey)
        : new UnavailableSecretStore(); // production: AWS Secrets Manager adapter, needs approved AWS resources (D-025)
    this.integration = new IntegrationService(
      this.tenantDb,
      this.idempotency,
      this.secretStore,
      this.outboundHttp,
      storage.allowInsecureIntegrationHttp,
    );
    const documentStorage =
      storage.documentStorageDir !== null && storage.documentEncryptionKey !== null
        ? new LocalEncryptedDocumentStorage(
            storage.documentStorageDir,
            storage.documentEncryptionKey,
          )
        : new UnavailableDocumentStorage(); // production: S3 + KMS adapter, needs approved AWS resources (D-025)
    this.documents = new DocumentService(
      this.tenantDb,
      this.idempotency,
      documentStorage,
      this.configuration,
      storage.documentMaxBytes,
    );
  }

  /** The provisioning identity holds exactly the provisioning permission, organization-wide (CX-15). */
  provisioningGrants(organizationId: string, actorId: string): PrincipalGrants {
    return new PrincipalGrants(organizationId, actorId, [
      { permissions: new Set(PROVISIONING_PERMISSIONS), propertyId: null, departmentId: null },
    ]);
  }

  /** P4 pre-tenant webhook endpoint lookup (C-21). */
  webhookLookup(endpointId: string): Promise<WebhookEndpoint | undefined> {
    return this.tenantLookup.webhookEndpoint(endpointId);
  }

  /** Event subscriptions of modules other than the workflow engine (wired by the worker). */
  moduleSubscriptions(): readonly Subscription[] {
    return [
      defineSubscription<ConfigurationTables>({
        name: 'configuration.property_provisioned',
        manifest: CONFIGURATION_MANIFEST,
        events: [PropertyProvisioned],
        permissions: ['config:property:change'],
        handle: async (envelope, tx) => {
          const payload = envelope.payload as { property_id: string };
          await this.configuration.initializeProperty(tx, payload.property_id);
        },
      }),
      defineSubscription<IamTables>({
        name: 'iam.data_request_erasure',
        manifest: IAM_MANIFEST,
        events: [DataRequestReceived],
        permissions: ['iam:user:manage'],
        handle: async (envelope, tx) => {
          const payload = envelope.payload as {
            request_id: string;
            request_type: string;
            subject_type: string;
            subject_id: string;
          };
          // Access requests need an export path that does not exist yet; they stay 'received'.
          if (payload.request_type === 'erasure' && payload.subject_type === 'user') {
            await this.iam.eraseUserForRequest(tx, payload.request_id, payload.subject_id);
          }
        },
      }),
      defineSubscription<SecurityTables>({
        name: 'security.data_request_completion',
        manifest: SECURITY_MANIFEST,
        events: [DataRequestModuleCompleted],
        permissions: ['compliance:data_request:process'],
        handle: async (envelope, tx) => {
          const payload = envelope.payload as { request_id: string; module: string };
          await this.security.recordModuleCompletion(tx, payload.request_id, payload.module);
        },
      }),
    ];
  }

  /** Opens an additional pool for another login role (worker relay, monitor). */
  openPool(url: string, name: string, max: number): pg.Pool {
    const pool = createPool({
      connectionString: url,
      max,
      connectTimeoutMs: this.config.database.connectTimeoutMs,
      statementTimeoutMs: this.config.database.statementTimeoutMs,
      applicationName: `${this.config.database.applicationName}-${name}`,
      onError: (error) =>
        this.logger.error('database_idle_client_error', { pool: name, error_class: error.name }),
    });
    this.extraPools.push(pool);
    return pool;
  }

  async close(): Promise<void> {
    await this.securityLog.close().catch(() => undefined);
    for (const pool of [this.runtimePool, this.seclogPool, ...this.extraPools]) await endPool(pool);
  }
}
