/**
 * Module-boundary rules (HOS module map G2, §7.1 layers; tenancy specification B-07, CX-01, F-15,
 * F-17). Run after `pnpm build` so workspace packages resolve to their built output.
 *
 * API layout: src/kernel (L0-L1 primitives and writers), src/modules (P1-P8 and later modules),
 * src/platform (trusted entry points: HTTP pipeline, worker, webhooks, ops; composition root).
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        "Every import must resolve. 'express' is imported for types only (served by @types/express), never at runtime.",
      severity: 'error',
      from: {},
      to: { couldNotResolve: true, pathNot: '^express$' },
    },
    {
      name: 'apps-are-independent',
      comment: 'An application never imports code from another application.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/[^/]+/', pathNot: '^apps/$1/' },
    },
    {
      name: 'packages-do-not-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'shared-stays-framework-free',
      comment:
        'packages/shared holds contracts and small utilities only: no framework, database or UI code.',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: {
        path: [
          'node_modules/(@nestjs|react|react-dom|kysely|pg|vite)/',
          'node_modules/\\.pnpm/[^/]+/node_modules/(@nestjs|react|react-dom|kysely|pg|vite)/',
        ],
      },
    },
    {
      name: 'api-modules-use-public-interfaces',
      comment:
        'A module may use another module only through modules/<name>/public (tenancy specification F-15).',
      severity: 'error',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/[^/]+/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/public/'],
      },
    },
    {
      name: 'database-drivers-only-in-infrastructure',
      comment:
        'pg and Kysely are used only by the kernel (L0-L1) and the platform entry points (relay, worker, ops, health). Modules never touch a driver: they use the tenant transaction (tenancy specification B-22, C-07). Tests are exempt.',
      severity: 'error',
      from: {
        path: '^(apps|packages)/',
        pathNot: [
          '^apps/api/src/kernel/',
          '^apps/api/src/platform/',
          '^apps/api/src/health/',
          '^apps/api/test/',
        ],
      },
      to: {
        path: [
          'node_modules/(kysely|pg|pg-pool)/',
          'node_modules/\\.pnpm/[^/]+/node_modules/(kysely|pg|pg-pool)/',
        ],
      },
    },
    {
      name: 'modules-use-only-the-kernel-public-surface',
      comment:
        'Modules import the kernel only through kernel/public.ts: no pools, connections, context factory or kernel internals (F-15, module map §7.1).',
      severity: 'error',
      from: { path: '^apps/api/src/modules/' },
      to: {
        path: '^apps/api/src/kernel/',
        pathNot: '^apps/api/src/kernel/(public|database/public)\\.ts$',
      },
    },
    {
      name: 'context-factory-only-in-trusted-entry-points',
      comment:
        'A RequestContext is created only by the trusted entry points in src/platform (tenancy specification CX-01, H-CTX-10).',
      severity: 'error',
      from: {
        path: '^apps/api/src/',
        pathNot: ['^apps/api/src/platform/', '^apps/api/src/kernel/context/'],
      },
      to: { path: '^apps/api/src/kernel/context/context-factory\\.ts$' },
    },
    {
      name: 'kernel-does-not-depend-on-higher-layers',
      comment:
        'Dependencies point down the layers only (module map §7.1): the kernel never imports modules or entry points.',
      severity: 'error',
      from: { path: '^apps/api/src/kernel/' },
      to: { path: '^apps/api/src/(modules|platform|health)/' },
    },
    {
      name: 'modules-do-not-depend-on-entry-points',
      comment: 'Modules never import the HTTP layer, the worker runtime or the composition root.',
      severity: 'error',
      from: { path: '^apps/api/src/modules/' },
      to: { path: '^apps/api/src/(platform|health)/' },
    },
  ],
  options: {
    parser: 'swc',
    doNotFollow: { path: 'node_modules' },
    // Anchored to workspace build output only: an unanchored "dist/" would also drop npm
    // packages that ship from dist/ (for example kysely), hiding them from every rule.
    exclude: { path: '^(apps|packages)/[^/]+/(dist|coverage|\\.turbo)/' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.json'],
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
    },
  },
};
