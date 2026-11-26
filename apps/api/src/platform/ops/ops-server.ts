import { createServer, type Server } from 'node:http';
import type pg from 'pg';
import type { Logger, MetricsRegistry } from '../../kernel/public.js';

/**
 * Operations endpoints (P6): Prometheus metrics and diagnostics on a separate port, never on the
 * tenant API. Disabled unless OPS_PORT is set; bound to 127.0.0.1 by default. Access control is the
 * network (private subnet / localhost scrape) because Leptron operations identities do not exist in a
 * cell (map §1.2); hotel staff have no route to it (map P6, Q-18). Responses carry no tenant data.
 */
export interface Diagnostics {
  readonly role: string;
  readonly buildVersion: string;
  readonly nodeVersion: string;
  readonly uptimeSeconds: number;
  readonly memory: { readonly rssBytes: number; readonly heapUsedBytes: number };
  readonly pools: Record<
    string,
    { readonly total: number; readonly idle: number; readonly waiting: number }
  >;
  readonly extra: Record<string, unknown>;
}

export class OpsServer {
  private server: Server | undefined;

  constructor(
    private readonly role: string,
    private readonly buildVersion: string,
    private readonly metrics: MetricsRegistry,
    private readonly pools: Readonly<Record<string, pg.Pool>>,
    private readonly logger: Logger,
    private readonly extra: () => Promise<Record<string, unknown>> = () => Promise.resolve({}),
  ) {
    metrics.set(
      'hos_build_info',
      { role, version: buildVersion.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) },
      1,
    );
  }

  async diagnostics(): Promise<Diagnostics> {
    const memory = process.memoryUsage();
    const pools: Diagnostics['pools'] = {};
    for (const [name, pool] of Object.entries(this.pools))
      pools[name] = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
    return {
      role: this.role,
      buildVersion: this.buildVersion,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memory: { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
      pools,
      extra: await this.extra(),
    };
  }

  listen(port: number, host: string): Promise<number> {
    this.server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.method !== 'GET') {
        response.writeHead(405).end();
        return;
      }
      if (request.url === '/metrics') {
        for (const [name, pool] of Object.entries(this.pools)) {
          this.metrics.set(
            'hos_db_pool_connections',
            { pool: name, state: 'total' },
            pool.totalCount,
          );
          this.metrics.set(
            'hos_db_pool_connections',
            { pool: name, state: 'idle' },
            pool.idleCount,
          );
          this.metrics.set(
            'hos_db_pool_connections',
            { pool: name, state: 'waiting' },
            pool.waitingCount,
          );
        }
        response
          .writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
          .end(this.metrics.render());
        return;
      }
      if (request.url === '/diagnostics') {
        void this.diagnostics().then(
          (body) =>
            response
              .writeHead(200, { 'Content-Type': 'application/json' })
              .end(JSON.stringify(body)),
          () => response.writeHead(500).end(),
        );
        return;
      }
      response.writeHead(404).end();
    });
    return new Promise((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, host, () => {
        const address = this.server?.address();
        const bound = typeof address === 'object' && address !== null ? address.port : port;
        this.logger.info('ops_server_listening', { port: bound });
        resolve(bound);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) =>
      this.server === undefined ? resolve() : this.server.close(() => resolve()),
    );
  }
}
