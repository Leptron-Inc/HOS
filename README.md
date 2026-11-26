# HOS by Leptron

HOS (HospitalityOS) is a global hotel operating system by Leptron. Hotels and hotel groups of any size in any country use the same architecture, with regional differences handled through configuration.

**Status:** pre-implementation. The architecture, the 46-module map and the tenancy and data conventions specification are approved as the engineering baseline; application development has not started. See [CURRENT_STATE.md](CURRENT_STATE.md).

## Authoritative documents

| Document | Purpose |
|---|---|
| [PROJECT_RULES.md](PROJECT_RULES.md) | Mandatory engineering operating protocol |
| [CLAUDE.md](CLAUDE.md) | Session instructions for Claude Code |
| [CURRENT_STATE.md](CURRENT_STATE.md) | Current status, open decisions and next tasks |
| [docs/blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png](docs/blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png) | Approved master product blueprint (product scope) |
| [docs/blueprint/BLUEPRINT_INTERPRETATION.md](docs/blueprint/BLUEPRINT_INTERPRETATION.md) | Text transcription of the blueprint |
| [docs/blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md](docs/blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md) | Open items (U-001 onward) |
| [docs/DECISION_LOG.md](docs/DECISION_LOG.md) | Approved decisions (D-001 onward) |
| [docs/architecture/TECHNICAL_ARCHITECTURE.md](docs/architecture/TECHNICAL_ARCHITECTURE.md) | Technical architecture, recommendations and the first milestone |
| [docs/architecture/HOS_MODULE_MAP.md](docs/architecture/HOS_MODULE_MAP.md) | Approved module map: the 46 modules, ownership rulings MM-01 to MM-16, implementation tiers, blueprint reconciliation |
| [docs/architecture/TENANCY_AND_DATA_CONVENTIONS.md](docs/architecture/TENANCY_AND_DATA_CONVENTIONS.md) | Approved implementation baseline (revision 2.1) for tenancy, data, row-level security, API and migration conventions; its §11 tooling choices are still provisional |
| [docs/architecture/validation/tenancy-2.1-sql-harness/](docs/architecture/validation/tenancy-2.1-sql-harness/README.md) | The SQL validation harness and run logs for that specification |

If documents conflict, the blueprint and the decision log take precedence.

## Development

**Prerequisites:** Node.js 26.13.1 (see `.nvmrc`), pnpm 12.23.0, and a PostgreSQL database you can use for development.

| Workspace | Purpose |
|---|---|
| `apps/api` | NestJS API (liveness and readiness endpoints, validated configuration, database kernel) |
| `apps/web` | React + Vite web application shell |
| `packages/shared` | Contracts shared by the applications (no business logic) |
| `packages/config` | Shared TypeScript, ESLint and Prettier configuration |

```sh
pnpm install

# API: copy apps/api/.env.example to apps/api/.env and set NODE_ENV and DATABASE_URL, then:
pnpm --filter @hos/api dev        # http://127.0.0.1:3000/health/live and /health/ready

# Web (proxies /api to the API):
pnpm --filter @hos/web dev        # http://localhost:5173

# Checks (the same steps CI runs):
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build && pnpm depcruise && pnpm test
DATABASE_URL=postgres://USER@HOST:5432/DATABASE pnpm test:integration   # disposable database only
```

Built output: `pnpm build`, then `pnpm --filter @hos/api start` (reads only real environment variables, never `.env`) or `pnpm --filter @hos/api start:local` (reads `apps/api/.env`). `pnpm --filter @hos/web preview` serves the built web app for local checking only; Vite's preview server is not a production web server, and production hosting is not decided yet.
