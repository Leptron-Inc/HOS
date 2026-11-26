import type { NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/app-config.js';
import { requestMiddleware } from './platform/http/request.middleware.js';
import { PlatformServices } from './platform/platform-services.js';
import { UPLOAD_CONTENT_TYPES } from './platform/http/controllers/documents.controller.js';

/**
 * Creates the HTTP application with the settings every entry point (the server and the
 * integration tests) must share.
 */
export async function createHttpApp(
  config: AppConfig,
  options: NestApplicationOptions = {},
  services?: PlatformServices,
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config, services),
    { ...options, bodyParser: false, rawBody: true },
  );
  // Do not advertise the server framework in response headers.
  app.disable('x-powered-by');
  // Request ID, trace context, security headers and the rate limit run before body parsing.
  app.use(requestMiddleware(app.get(PlatformServices)));
  // JSON bodies only, bounded size (protective safeguard); anything larger is a 413 problem.
  app.useBodyParser('json', { limit: config.security.bodyLimitBytes, strict: true });
  // Document uploads (P5): raw bytes for the allowlisted content types, bounded size.
  app.useBodyParser('raw', { type: UPLOAD_CONTENT_TYPES, limit: config.storage.documentMaxBytes });
  // SIGTERM / SIGINT trigger onApplicationShutdown hooks (the pools are closed there).
  app.enableShutdownHooks();
  return app;
}
