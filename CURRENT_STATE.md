# HOS Current State

**Last updated:** 2026-11-27 (Phase 1 Platform Foundation P1–P8 implemented and verified locally; not committed)
**Update this file** at the end of every task that changes decisions, the repository state or the milestone status.

## Repository state
- **Contents:** approved documentation, plus (uncommitted) the engineering monorepo (`apps/api`, `apps/web`, `packages/shared`, `packages/config`, CI workflow) and the Phase 1 Platform Foundation in `apps/api`: bootstrap and migrations (`apps/api/db`), the kernel (`src/kernel`), modules P1–P8 (`src/modules`) and the trusted entry points (`src/platform`: HTTP API, worker, webhooks, operations). No hotel business modules, no Control Plane, no infrastructure.
- **Governance:**
  - [PROJECT_RULES.md](PROJECT_RULES.md)
  - [CLAUDE.md](CLAUDE.md)
  - [docs/DECISION_LOG.md](docs/DECISION_LOG.md)
- **Product scope:**
  - [docs/blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png](docs/blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png)
  - [docs/blueprint/BLUEPRINT_INTERPRETATION.md](docs/blueprint/BLUEPRINT_INTERPRETATION.md)
  - [docs/blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md](docs/blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md)
- **Technical architecture:** [docs/architecture/TECHNICAL_ARCHITECTURE.md](docs/architecture/TECHNICAL_ARCHITECTURE.md)
- **Module map (APPROVED 2026-11-26):** [docs/architecture/HOS_MODULE_MAP.md](docs/architecture/HOS_MODULE_MAP.md)
- **Tenancy and data conventions specification (APPROVED IMPLEMENTATION BASELINE, revision 2.1, 2026-11-26):** [docs/architecture/TENANCY_AND_DATA_CONVENTIONS.md](docs/architecture/TENANCY_AND_DATA_CONVENTIONS.md)
- **Validation harness for that specification:** [docs/architecture/validation/tenancy-2.1-sql-harness/](docs/architecture/validation/tenancy-2.1-sql-harness/README.md)
- **Remote:** https://github.com/Leptron-Inc/HOS (branch `main`, at `0ed3d46`: the approved engineering baseline, pushed 2026-11-26).
- **Not yet on the remote (nothing staged):** the Milestone 1 step 1 monorepo files, and edits to `CURRENT_STATE.md` and `README.md`. Committing and pushing need explicit authorization.

## Approved decisions
| Range | Subject |
|---|---|
| D-001 – D-011 | Blueprint interpretation, domain separations, Finance, AI Workforce and payment contract rules |
| D-012 | Regional provisioning driven by the Control Plane |
| D-013 | Global scalability and capacity (no arbitrary capacity limits) |
| D-014 – D-024 | Technical architecture: modular monolith with separate Control Plane; TypeScript, NestJS, React, Vite; PostgreSQL on RDS; shared database per cell with row-level security; outbox with SQS; cells starting with one; Control Plane allowlist; four identity realms; no raw card numbers; OpenTofu and GitHub Actions; lean dev environment |
| D-025 | AWS-only infrastructure and spending policy |

The full text is in [docs/DECISION_LOG.md](docs/DECISION_LOG.md).

## Approved engineering baseline (founder, 2026-11-26)
The founder explicitly approved:
- the complete **46-module structure** of the [module map](docs/architecture/HOS_MODULE_MAP.md);
- the ownership rulings **MM-01 to MM-16**;
- the **implementation tiers** (module map §7);
- the **blueprint-to-module reconciliation** (module map §10): 46 tiles map to 46 modules, there are 45 distinct names (the two "Billing & Invoicing" tiles, F2 and C4, D-009), 256 of 256 readable capabilities are mapped, and unreadable items stay as U-001 to U-005;
- D-001 to D-025, which are unchanged.

The founder then approved the **tenancy and data conventions specification, revision 2.1, as the implementation baseline** (2026-11-26). Its §11 tooling and parameter choices remain provisional, and its open questions TQ-01 to TQ-07 remain open.

**The MM rulings are not D-numbered decisions.** Recording them as D-026 or later needs separate authorization.

## Approved vs pending
| Approved (binding now) | Pending (not binding until approved) |
|---|---|
| D-001 to D-025 | The tenancy specification's §11 tooling and parameter choices (provisional recommendations) |
| Module structure, ownership (MM-01 to MM-16), tiers, reconciliation | Detailed contracts in the module map: entity and field names, API paths, event names, permission names, and every item marked "proposed", until their own specifications are approved |
| Tenancy and data conventions specification, revision 2.1 (implementation baseline) | The events and outbox, security and audit, Control Plane–cell contract, identity and authorization, and configuration specifications (not yet written) |
| | A repository specification recording the tooling choices (not yet written) |
| | "Recommended" items in TECHNICAL_ARCHITECTURE.md, until a specification or the founder confirms them |

## Open decisions
- **Identity provider.** AWS Cognito is under evaluation: quotas, regional availability, authentication features and exit strategy.
- **Initial production region** (U-012, U-020).
- **Availability, recovery and capacity targets** (U-021).
- **OTA connectivity and payment gateways**, pending customer and market research.
- **Environment sizing and actual AWS spend**, pending budget verification and approval.
- **Blueprint and product open items** U-001 to U-022 in [UNRESOLVED_BLUEPRINT_DETAILS.md](docs/blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md).
- **Module map questions** Q-01 to Q-33 (module map §9); Q-32 and Q-33 are the newest.
- **Tenancy specification questions** TQ-01 to TQ-07, and its six **provisional recommendations** in §11 (founder review 2026-11-26): Kysely, decimal.js with Temporal, and tenant-prefixed routes are recommended; `numeric(38, 4)` is conditional on financial validation; the 24-hour idempotency expiry is a default subject to per-operation needs; the migration runner is not selected until a comparison is done. None is an approved contract.

## Infrastructure spending restrictions (D-025)
- AWS is the only cloud. No Supabase.
- Credits: USD 10,000; use them carefully. Their expiry date and exclusions are **not yet verified**.
- **No AWS resource may be created and no paid charge incurred without explicit founder approval.**
- No out-of-pocket infrastructure spending before a suitable client is secured, unless separately approved.
- After the credits are used up, infrastructure grows only from customer revenue or separately approved funding.
- CI must stay within the GitHub Actions free allowance unless spending is approved.

## Current engineering milestone
**Milestone 1, Platform Foundation:** **in progress.** Step 1 (monorepo, boundary rules, CI) and the Phase 1 implementation of P1–P8 are implemented and verified locally, awaiting founder review; nothing is committed, and the CI workflow has not yet run on GitHub. Technical architecture §15 steps 7–9 (Control Plane provisioning client, OpenTofu, AWS environment) are not started. The Tier 0 build order is in [HOS_MODULE_MAP.md §7.1](docs/architecture/HOS_MODULE_MAP.md#71-tier-0-bootstrap-sequence).
- **Plan:** [TECHNICAL_ARCHITECTURE.md §15](docs/architecture/TECHNICAL_ARCHITECTURE.md#15-proposed-first-milestone-platform-foundation-not-started).
- **Steps 1–8** need no AWS resources.
- **Step 9** needs founder approval of AWS spending.

## Phase 1 Platform Foundation (implemented 2026-11-27, not committed)

The founder's Phase 1 mandate authorized implementing P1–P8. Implemented in `apps/api` (see the Phase 1 report for file-level detail):

| Module | Implemented |
|---|---|
| L0 kernel | Versioned bootstrap (cluster revisions 0001 = validated block 01, 0002 system roles; database revisions 0001 = block 02, 0002 audit/eventing schemas); 14 migrations (blocks 03–07 unchanged, one completing P1, then one per module); migration runner and lint; request context (factory, async-local store, deep-frozen); tenant transaction (`set_config` as first statement, B-07 manifest check, nested-transaction refusal, broken-connection destruction); pre-tenant lookups |
| P1 Multi-tenant | Organizations, properties (provisioning only, Control Plane IDs, idempotent), departments, version history, RLS on every tenant table, isolation tests |
| P2 Identity & access | Generic JWT/JWKS credential verifier (no provider chosen), principals per realm, roles from a permission registry, assignments at organization/property/department scope, grant cache with invalidation, invitations, session revocation, service identities, denial recording |
| P3 Events & workflow | Outbox writer, relay, local queue adapter (SQS-like), consumers with inbox, retries with backoff, dead letters with audited replay, versioned event contracts, workflow definitions/instances/history, approvals, scheduled tasks, event triggers, permission boundaries |
| P4 Integration Hub | Versioned connector catalogue (signed webhook, HTTP endpoint), lifecycle with separate activation permission, credential references with a local encrypted secret store, health checks, outbound retries/circuit breaker/rate limit, webhook intake (lookup function, signature first, deduplication), integration logs |
| P5 Documents | Documents per class and scope, append-only versions, encrypted local storage adapter, streamed downloads, audited sensitive reads, metadata search, retention from P8 settings, deletion lifecycle with tombstones |
| P6 Observability | Structured redacting logger, request and correlation IDs, W3C trace context, metrics registry, operations port (metrics, diagnostics), error fingerprints, background job gauges, readiness and liveness |
| P7 Security & compliance | Hash-chained audit writer and tenant audit API with chain verification, system security log with aggregation and full-fidelity mode, data-subject erasure (P2 participant), integrity monitor (E-46 items 4 and 5), security headers, rate limiting, strict input validation |
| P8 Configuration | Setting registry with schemas and explicit override levels, template snapshots via provisioning, organization and effective-dated property overrides, inheritance with template locks, versions and change history, cache invalidation, configuration version for E-43 provenance |

**Verified locally:** Windows (Node 26.13.1, PostgreSQL 18.4): format, lint, typecheck, build, module boundaries (planted violations caught), migration lint, 71 unit tests, 105 integration tests on a freshly bootstrapped and migrated database per run. Linux (Docker, node:26-bookworm, PostgreSQL 18.7): the same suite, plus a process-level smoke test (CLI bootstrap and migrate, API and worker processes, health, metrics, real SIGTERM).

**Provisional choices made during Phase 1 (each needs founder confirmation or its specification):**
- Migration runner: the in-repository runner (one of the two candidates in tenancy specification §11 item 2); files are plain SQL.
- System roles `hos_relay`, `hos_monitor`, `hos_lookup_integration` and their policies (`relay_access`, `monitor_read`): the events and the security and audit specifications are not written.
- Real P2, P3, P4, P5, P7 and P8 table shapes, event names, permission names and API paths (the module map's proposed names; owning specifications not written).
- Service identities authenticate through a trusted issuer (OAuth client credentials) mapped to an `iam_user` principal; no key or secret is stored.
- Invitation acceptance runs under a P2 platform identity in the named organization, authorized by the 256-bit single-use token (the identity specification must confirm this pre-membership path).
- Dependencies added: `jose` 6.2.18, `zod` 4.6.7, `@types/express` 5.0.6 (all MIT).
- Migrations are forward-only (approved rule G-01); recovery is a forward fix (G-10). The mandate's "reversible where possible" is met only through N-1 code compatibility.

**Not implemented or not verified (needs approvals or AWS, D-025):** AWS SQS, Secrets Manager, S3 and KMS adapters (interfaces only); identity provider integration (D-021 open); OpenTelemetry export; E-46 items 1–3 (break-glass access, log export, CloudTrail); Amazon RDS behaviour; access-request fulfilment (requests are recorded, not exported); multi-instance cache invalidation (relies on short TTLs); MFA enforcement for privileged roles (the token claim is read, not enforced); an API for the security log full-fidelity mode (its operators exist only in the Control Plane); an independent security review; CI on GitHub; the Control Plane (out of scope).

**Phase 1 status: INCOMPLETE** (founder checkpoint 2026-11-27). The items above remain open; Phase 1 is not to be marked complete until they are resolved or explicitly deferred by the founder.

## Current deliverable
**Milestone 1 step 1: engineering monorepo** (implemented 2026-11-27, not committed). The founder's step 1 instruction specified the stack: Node.js 26.13.1, pnpm 12.23.0, Turborepo 2.11.13, TypeScript 6.0.3, NestJS 12.6.2, React 19.3.1, Vite 8.3.8, Kysely 0.29.9, Vitest 5.1.1, dependency-cruiser 18.9.0, at the versions from the tooling validation report. Two dependencies were added because the task needed them: `@nestjs/platform-express` 12.6.2 (HTTP for the health endpoint) and Prettier 3.10.1 (formatting). Whether that instruction also approves the provisional §11 tools for the rest of the project is **not yet recorded** (see Next tasks).
- **Engineering review corrections (2026-11-27):**
  - **Health:** separate liveness (`/health/live`) and readiness (`/health/ready`, 503 when not ready) with minimal bodies. The readiness probe has a hard deadline: a server-side `statement_timeout` (and a pool-wide one), and a probe that misses its deadline destroys its connection instead of returning it to the pool. Readiness results are cached briefly (`HEALTH_CACHE_TTL_MS`, default 2 s), and concurrent requests share one probe.
  - **Database kernel:** `apps/api/src/kernel/database` (module map §7.1, L0). It is no longer a global module, and it exports only the health indicator. Boundary rules stop any other code from importing pg or Kysely, or the kernel's internals, and stop business modules from importing the kernel at all. The future tenant transaction mechanism will be added to the kernel.
  - **Shutdown:** shutdown now ends the pool even when Kysely was never used (Kysely only takes the pool on its first query).
  - **Configuration:** `NODE_ENV` is required; `PORT=0` is accepted only in tests; the configuration is deep-frozen; `start` does not read `.env` (`start:local` does).
  - **Web:** a 5 s timeout on the web health request.
  - **Repository:** LF line endings are enforced by `.gitattributes`. Turborepo's cache now includes the root lint, format, boundary and editor configuration.
  - **CI:** in-progress runs are cancelled only for pull requests, and the pnpm store is cached.
- **Final verification (2026-11-27):** the `X-Powered-By` header is removed, through one app factory shared by the server and the integration tests. The shared-package framework rule was shown to fire on a temporarily installed framework dependency, after which the dependency was removed and the lockfile restored byte-identical.
- **Verified locally on Windows (Node 26.13.1, PostgreSQL 18.4):** frozen-lockfile install; formatting; typed lint; typecheck; build; module-boundary rules (each rule shown to fire on planted violations, which were then removed); 50 unit tests; 6 integration tests (three consecutive passing runs), including cancellation of a slow statement, database failure and recovery, and shutdown closing every connection; Turborepo cache invalidation by each root configuration file; LF checkout from a simulated fresh clone with `core.autocrlf=true`. Both applications were run in development and production modes, and the web health indicator was confirmed in a real browser in the connected and the degraded states.
- **Verified on Linux (Docker container `node:26-bookworm`, PostgreSQL 18.7):** the same suite (install, format, lint, typecheck, build, boundaries and planted violations, 50 unit and 6 integration tests, Turborepo invalidation); production startup, liveness and readiness (database up and down); and a real SIGTERM: the API closes its pool, logs it and leaves no server connections (three runs).
- **Not verified:** the CI workflow has not run on GitHub (pushing was not authorized) and was not checked with a workflow linter. Windows cannot deliver SIGTERM gracefully to another process (`process.kill` terminates it outright), so on Windows only the shutdown path itself was verified, by raising the signal inside the process.

**Approved baseline:** the **tenancy and data conventions specification** ([docs/architecture/TENANCY_AND_DATA_CONVENTIONS.md](docs/architecture/TENANCY_AND_DATA_CONVENTIONS.md)) is **APPROVED as the implementation baseline, revision 2.1**, committed in `0ed3d46`. Its history: the founder conditionally approved the overall architecture of revision 1, subject to technical corrections; revision 2 made them; revision 2.1 added two security-review corrections (the limits of trigger protection against privileged administrators, and one consistent role-membership model). Its revision log maps each correction to rules and tests.
- **Validation:** its SQL (bootstrap, migrations, statements) was executed as written on a temporary local PostgreSQL 18.4 instance, in two bootstrap modes (superuser, and a non-superuser administrator approximating the RDS master user), with 165 of 165 SQL-level checks passing in each. This found and fixed five SQL defects. The exact harness and its run logs are preserved in [docs/architecture/validation/tenancy-2.1-sql-harness/](docs/architecture/validation/tenancy-2.1-sql-harness/README.md). Not yet verified: Amazon RDS behaviour, any protection against privileged administrators (the controls in spec E-46 are required but not built), PostgreSQL 16/17, TypeScript examples, performance, and application-level tests (spec §12).
- It covers: the multi-tenant data model; database architecture; PostgreSQL row-level security (roles, `SET LOCAL` context, fail-closed functions, pool safety, migration-role separation); the trusted request and actor context; data conventions (identifiers, money, time, deletion, versioning and history, classification, retention, erasure and the tombstone format promised by module map §1.1); API conventions; migration conventions; and acceptance tests.
- Its open questions are TQ-01 to TQ-07. None blocks Milestone 1 steps 2–3.
- Its §11 records the six tooling and parameter choices as provisional recommendations; each still needs explicit approval, and the migration runner needs a comparison first.

## Prerequisites, by the work they block
Nothing below blocks **the whole** of Milestone 1. Each item blocks only the work named next to it.

| Prerequisite | Blocks |
|---|---|
| Migration runner decision (Flyway Community pending its licence review and the proposed migration amendment, or a custom runner), recorded with the other tooling decisions in a repository specification | Milestone 1 steps 2–3 (migration framework and data conventions; tenancy and row-level security) |
| Events and outbox specification (including compensation and hold-state events, module map §6.1; envelope trust and system roles relied on by the tenancy specification §9) | Milestone 1 step 4 (audit store, outbox, relay, inbox) |
| Security and audit specification. Includes: audit payload rules (module map §1.1); the system security log's fields, aggregation, access and retention (§7.2); P5 download rules; database login authentication; field-level encryption. Retention needs legal input (U-013, U-020) | Milestone 1 step 4 (security log and audit writers); P5 (Tier 1) |
| Control Plane–cell contract specification (provisioning API, machine-identity trust, template publication, support grants; organizations across cells, TQ-05) | Milestone 1 step 7 (Control Plane provisioning) |
| Control Plane audit contract (Q-20) | The C1 and C2 administrative workflows only |
| Identity provider decision (Cognito evaluation) | P2's identity-provider integration only (Milestone 1 step 6). The permission engine can be built behind an interface first |
| Finance separation-of-duties rules (Q-15) | Finance approval workflows (Tier 3 onward), not Tier 0 |
| Connector scope implementation (Q-16) | P4 (Tier 1), not Tier 0 |

## Next tasks (each needs explicit authorization)
1. Founder review of Milestone 1 step 1; then commit and push it, and confirm the CI workflow passes on GitHub.
2. Record the tooling decisions in a repository specification: whether the step 1 stack (Kysely, pnpm, Turborepo, Vitest, TypeScript 6.0.3, Node.js 26 LTS) is approved project-wide; the migration runner; financial validation of `numeric(38, 4)`; TQ-01 to TQ-07 as they become relevant.
3. Write the remaining pre-coding specifications:
   - events and the outbox;
   - security and audit;
   - Control Plane–cell contract (including the Control Plane audit contract, Q-20).
4. Founder review and approval of those specifications.
5. Milestone 1 steps 2–8, local and CI only, each started once its own prerequisite above is met.
6. Cognito verification, then a founder decision on the identity provider.
7. In parallel, commercial work: customer discovery to inform U-012, U-021, U-022, and the OTA and gateway choices.
