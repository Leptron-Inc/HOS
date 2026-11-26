import 'reflect-metadata';
import { ConfigValidationError, loadConfig } from './config/app-config.js';
import { errorFields } from './kernel/public.js';
import { OpsServer } from './platform/ops/ops-server.js';
import { IntegrityMonitor } from './platform/worker/integrity-monitor.js';
import { WorkerRuntime } from './platform/worker/worker-runtime.js';

/**
 * Worker process entry point: outbox relay, event consumers, workflow runner and scheduler
 * (module map P3; D-018), and the integrity monitor when MONITOR_DATABASE_URL is set (E-46(4)).
 * Connects as hos_worker, hos_relay, hos_seclog_writer and, for the monitor, hos_monitor.
 */
const MONITOR_INTERVAL_MS = 15 * 60_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const worker = new WorkerRuntime(config);
  const logger = worker.services.logger;
  logger.info('worker_started', { build_version: config.buildVersion, node_env: config.nodeEnv });
  worker.start();

  let monitorTimer: NodeJS.Timeout | undefined;
  let lastIntegrity: unknown = null;
  if (config.database.monitorUrl !== null) {
    const monitor = new IntegrityMonitor(
      worker.services.openPool(config.database.monitorUrl, 'monitor', 2),
      logger.child('integrity'),
      worker.services.metrics,
    );
    const runMonitor = () =>
      void monitor.run().then(
        (report) => {
          lastIntegrity = { checked_at: report.checkedAt, violations: report.violations.length };
        },
        (error: unknown) => logger.error('integrity_monitor_failed', errorFields(error)),
      );
    runMonitor();
    monitorTimer = setInterval(runMonitor, MONITOR_INTERVAL_MS);
  }

  const ops =
    config.ops.port > 0
      ? new OpsServer(
          'worker',
          config.buildVersion,
          worker.services.metrics,
          {
            worker: worker.services.runtimePool,
            relay: worker.relayPool,
            seclog: worker.services.seclogPool,
          },
          logger,
          () => Promise.resolve({ integrity: lastIntegrity }),
        )
      : undefined;
  if (ops !== undefined) await ops.listen(config.ops.port, config.ops.host);

  const stop = (signal: NodeJS.Signals) => {
    logger.info('worker_stopping', { signal });
    if (monitorTimer !== undefined) clearInterval(monitorTimer);
    void Promise.all([ops?.close(), worker.stop()]).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

try {
  await main();
} catch (error: unknown) {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
