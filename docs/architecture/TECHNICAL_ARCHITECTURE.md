# HOS Technical Architecture

**Status:** approved decisions D-014 to D-025 (founder, 2026-11-25), plus engineering recommendations.
**Authority:** [PROJECT_RULES.md](../../PROJECT_RULES.md) · [Blueprint](../blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png) · [Decision log](../DECISION_LOG.md)

Every statement in this document carries one of three labels:
- **Approved:** recorded in the decision log, with its ID.
- **Recommended:** the engineering direction, **not approved**. It must be confirmed in a specification or by founder approval before it becomes binding.
- **Open:** undecided. See §13.

If this document and the decision log disagree, the decision log wins.

---

## 1. Approved decisions

| ID | Decision |
|---|---|
| D-014 | Modular monolith for hotel operations; a separate Leptron Control Plane with its own database |
| D-015 | TypeScript, NestJS (backend), React and Vite (staff and admin frontends) |
| D-016 | PostgreSQL on AWS RDS, standard features only |
| D-017 | Shared database per cell; tenant-scoped data; row-level security; automated isolation tests |
| D-018 | Transactional outbox and AWS SQS; at-least-once delivery; idempotent processing |
| D-019 | Regional cells, starting with one cell |
| D-020 | Strict Control Plane data allowlist; operational and guest data stay in cells |
| D-021 | Four identity realms; HOS owns authorization and RBAC |
| D-022 | No raw card numbers in HOS |
| D-023 | OpenTofu infrastructure as code; GitHub Actions CI/CD |
| D-024 | Lean, cost-conscious development environment |
| D-025 | AWS-only infrastructure; spending policy |

Earlier decisions that also constrain the architecture:
- **D-007:** Finance contracts and ownership.
- **D-008:** AI Workforce boundary.
- **D-009 and D-010:** separate billing and inventory domains.
- **D-011:** payment gateway contract.
- **D-012:** regional provisioning.
- **D-013:** scalability and capacity.

## 2. System shape

```
                 ┌──────────────────────────────┐
                 │ Leptron Control Plane (global)│  own app + own DB (D-014, D-020)
                 │ registry · provisioning ·     │
                 │ subscriptions · telemetry agg │
                 └──────────────┬───────────────┘
                versioned provisioning API (D-020)
                                │
          ┌─────────────────────▼─────────────────────┐
          │ HOS Cell (regional; one at launch, D-019)  │
          │  API service ─┐                            │
          │  Workers ─────┼─ modular monolith (D-014)  │
          │  PostgreSQL (RDS, D-016) · shared DB +RLS  │
          │  Outbox → SQS → idempotent consumers (D-018)│
          └────────────────────────────────────────────┘
```

**Recommended:**
- **Cells keep running if the Control Plane is unavailable.** They use cached entitlements and configuration.
- **A global, read-only directory routes tenants to cells.** It maps each property ID to its cell's API host and holds no sensitive data. Cells reject requests for properties they don't host.

## 3. Module boundaries
- **Approved (D-014):**
  - one module per blueprint module;
  - each module owns its own data;
  - modules interact only through public interfaces and events.
- **Recommended:**
  - Enforce boundaries with lint rules and architecture tests, so the build fails if one module reaches into another's internals or tables.
  - Use a monorepo with shared contract packages; the tool (pnpm workspaces with Turborepo or Nx) is chosen in the repository specification.
  - Use a contract-first OpenAPI 3.1 definition for the public API, versioned as `/v1`, with an `Idempotency-Key` header on writes and cursor pagination.

## 4. Data and tenancy
- **Approved (D-016, D-017):**
  - PostgreSQL on RDS;
  - one shared database per cell;
  - every tenant row carries `organization_id`, plus `property_id` where the data belongs to a property;
  - row-level security under application authorization;
  - mandatory isolation tests.
- **Recommended:**
  - **Row-level security:** tenant context set per transaction (`SET LOCAL`); connection-pool discipline to match.
  - **Module ownership:** enforced in code. Separate Postgres schemas only for hard boundaries:
    - ledger and folio postings, with append-only grants;
    - audit, append-only;
    - integration inbox and outbox.

    There is no automatic schema per module.
  - **Foreign keys between modules:** only to platform tables (organization, property, user). Business modules reference each other by ID.
  - **IDs:** globally unique (e.g., UUIDv7), never sequences local to one cell. This keeps it possible to move a tenant between cells later (D-013).
  - **Money:** an exact amount plus an ISO currency code; never floating point. The currency concepts themselves stay open (U-014).
  - **Time:** stored in UTC; property-local dates computed from the property's time zone (D-012).
  - **Migrations:** forward-only versioned SQL; expand-then-contract changes; tested in CI against real PostgreSQL.
  - **Large tables:** partitioning considered for audit, outbox and inbox, integration logs, and (later) postings. Decided in the data-conventions specification (D-013).
  - **Data access:** a typed SQL query builder (Kysely or Drizzle), chosen in the data-conventions specification.
  - **Legal entities and tax registrations:** not modelled until U-015 is resolved. No table may assume one-to-one relationships between organization, property, legal entity and tax registration.

## 5. Events and background work
- **Approved (D-018):** outbox and SQS; at-least-once delivery; idempotent consumers; exactly-once business effects as the goal.
- **Recommended:**
  - **Inbox table:** keyed on (consumer, `event_id`) and written in the same transaction as the consumer's changes.
  - **Ordering:** SQS FIFO grouped by property or by the changed record where order matters, never through one global group. Version checks reject events that arrive out of date.
  - **Failures:** dead-letter queue, alarms, and an audited replay tool.
  - **Event envelope:** `event_id`, `type`, `version`, `organization_id`, `property_id`, `occurred_at`, `correlation_id`, `causation_id`, `actor`.
  - **Workflows:** state machines stored in the database first. Temporal or Step Functions only when long-running processes require them (deferred).

## 6. Identity and authorization
- **Approved (D-021):** four realms (Leptron employees, hotel employees, guests, machines and AI agents). HOS owns authorization and RBAC.
- **Recommended:**
  - Permissions scoped to organization, property and department, and checked on every API call and event handler.
  - Organization policies operate inside platform boundaries (D-012).
  - An HOS user table maps internal user IDs to identity-provider subjects.
  - Rely on passwords as little as possible:
    - guests sign in without passwords;
    - Leptron employees use corporate SSO with phishing-resistant MFA;
    - hotel employees use their organization's SSO where available, otherwise a password with MFA (passkeys encouraged).
  - Machines: internal services use AWS IAM roles; integrations and AI agents use OAuth 2.0 client credentials with narrow scopes.
- **Open:** the identity-provider choice (§13).

## 7. Integration Hub (internal design; no new module)
**Recommended:**
- **Connectors:** each one is an adapter implementing a standard capability interface.
- **Connector lifecycle** (D-012): Catalogue → Eligible → Configured → Verified → Active → Suspended/Error → Retired.
  - Credentials are kept in AWS Secrets Manager and referenced by ID.
  - **Activation is explicit and audited.**
- **Incoming webhooks:** signature verification; the raw payload stored unchanged; fast acknowledgement, then processing in the background; duplicate protection using the provider's event ID.
- **Outgoing calls:** a rate limit per provider; retries with exponential backoff and random jitter; circuit breakers; scheduled reconciliation.
- **On-property hardware:** an edge agent installed at the property that connects outbound only.

## 8. Cells: provisioning, upgrades, backup and disaster recovery
- **Approved (D-019, D-020):** one cell at launch; versioned provisioning API.
- **Recommended:**
  - **Provisioning:** the API is idempotent (request IDs). The Control Plane runs the D-012 workflow and records progress.
  - **Organizations in several cells:** a minimal organization record in each cell. Cross-cell reporting is tied to U-014.
  - **Upgrades:** staging, then a canary cell, then the remaining cells. Migrations run per cell. Feature flags roll out per property. The provisioning API stays compatible one version back (N-1).
  - **Backups:** RDS automated backups with point-in-time recovery; S3 versioning. **Cross-region copies only to regions that the cell's data-residency rules allow.**
  - **Disaster recovery:** targets are open (U-021). Proposed targets of RPO ≤ 5 minutes and RTO ≤ 4 hours are **not approved**.
  - **Single-tenant restore:** restore to a side database, then extract that tenant, following a runbook. Restore drills on a schedule.
  - **Moving a tenant between cells:** specified before any second cell is created (D-013).

## 9. Control Plane data allowlist
- **Approved (D-020):** strict allowlist; hotel operational and guest data stay in cells.
- **Recommended initial allowlist** (to be finalized in the Control Plane–cell contract specification):
  - Organization: ID, business name, status, plan, entitlements, and Leptron's own SaaS-billing details for the customer (D-009).
  - Customer administrative and billing contacts (name, work email, work phone).
  - Property: ID, organization ID, display name, country, jurisdiction, cell ID, time zone, lifecycle status, template ID and version, enabled modules and feature flags.
  - Aggregated, non-personal telemetry.
  - Leptron employee identities.
- **Recommended exclusion and enforcement:**
  - **Never held:** guest data; reservations, folios, payments and ledgers; hotel employee personal data beyond the contacts above; documents; integration credentials; raw logs.
  - **Enforcement:** an allowlist-only database schema; a telemetry API with fixed fields, checked by contract tests; personal data scrubbed from logs before they leave a cell; remote support sessions that run inside the cell, time-boxed and audited.
  - **Cross-border transfer:** the cross-border flow of customer contact data needs legal review (U-020).

## 10. Security and compliance baseline
- **Approved:** D-008 (AI acts only through APIs and workflows); D-022 (no raw card numbers).
- **Recommended:**
  - KMS encryption at rest, with keys per cell; TLS 1.2 or later; field-level encryption for guest ID documents.
  - Secrets Manager; GitHub-to-AWS deployment via OIDC (no long-lived keys); separate AWS accounts per environment.
  - Append-only, hash-chained audit records capturing the actor, the "on behalf of" user, the tenant, before and after values, and a correlation ID.
  - OWASP ASVS level 2 as the baseline; WAF and rate limits; dependency and code scanning; a software bill of materials (SBOM).
  - Privacy: erasure requests balanced against mandatory financial retention by pseudonymizing data; retention periods taken from jurisdiction configuration (D-012).

## 11. Delivery: CI/CD, testing, infrastructure as code
- **Approved (D-023, D-024):** OpenTofu; GitHub Actions; a lean development environment.
- **Recommended:**
  - Trunk-based development with short-lived pull requests and branch protection.
  - **Required CI checks:**
    - typecheck, lint, unit tests;
    - integration tests against real PostgreSQL;
    - migration check;
    - **tenant-isolation tests**;
    - API and event contract compatibility checks;
    - financial invariant tests;
    - security scans.
  - **Later stages:** end-to-end tests (Playwright) and load tests (k6) that feed U-021.
  - **Deployment:** container images in ECR, deployed to ECS Fargate (API and workers as separate services). Migrations run as a gated pipeline step before the code deploy.
  - **Test data:** test fixtures only in tests. No mock data in production code (PROJECT_RULES §3).

## 12. AI Workforce
- **Approved (D-008, D-021):**
  - agents are machine identities;
  - they act only through approved APIs, events and workflows;
  - all their actions are subject to permissions and audit.
- **Recommended:**
  - Agent tools generated from the OpenAPI contract.
  - Approval workflows gate actions that affect money or guests.
  - Cost and rate budgets per tenant.
  - The AI runtime runs as a separate worker.
  - The model provider sits behind an abstraction.
- **Open:** which model provider, and where it processes data (U-020). Not part of the first milestone.

## 13. Open decisions

| Decision | Related items | Unblocked by |
|---|---|---|
| Identity provider: evaluate AWS Cognito, checking quotas (SSO connections per user pool), regional availability, authentication features (passkeys, email one-time codes, SAML/OIDC) and the exit strategy (password hashes can't be exported; lazy migration) | D-021 | Verification, then founder approval. Needed before identity work, not before platform work |
| Initial production region | U-012, U-020 | Market and data-residency decisions, plus legal review |
| Availability, recovery and capacity targets | U-021 | Founder targets, then load testing |
| OTA/GDS connectivity: direct or through an aggregator | U-007 | Customer and market research |
| Payment gateways at launch | U-008, D-011 | Customer and market research |
| Environment sizing and actual AWS spend | D-025 | Budget check (AWS Pricing Calculator, credit terms and expiry) and founder approval |
| Guest app: PWA or native | — | Door-lock vendor and mobile-key requirement (deferred) |

## 14. Cost estimates (**unverified**)

These are rough figures from the 2026-11-24 review, based on on-demand prices for Mumbai (`ap-south-1`), one cell and pilot-scale use. They are **not** checked against current prices and **not** approved spend. D-025 applies.

| Environment | Estimate per month (USD) |
|---|---|
| Lean dev | 55–140 |
| Staging | 220–360 |
| Production launch (one cell) | 650–1,130 |
| Control Plane (separate database) | 150–250 |

At full deployment the USD 10,000 in credits would last about 5–9 months. Under D-025, staging and production are expected to be created only when a suitable client justifies them. Credit expiry and exclusions are **not yet verified**.

## 15. Proposed first milestone: Platform Foundation (not started)

These steps are in dependency order. **Steps 1–8 need no AWS resources.**

1. Monorepo, module-boundary rules, CI (within the GitHub Actions free allowance, per D-025).
2. Migration framework and data conventions.
3. Organizations, properties and departments; row-level security; tenant-isolation tests.
4. Audit store, outbox, relay, inbox, dead-letter queue, behind a queue adapter (local emulator in tests).
5. Configuration and template versioning lifecycle (D-012), using test fixtures only.
6. RBAC permission engine behind an identity interface.
7. Control Plane provisioning API and allowlist contract tests.
8. OpenTofu modules written and checked with `tofu validate`, **never applied**.
9. **Needs AWS, so requires founder approval under D-025:** apply the dev environment, connect the identity provider, staging pipeline, restore drill.

**Exit criteria (automated and verified):**
- one organization is provisioned with two properties in two different countries (test fixtures);
- permissions are enforced per property;
- reads across tenants are blocked;
- every change is audited;
- events delivered twice, or redelivered after a crash, have exactly one business effect;
- the Control Plane holds only allowlisted data.

**Specifications required before coding:**
1. Architecture and module map.
2. Tenancy and data conventions.
3. Events and the outbox.
4. Control Plane–cell contract.

Then the identity and authorization, configuration, infrastructure, and security and audit specifications.
