import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createHttpApp } from './app.factory.js';
import { ConfigValidationError, loadConfig } from './config/app-config.js';
import { OpsServer } from './platform/ops/ops-server.js';
import { PlatformServices } from './platform/platform-services.js';

async function bootstrap(): Promise<void> {
  // Fail fast, before any connection is attempted, if the environment is invalid.
  const config = loadConfig(process.env);
  const app = await createHttpApp(config);
  await app.listen(config.port, config.host);
  // The build version is logged here rather than exposed by the unauthenticated health endpoints.
  Logger.log(
    `HOS API ${config.buildVersion} (${config.nodeEnv}) listening on http://${config.host}:${config.port}`,
    'Bootstrap',
  );
  if (config.ops.port > 0) {
    const services = app.get(PlatformServices);
    const ops = new OpsServer(
      'api',
      config.buildVersion,
      services.metrics,
      { runtime: services.runtimePool, seclog: services.seclogPool },
      services.logger,
    );
    await ops.listen(config.ops.port, config.ops.host);
    process.once('beforeExit', () => void ops.close());
  }
}

try {
  await bootstrap();
} catch (error: unknown) {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
