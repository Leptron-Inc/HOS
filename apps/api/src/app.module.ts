import { Injectable, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import type { AppConfig } from './config/app-config.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { IamController, IdentityController } from './platform/http/controllers/iam.controller.js';
import {
  ProvisioningController,
  TenancyController,
} from './platform/http/controllers/tenancy.controller.js';
import { WorkflowController } from './platform/http/controllers/workflow.controller.js';
import {
  ConfigurationController,
  ConfigurationProvisioningController,
} from './platform/http/controllers/configuration.controller.js';
import { SecurityController } from './platform/http/controllers/security.controller.js';
import { IntegrationController } from './platform/http/controllers/integration.controller.js';
import { WebhookController } from './platform/http/controllers/webhook.controller.js';
import { DocumentsController } from './platform/http/controllers/documents.controller.js';
import { ProblemFilter } from './platform/http/problem.filter.js';
import { RequestPipelineInterceptor } from './platform/http/request-pipeline.interceptor.js';
import { RouteScopeCheck } from './platform/http/route-scope.check.js';
import { PlatformServices } from './platform/platform-services.js';

@Injectable()
class PlatformLifecycle implements OnApplicationShutdown {
  constructor(private readonly services: PlatformServices) {}

  async onApplicationShutdown(): Promise<void> {
    // Flushes pending security-log aggregates and ends every pool.
    await this.services.close();
  }
}

@Module({})
export class AppModule {
  static forRoot(
    config: AppConfig,
    services: PlatformServices = new PlatformServices(config, 'api'),
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config),
        DiscoveryModule,
        HealthModule.forRoot(services.runtimePool),
      ],
      controllers: [
        TenancyController,
        ProvisioningController,
        IamController,
        IdentityController,
        WorkflowController,
        ConfigurationController,
        ConfigurationProvisioningController,
        SecurityController,
        IntegrationController,
        WebhookController,
        DocumentsController,
      ],
      providers: [
        { provide: PlatformServices, useValue: services },
        RouteScopeCheck,
        PlatformLifecycle,
        { provide: APP_INTERCEPTOR, useClass: RequestPipelineInterceptor },
        { provide: APP_FILTER, useValue: new ProblemFilter(services) },
      ],
    };
  }
}
