# Database kernel (layer L0)

This folder is the only place in the API that may use the PostgreSQL driver (`pg`) or Kysely
directly. It implements the "L0 Database and context" layer of the module map (§7.1).

Rules (enforced by `.dependency-cruiser.cjs`):

- Only files in this folder may import `pg`, `pg-pool` or `kysely`.
- Code outside this folder may import only `database.module.ts` and
  `database-health.indicator.ts`.
- Business modules (`apps/api/src/modules/**`) may not import anything from this folder.
  They will reach the database only through the tenant transaction mechanism defined in the
  tenancy specification (C-06, C-07, B-07, B-22), which a later Milestone 1 step adds to the
  kernel. The raw database handle is deliberately not exported.
