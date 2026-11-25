# HOS Current State

**Last updated:** 2026-11-26 (baseline reconciliation: tenancy specification revision 2.1 approved as the implementation baseline; SQL validation harness preserved in the repository; nothing committed yet)
**Update this file** at the end of every task that changes decisions, the repository state or the milestone status.

## Repository state
- **Contents:** documentation only. There is no application code, CI, infrastructure or dependencies yet.
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
- **Remote:** https://github.com/Leptron-Inc/HOS (branch `main`, at `a222eaa`, D-013)
- **Not yet on the remote (nothing staged):**
  - local commit `900cc4e` (D-014 to D-025) is not pushed;
  - `CURRENT_STATE.md`, `README.md` and `CLAUDE.md` are modified;
  - the module map, the tenancy specification and the validation harness folder are untracked.

  The approved baseline therefore exists only in this working copy until it is committed and pushed. Committing and pushing each need explicit authorization.

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
**Milestone 1, Platform Foundation:** **not started.** The module map and the tenancy and data conventions specification (the first pre-coding specification) are approved. Implementation also needs the tooling approvals listed below. The Tier 0 build order is in [HOS_MODULE_MAP.md §7.1](docs/architecture/HOS_MODULE_MAP.md#71-tier-0-bootstrap-sequence).
- **Plan:** [TECHNICAL_ARCHITECTURE.md §15](docs/architecture/TECHNICAL_ARCHITECTURE.md#15-proposed-first-milestone-platform-foundation-not-started).
- **Steps 1–8** need no AWS resources.
- **Step 9** needs founder approval of AWS spending.

## Current deliverable
**Baseline preservation:** committing and pushing the approved baseline. The **tenancy and data conventions specification** ([docs/architecture/TENANCY_AND_DATA_CONVENTIONS.md](docs/architecture/TENANCY_AND_DATA_CONVENTIONS.md)) is **APPROVED as the implementation baseline, revision 2.1, but not committed.** Its history: the founder conditionally approved the overall architecture of revision 1, subject to technical corrections; revision 2 made them; revision 2.1 added two security-review corrections (the limits of trigger protection against privileged administrators, and one consistent role-membership model). Its revision log maps each correction to rules and tests.
- **Validation:** its SQL (bootstrap, migrations, statements) was executed as written on a temporary local PostgreSQL 18.4 instance, in two bootstrap modes (superuser, and a non-superuser administrator approximating the RDS master user), with 165 of 165 SQL-level checks passing in each. This found and fixed five SQL defects. The exact harness and its run logs are preserved in [docs/architecture/validation/tenancy-2.1-sql-harness/](docs/architecture/validation/tenancy-2.1-sql-harness/README.md). Not yet verified: Amazon RDS behaviour, any protection against privileged administrators (the controls in spec E-46 are required but not built), PostgreSQL 16/17, TypeScript examples, performance, and application-level tests (spec §12).
- It covers: the multi-tenant data model; database architecture; PostgreSQL row-level security (roles, `SET LOCAL` context, fail-closed functions, pool safety, migration-role separation); the trusted request and actor context; data conventions (identifiers, money, time, deletion, versioning and history, classification, retention, erasure and the tombstone format promised by module map §1.1); API conventions; migration conventions; and acceptance tests.
- Its open questions are TQ-01 to TQ-07. None blocks Milestone 1 steps 2–3.
- Its §11 records the six tooling and parameter choices as provisional recommendations; each still needs explicit approval, and the migration runner needs a comparison first.

## Prerequisites, by the work they block
Nothing below blocks **the whole** of Milestone 1. Each item blocks only the work named next to it.

| Prerequisite | Blocks |
|---|---|
| Explicit approval of the tooling the tenancy specification §11 leaves provisional (data-access library; migration runner after its comparison or spike; monorepo tooling; test stack; Node.js LTS version), recorded in a repository specification | Milestone 1 steps 1–3 (monorepo and CI; data conventions; tenancy and row-level security) |
| Events and outbox specification (including compensation and hold-state events, module map §6.1; envelope trust and system roles relied on by the tenancy specification §9) | Milestone 1 step 4 (audit store, outbox, relay, inbox) |
| Security and audit specification. Includes: audit payload rules (module map §1.1); the system security log's fields, aggregation, access and retention (§7.2); P5 download rules; database login authentication; field-level encryption. Retention needs legal input (U-013, U-020) | Milestone 1 step 4 (security log and audit writers); P5 (Tier 1) |
| Control Plane–cell contract specification (provisioning API, machine-identity trust, template publication, support grants; organizations across cells, TQ-05) | Milestone 1 step 7 (Control Plane provisioning) |
| Control Plane audit contract (Q-20) | The C1 and C2 administrative workflows only |
| Identity provider decision (Cognito evaluation) | P2's identity-provider integration only (Milestone 1 step 6). The permission engine can be built behind an interface first |
| Finance separation-of-duties rules (Q-15) | Finance approval workflows (Tier 3 onward), not Tier 0 |
| Connector scope implementation (Q-16) | P4 (Tier 1), not Tier 0 |

Milestone 1 step 1 (monorepo, boundary rules, CI) has no specification prerequisite beyond the approved D-014 to D-025, but it needs the tooling approvals in the first row above.

## Next tasks (each needs explicit authorization)
1. Commit the approved baseline (module map, tenancy specification, validation harness, and the updated `CURRENT_STATE.md`, `README.md` and `CLAUDE.md`), and push `900cc4e` and the new commit to `origin/main` (fast-forward only).
2. Founder decisions on the provisional tooling (Kysely; migration runner after a spike; monorepo tooling; test stack; Node.js LTS), recorded in a repository specification; financial validation of `numeric(38, 4)`; TQ-01 to TQ-07 as they become relevant.
3. Write the remaining pre-coding specifications:
   - events and the outbox;
   - security and audit;
   - Control Plane–cell contract (including the Control Plane audit contract, Q-20).
4. Founder review and approval of those specifications.
5. Milestone 1 steps 1–8, local and CI only, each started once its own prerequisite above is met.
6. Cognito verification, then a founder decision on the identity provider.
7. In parallel, commercial work: customer discovery to inform U-012, U-021, U-022, and the OTA and gateway choices.
