# HOS Specification: Tenancy and Data Conventions

**Status: APPROVED IMPLEMENTATION BASELINE (revision 2.1).** The founder approved revision 2.1 as the implementation baseline on 2026-11-26, after reviewing revision 1, conditionally approving its overall architecture subject to technical corrections, and reviewing revisions 2 and 2.1, which make those corrections (see the revision log below). Its rules are binding for implementation. Rules that restate an approved decision cite it (D-nnn). **Not approved by this status:** the tooling and parameter choices in §11 remain **provisional recommendations**, not approved contracts, and each still needs its own explicit founder approval. The open questions in §10 (TQ-01 to TQ-07) remain open, and the verification gaps listed in §12 remain unverified.

**Scope:** the first of the pre-coding foundation specifications ([TECHNICAL_ARCHITECTURE.md §15](TECHNICAL_ARCHITECTURE.md#15-proposed-first-milestone-platform-foundation-not-started)). As the approved baseline, it unblocks Milestone 1 steps 2–3, subject to the §11 tooling approvals they need: data conventions, organizations, properties and departments, row-level security and tenant-isolation tests.

**Sources:**
- [Decision log](../DECISION_LOG.md): D-012, D-013, D-014, D-016, D-017, D-018, D-019, D-020, D-021, D-022, D-025
- [Module map](HOS_MODULE_MAP.md) (approved 2026-11-26): G1–G13, §1.1, §1.2, §6.1, §7.1, §7.2, MM-13, MM-14, MM-16
- [Technical architecture](TECHNICAL_ARCHITECTURE.md) §4, §6 (its "Recommended" items are confirmed here only where this specification says so)
- [Unresolved register](../blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md): U-013 to U-021

**How to read the rules.** Each rule has an ID (for example `C-04`) so that code reviews and tests can cite it. IDs are stable across revisions: a rule changed in revision 2 is marked **(rev. 2)**, and new rules take new numbers. "Must" is mandatory for implementation. Questions this specification can't settle are numbered **TQ-nn** (§10). They are local to this specification, and none is a D-numbered decision or a U-numbered register item.

**Validated SQL.** SQL blocks whose first line is a `-- [validated …]` tag are executed, exactly as written here, by the validation harness against a real PostgreSQL server (§12). Untagged SQL is explanatory. Tables whose names are marked *illustrative* (`iam_`, `hk_`, `crm_`, `fol_`) show and test the conventions; the owning module's specification defines the real tables.

**Not decided here:** the identity provider (D-021, open); legal entities and tax registrations (U-015); currency concepts (U-014); retention periods (U-013, U-020); capacity targets (U-021); event envelope and outbox schema (events specification); audit record schema (security and audit specification); provisioning API (Control Plane–cell contract specification).

### Revision log

| Revision | Date | Change |
|---|---|---|
| 1 | 2026-11-26 | First draft |
| 2 | 2026-11-26 | Technical correction pass after founder review (corrections 1–10 below) |
| 2.1 | 2026-11-26 | Security-review corrections: (a) the history guard is no longer described as a protection against the table owner or privileged administrators; their bypasses and the need for independent detection are documented (C-04, C-23, E-44, E-46; H-HIST-08 relabelled; H-HIST-11 to H-HIST-13); (b) one role-membership model, matching the SQL and its `SET ROLE` flow (C-19, C-21, H-MIG-09; H-MIG-16); (c) bootstrap block 02 made to work for a non-superuser administrator such as the RDS master user (C-23; H-MIG-17) |
| 2.1 (approved) | 2026-11-26 | Founder approval as the implementation baseline. Status wording and the location of the preserved validation harness (§12) only; **no technical rule, SQL block or test was changed**. §11 items stay provisional |

| # | Founder correction | Where it is resolved |
|---|---|---|
| 1 | Secure RLS access model for pre-tenant `SECURITY DEFINER` lookups | C-12 (rev. 2), C-21; validated blocks 05, 07, 08; H-LOOK |
| 2 | Composite foreign keys for property-scoped relationships | B-09, B-10 (rev. 2), B-25 to B-27; validated blocks 05, 08, 09; H-FK |
| 3 | Protected history writes, trigger ownership, grants, tamper-resistant access | E-20, E-21, E-23, E-36 (rev. 2), E-44, E-45; validated blocks 04, 06, 10; H-HIST |
| 4 | `SECURITY DEFINER` ownership, `search_path`, privileges and `PUBLIC` execution | C-16 (rev. 2), C-19, C-20, C-22; H-DEF |
| 5 | Migration-role execution model | C-17 (rev. 2), C-18, C-23, G-15 to G-17; validated blocks 01–04; H-MIG-09 to H-MIG-14 |
| 6 | Financial precision, allocation weights, minor-unit validation | E-06, E-08, E-09 (rev. 2), E-39 to E-42; validated block 11; H-FIN |
| 7 | Idempotency fingerprint, replay, expiry, cleanup, concurrency | F-07 to F-09 (rev. 2), F-19 to F-24; validated statements; H-IDEM |
| 8 | Time-zone and configuration provenance for historical business dates | E-43; validated block 11; H-TIME-07 to H-TIME-09 |
| 9 | Department authorization against reassignment and concurrency | CX-07 (rev. 2), CX-17 to CX-19; validated statements; H-DEPT-05 to H-DEPT-08 |
| 10 | Multi-cell boundary without deciding TQ-05 | A-19 to A-22; TQ-05; H-CELL |
| — | Founder decisions recorded as provisional | §11 |

---

## Contents
1. [A. Multi-tenant data model](#1-a-multi-tenant-data-model)
2. [B. Database architecture](#2-b-database-architecture)
3. [C. PostgreSQL row-level security](#3-c-postgresql-row-level-security)
4. [D. Trusted request and actor context](#4-d-trusted-request-and-actor-context)
5. [E. Data conventions](#5-e-data-conventions)
6. [F. API and application conventions](#6-f-api-and-application-conventions)
7. [G. Database migration conventions](#7-g-database-migration-conventions)
8. [H. Testing requirements and acceptance tests](#8-h-testing-requirements-and-acceptance-tests)
9. [Dependencies on the other foundation specifications](#9-dependencies-on-the-other-foundation-specifications)
10. [Unresolved questions and their impact](#10-unresolved-questions-and-their-impact)
11. [Provisional recommendations (founder review 2026-11-26)](#11-provisional-recommendations-founder-review-2026-11-26)
12. [Validation status](#12-validation-status)

---

## 1. A. Multi-tenant data model

### 1.1 Hierarchy

```
Organization (tenant root; one per customer, ID issued by the Control Plane)
 └── Property (operating unit; belongs to exactly one organization; hosted in exactly one cell)
      └── Department (permission and assignment scope; never a data partition)
```

| ID | Rule | Basis |
|---|---|---|
| A-01 | The **organization** is the tenant boundary. No record, query, transaction, event or job ever belongs to more than one organization. | D-017, G1 |
| A-02 | A **property** belongs to exactly one organization for its whole life. Moving a property to another organization is not supported by this specification. | D-017 |
| A-03 | A **department** belongs to exactly one property (blueprint: Organization → Property → Department). Organization-level departments are **TQ-01**. | Blueprint P1, D-017 |
| A-04 | **Department is not a data partition.** Row-level security never filters on department. Department scope is enforced by the HOS permission engine (P2) in the application. | D-017 constraint |
| A-05 | Organization, property, **legal entity** and **tax registration** are distinct concepts. No table may store a legal-entity or tax-registration attribute on the organization or property record, or assume a one-to-one relationship between them, until U-015 is resolved. | D-017, U-015 |
| A-06 | Organization and property IDs are **issued by the Control Plane** (C1/C2) and passed to the cell in the provisioning command. The cell never generates them. The same ID identifies the same organization or property in the Control Plane and in every cell. | D-020, MM-14 |
| A-07 | Properties of one organization must not be assumed to share a country, currency, time zone or tax jurisdiction. | D-012 |

### 1.2 Scope class of every table

Every table has exactly one **scope class**, declared in its module's table manifest (§2.2) and checked by CI against the database catalog.

| Scope class | Required tenant columns | Row-level security | Examples (illustrative) |
|---|---|---|---|
| `organization` | `organization_id NOT NULL` | Organization boundary | P2 users, roles; P8 organization policies |
| `property` | `organization_id NOT NULL`, `property_id NOT NULL` | Organization boundary **and** property scope | P1 departments; P8 property configuration; B2 reservations |
| `global_reference` | none | None; runtime roles have `SELECT` only | ISO 4217 currency list; published regional template versions (P8) |
| `system` | depends on table | Dedicated system roles only (§3.3) | P7 system security log (§7.2 of the map); P3 relay state |

| ID | Rule |
|---|---|
| A-08 | Which scope class a business entity uses is decided by its **owning module's specification**. This specification provides the mechanism, not the assignment for every entity. |
| A-09 | A `property`-scoped table never has a nullable `property_id`. Data that can belong either to the organization or to one property is two tables, or one `organization`-scoped table with an optional `property_id` attribute that is **not** used for isolation. The second option must be justified in the module specification. |
| A-10 | `global_reference` tables hold no tenant data and no personal data. They are written only by migrations or by the template-publication path (Control Plane–cell contract specification). |

### 1.3 Cross-property and cross-organization access

| ID | Rule |
|---|---|
| A-11 | An actor reaches a property's data only if P2 finds a role assignment covering that property (an organization-wide assignment covers all of the organization's properties in this cell). |
| A-12 | An organization-level request (for example an organization report) runs with a **property scope**: either "all properties of the organization" (only when the actor's assignment is organization-wide) or the explicit list of properties the actor is authorized for. Row-level security enforces that scope (§3.3). |
| A-13 | **Cross-organization access does not exist** at runtime. Leptron support access (C6) runs inside one organization's context under a time-limited grant (map §1.2). |
| A-14 | A property-scoped route acts on exactly one property. Operations that change data in several properties run as separate units of work, one per property. |

### 1.4 Organizations, properties and regional cells

| ID | Rule | Basis |
|---|---|---|
| A-15 | A cell holds the property records only for the properties it hosts, plus a **cell copy** of each owning organization record. The Control Plane remains authoritative for registration and placement; the cell is authoritative for operational records (MM-14). | D-019, D-020, MM-14 |
| A-16 | A cell rejects any request or command for a property it does not host. The answer is `not_found`, identical to an unknown property. | §7.1 of the map |
| A-17 | Because IDs are global (A-06, E-01) and every tenant row carries `organization_id` (and `property_id` where property-scoped), a tenant's rows can be identified and extracted without translation. This keeps tenant moves between cells possible (D-013). The move procedure itself is specified before a second cell exists (Technical architecture §8). | D-013, D-019 |
| A-18 | No code may assume that all of an organization's properties are in the current cell. Organization-level queries return "properties of this organization **hosted in this cell**". How organization-scoped data works for an organization spread across cells is **TQ-05**. | D-019 |
| A-19 | **Each cell is a closed data domain.** There are no database connections, foreign keys, queries, views or transactions between two cells' databases. Anything that crosses cells goes through the Control Plane contracts (D-020) or a mechanism that a later specification defines. | D-019, D-020 |
| A-20 | Organization-scoped rows in a cell describe the organization **only as this cell sees it**. They are never treated as complete for, or authoritative over, the organization's properties in other cells. | D-019 |
| A-21 | Organization-scoped records use global IDs (E-01) and carry `organization_id`. Whichever answer TQ-05 receives (for example, a home cell, or copies in each cell), existing records can be located and reconciled without rewriting their IDs. This rule keeps the options open; it does not choose one. | D-013, TQ-05 |
| A-22 | **Proposed guard, until TQ-05 is resolved:** the Control Plane does not place a property in a cell if its organization already has properties hosted in a different cell. This has no effect at launch (one cell, D-019) and selects no TQ-05 option. It is enforced in C2 through the Control Plane–cell contract specification, and is listed there as a requirement to confirm. | D-019, TQ-05 |

---

## 2. B. Database architecture

### 2.1 Database and schemas

| ID | Rule | Basis |
|---|---|---|
| B-01 | One PostgreSQL database per cell, on Amazon RDS, using standard PostgreSQL features and standard extensions available on RDS. The Control Plane has its own separate database. This specification needs **no extension**. | D-014, D-016, D-017 |
| B-02 **(rev. 2)** | The minimum PostgreSQL major version is **16**. This specification relies on role-membership options (`WITH INHERIT FALSE, SET TRUE`, C-18, C-19), added in version 16, and on `security_invoker` views (C-16), added in version 15. The exact version is chosen when an environment is approved (D-025). | D-016 |
| B-03 | Schemas: | Technical architecture §4 |

| Schema | Contents | Who writes |
|---|---|---|
| `app` | All module business tables, the P1 tenant tables, their history tables and `global_reference` tables | Owning module only, through the runtime roles; history only through C-22 functions |
| `hos_ctx` | Tenant-context functions used by row-level security policies | Migrations only |
| `kernel` | The allowlisted `SECURITY DEFINER` functions (C-22) and the history guard (E-44) | Migrations only |
| `hos_migration` | Migration helper procedures (C-09) | Migrations only; nobody else may execute them |
| `audit` | P7 audit records and the P7 system security log | P7 kernel writers, insert only (security and audit specification) |
| `eventing` | P3 outbox and inbox | P3 kernel writer and relay (events specification) |
| `ledger` | Reserved for F1/F5 postings with append-only grants. Created by the F1 specification, not in Milestone 1 | — |

There is **no schema per module**. Module ownership is enforced through the table manifest (B-05) and architecture tests. The `public` schema is not used: all privileges on it are revoked from `PUBLIC`.

### 2.2 Module ownership of tables

| ID | Rule | Basis |
|---|---|---|
| B-04 | Each module has a unique **table prefix** declared in its manifest (for example `tenant_` for P1, `iam_` for P2). The full registry is part of the repository specification. Prefixes in this document are illustrative. | D-014, G2 |
| B-05 | Each module's **table manifest** lists, for every table it owns: name, scope class, column classification (E-26), retention class (E-30), whether it is versioned (E-20), and which runtime roles may `UPDATE` or `DELETE` it. | G2, §1.1 of the map |
| B-06 | CI fails if a table exists in the database that no manifest claims, if two manifests claim the same table, or if a manifest entry has no table. | G2 |
| B-07 | Module code may name only tables in its own manifest. The data-access layer checks the table name in every query against the calling module's manifest and throws if it doesn't match. The check runs in every environment, because it is a set lookup. Kernel writers (audit, security log, outbox, idempotency store, history capture) are the only exceptions, and are listed explicitly. | G2, D-014 |

### 2.3 Keys and referential integrity

| ID | Rule | Basis |
|---|---|---|
| B-08 | Every table has a single-column primary key `id uuid` (E-01), except tables whose rule defines a composite key: the idempotency store (F-08), version-history tables (E-21) and `global_reference` tables keyed by a standard code (E-39). | Technical architecture §4 |
| B-09 **(rev. 2)** | Every `organization`- and `property`-scoped table has `UNIQUE (organization_id, id)`. Every `property`-scoped table that another property-scoped table references also has `UNIQUE (organization_id, property_id, id)`. These are the targets of the composite foreign keys in B-10. | D-017 |
| B-10 **(rev. 2)** | **Foreign keys include the tenant columns**, according to the scope of both sides (table below). PostgreSQL checks foreign keys without row-level security, so these composite keys are what stop a row referencing another tenant's row, or another property's row. | D-017 |
| B-11 | **Foreign keys across modules** are allowed only to the platform tables `tenant_organization`, `tenant_property`, `tenant_department` (P1) and `iam_user` (P2), and always in composite form. Business modules reference each other's records by ID **without** a foreign key; consistency comes from events and reconciliation. | Technical architecture §4, D-014 |
| B-12 | Platform tables referenced by foreign keys are never hard-deleted at runtime. They change status (for example `inactive`) instead. | D-013, E-17 |
| B-25 | **Optional references.** Tenant columns are always `NOT NULL`; only the reference column itself may be nullable. PostgreSQL's default `MATCH SIMPLE` skips the whole foreign key when **any** of its columns is null, so where one optional reference depends on another (for example a department scope that needs a property scope), a `CHECK` constraint must enforce the dependency. `MATCH FULL` is not used, because it forbids the intended partly-null case. | D-017 |
| B-26 | A catalog test (H-FK-05) fails if any foreign key between tenant tables omits `organization_id`, or if a foreign key between two property-scoped tables omits `property_id`. | D-017 |
| B-27 | A property-scoped table needs its own foreign key to `tenant_property` only if it isn't already anchored to a property through a composite foreign key to a property-scoped parent (as `hk_task_note` is through `hk_task` in block 09). | D-017 |

**Composite foreign-key patterns (B-10):**

| Child scope | Parent scope | Foreign key | Guarantees |
|---|---|---|---|
| organization or property | `tenant_organization` | `(organization_id) → (id)` | Organization exists |
| property | `tenant_property` | `(organization_id, property_id) → (organization_id, id)` | Property belongs to the child's organization |
| organization or property | organization-scoped table | `(organization_id, parent_id) → (organization_id, id)` | Same organization |
| property | property-scoped table, **same property required** (the default) | `(organization_id, property_id, parent_id) → (organization_id, property_id, id)` | Same organization **and same property** |
| property | property-scoped table in **another** property of the organization (only where the module specification allows it, for example a transfer) | `(organization_id, other_property_id) → tenant_property (organization_id, id)` plus `(organization_id, parent_id) → parent (organization_id, id)` | Same organization; the cross-property link is explicit and justified |
| organization | optional property or department scope | `(organization_id, scope_property_id) → tenant_property (organization_id, id)` and `(organization_id, scope_property_id, scope_department_id) → tenant_department (organization_id, property_id, id)`, plus the B-25 `CHECK` | The scope belongs to the organization; the department belongs to that property |

These patterns are demonstrated and tested in validated blocks 05, 08 and 09 (tests H-FK).

### 2.4 Standard columns

| Column | Type | Required on | Notes |
|---|---|---|---|
| `id` | `uuid` | every table | E-01 |
| `organization_id` | `uuid NOT NULL` | `organization` and `property` scope | Leading column of tenant indexes |
| `property_id` | `uuid NOT NULL` | `property` scope | A-09 |
| `created_at`, `updated_at` | `timestamptz NOT NULL` | every mutable table | Database time; `updated_at` set by the data-access layer on update |
| `created_by`, `updated_by` | `uuid NOT NULL` | every mutable tenant table | Verified actor ID from the context (§4). No foreign key, because actors can be users or service identities |
| `version` | `bigint NOT NULL DEFAULT 1` | every table that can be updated | E-19 |
| `status` | `text NOT NULL` with a `CHECK` list | entities with a lifecycle | Domain statuses are preferred over a generic deleted flag (E-16) |

The P1 tables (validated; run as a migration, §7):

```sql
-- [validated 05 migration: P1 organization, property and department tables]
CREATE TABLE app.tenant_organization (
  id            uuid        PRIMARY KEY,
  display_name  text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('active', 'inactive')),
  version       bigint      NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid        NOT NULL
);
ALTER TABLE app.tenant_organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_organization FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_organization AS PERMISSIVE FOR ALL TO hos_app
  USING (id = (SELECT hos_ctx.org_id()))
  WITH CHECK (id = (SELECT hos_ctx.org_id()));

CREATE TABLE app.tenant_property (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL REFERENCES app.tenant_organization (id),
  display_name     text        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('active', 'inactive')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id)
);
ALTER TABLE app.tenant_property ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_property FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_property AS PERMISSIVE FOR ALL TO hos_app
  USING (organization_id = (SELECT hos_ctx.org_id())
         AND ((SELECT hos_ctx.all_properties()) OR id = ANY ((SELECT hos_ctx.property_ids())::uuid[])))
  WITH CHECK (organization_id = (SELECT hos_ctx.org_id())
         AND ((SELECT hos_ctx.all_properties()) OR id = ANY ((SELECT hos_ctx.property_ids())::uuid[])));

CREATE TABLE app.tenant_department (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  property_id      uuid        NOT NULL,
  code             text        NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  name             text        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('active', 'inactive')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property_id, id),
  UNIQUE (organization_id, property_id, code),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id)
);
CALL hos_migration.enable_tenant_rls('app.tenant_department', 'property');

GRANT SELECT, INSERT, UPDATE ON app.tenant_organization, app.tenant_property, app.tenant_department TO hos_app;

-- Pre-tenant lookups (C-12, C-21): named columns only, through a SELECT-only policy for the lookup owner role.
GRANT SELECT (id, status) ON app.tenant_organization TO hos_lookup_tenant;
GRANT SELECT (id, organization_id, status) ON app.tenant_property TO hos_lookup_tenant;
CREATE POLICY kernel_lookup ON app.tenant_organization AS PERMISSIVE FOR SELECT TO hos_lookup_tenant USING (true);
CREATE POLICY kernel_lookup ON app.tenant_property AS PERMISSIVE FOR SELECT TO hos_lookup_tenant USING (true);
```

The `length(code)` check is a **protective safeguard** on one field (D-013), not a volume limit. The status lists are illustrative; the P1 and P8 specifications define the lifecycle.

### 2.5 Indexes and uniqueness

| ID | Rule | Basis |
|---|---|---|
| B-13 **(rev. 2)** | Every secondary index on a tenant table leads with `organization_id`, then `property_id` for property-scoped tables, so the row-level security predicates can use it. The exceptions are the primary key on `id` and an index that serves an allowlisted pre-tenant lookup (C-21), which is listed in the manifest. | D-013, D-017 |
| B-14 | **Every unique constraint on business values includes the tenant columns** (for example `UNIQUE (organization_id, property_id, room_number)`). There is no global uniqueness on business values: a global constraint would let one tenant learn that a value exists in another tenant through a uniqueness error, because uniqueness checks ignore row-level security. | D-017 |
| B-15 | Where soft deletion exists (E-16), uniqueness uses a partial index, for example `... WHERE deleted_at IS NULL`. | — |
| B-16 **(rev. 2)** | Every foreign key has an index whose leading columns match it. CI checks this (H-MIG-08). Foreign keys to `global_reference` tables are exempt, because their rows are never deleted at runtime. | D-013 |
| B-17 | Partitioning is introduced only when it is justified by measured workload (D-013), through its own reviewed migration. A partitioned table keeps the same policies. Runtime roles get no privileges on individual partitions, only on the parent, so the parent's policies always apply. Candidates (audit, security log, outbox, inbox, integration logs, postings) are decided in their own specifications. | D-013, Technical architecture §4 |
| B-18 | Queries on tenant tables are always bounded: by cursor pagination (F-12), by a key, or by an explicit batch size in jobs. CI flags unbounded `SELECT`s on tenant tables in code review tooling. | G9, D-013 |

### 2.6 Transaction boundaries

| ID | Rule | Basis |
|---|---|---|
| B-19 | A transaction writes the business tables of **exactly one module**, plus that module's kernel records in the same transaction: audit records (P7 writer), outbox events (P3 writer), version history (E-20) and idempotency records (F-08). | §6.1 of the map, D-018 |
| B-20 | **No business transaction spans two modules' tables.** The data-access layer tags each transaction with its owning module and rejects a table outside that module's manifest (B-07). | G2, §6.1 of the map |
| B-21 | A module may not call another module's **write** interface while its own transaction is open. The kernel detects this through the async context and throws. Cross-module processes follow the recoverable-sequence model in §6.1 of the map. | §6.1 of the map |
| B-22 | Every access to a tenant table happens inside an explicit transaction opened by the kernel's tenant-transaction function (C-07). This applies to reads too. | D-017 |
| B-23 | The default isolation level is `READ COMMITTED`. Invariants that depend on concurrent state use a **single conditional statement** (`UPDATE … WHERE … AND status = 'held'`, `… AND available >= $n`) or explicit row locks (`SELECT … FOR UPDATE`). Read-check-write in application code without a lock is prohibited. A module specification may require `SERIALIZABLE` for a named operation, together with retry on serialization failure. | §6.1 of the map |
| B-24 | Transactions are short. No external call (HTTP, SQS, the identity provider, a payment provider) happens while a database transaction is open. | D-018 |

---

## 3. C. PostgreSQL row-level security

### 3.1 Database roles, bootstrap and grants

| Role | Login | Purpose | Key restrictions |
|---|---|---|---|
| `hos_owner` | No | Owns all schemas, tables, procedures and non-definer functions | Never used by running services. Not `SUPERUSER`, not `BYPASSRLS`. Its only member is `hos_migrator`, without inheritance (C-18) |
| `hos_migrator` | Yes | Runs migrations by switching to `hos_owner` (C-18), and to a definer owner role only to create or replace that role's functions (C-19) | Credentials available only to the migration pipeline step. Has no privileges of its own and inherits none |
| `hos_app` | No | Group role holding runtime privileges on tenant tables | Not a member of any owner role; no `BYPASSRLS` |
| `hos_api` | Yes | API service connections; member of `hos_app` | — |
| `hos_worker` | Yes | Worker connections; member of `hos_app` | Also executes the erasure functions and deletes expired transient records (E-36, F-23) |
| `hos_seclog_writer` | Yes | P7 security-event writer (map §7.2) | `INSERT` on the security log only (security and audit specification) |
| `hos_lookup_tenant` | No | Owns the P1 pre-tenant lookup functions (C-21) | `SELECT` on named columns of the P1 tables, through a SELECT-only policy |
| `hos_lookup_identity` | No | Owns the P2 pre-tenant lookup functions (C-21) | `SELECT` on named columns of the P2 user table, through a SELECT-only policy |
| `hos_history_writer` | No | Owns the history capture triggers (E-20) | `INSERT` on history tables, only for the transaction's own tenant |
| `hos_history_reader` | No | Owns the sensitive-history read functions (E-23) | `SELECT` on history tables, only for the transaction's own tenant |
| `hos_history_eraser` | No | Owns the history erasure functions (E-36) | `UPDATE` on the erasable and tombstone columns only, for the transaction's own tenant |
| System roles for the relay, inbox and scheduler | Yes | Defined in the events specification | Cross-tenant access only on their own `eventing` tables |

The P4 webhook lookup owner role is added with P4 (Tier 1), following the same pattern.

| ID | Rule |
|---|---|
| C-01 | No runtime role is `SUPERUSER` or has `BYPASSRLS`, and no runtime role is a member of `hos_owner`, `hos_migrator` or any definer-function owner role. A catalog test enforces this (H-MIG-03, H-MIG-09). |
| C-02 | Runtime roles own no objects. A table owner skips row-level security unless it is forced, and this rule removes that path. |
| C-03 **(rev. 2)** | Privileges are granted per table from the manifest (B-05). By default runtime roles get `SELECT, INSERT, UPDATE` on their tenant tables and **no `DELETE`**. `DELETE` is granted only on tables the manifest marks as deletable (E-17), and only to the role that runs the deletion job. On history tables, runtime roles get `SELECT` on non-sensitive columns only, and nothing else (E-20, E-23). |
| C-04 **(rev. 2)** | Append-only tables (audit, security log, history, posted financial records) never grant `UPDATE` or `DELETE` to a runtime role. The only change that application and maintenance roles can make to a history row is erasure, through the E-36 function. Privileged administrators are outside this rule (E-44, E-46). |
| C-05 | How login roles authenticate (RDS IAM authentication or Secrets Manager rotated passwords) is defined in the security and audit specification. Static passwords in configuration files are prohibited. |
| C-18 | **Migration execution model.** `hos_migrator` is a member of `hos_owner` **`WITH INHERIT FALSE, SET TRUE`**. It therefore has no privileges until the runner executes `SET ROLE hos_owner` at the start of each session (validated session preamble, §7). After `SET ROLE`, every object is created by, and owned by, `hos_owner`. If the runner forgets `SET ROLE`, the migration fails with a permission error instead of silently creating objects owned by the wrong role (H-MIG-10). `hos_migrator` has no `CREATEROLE` or `CREATEDB`. |
| C-19 | **Definer-function owner roles** (`hos_lookup_*`, `hos_history_*`) cannot log in. Their only member is `hos_migrator`, `WITH INHERIT FALSE, SET TRUE`. A migration **creates (and later replaces) each definer function as its designated owner role**: `SET ROLE <owner role>`, then `CREATE [OR REPLACE] FUNCTION`, `REVOKE … FROM PUBLIC`, the allowlisted `GRANT`s, then `SET ROLE hos_owner` (validated blocks 06, 07, 08 and 10). PostgreSQL authorizes each `SET ROLE` against the **session user** (`hos_migrator`), not the current role, so these switches work while the current role is `hos_owner` even though `hos_owner` itself is not a member (H-MIG-16). The owner roles need `CREATE` on schema `kernel` for this; they have no other `CREATE` privilege. `hos_owner` has **no** membership in them, so the role that owns the tables has no path to the definer roles' privileges, and it cannot replace a definer function on its own (H-MIG-15). A trigger's capture function also grants `EXECUTE` to `hos_owner`, because `CREATE TRIGGER` requires it; firing the trigger needs no grant to the runtime roles. |
| C-20 | **Database-level privileges.** `PUBLIC` has no privileges on the cell database: `CONNECT` is granted to login roles only, and **`TEMPORARY` is granted to nobody**, so runtime roles can't create temporary objects that might shadow names. Runtime roles have no `CREATE` privilege on any schema. |
| C-23 | **Bootstrap.** Roles, role memberships, database privileges and schemas are created by a versioned **bootstrap script**, not by migrations, because they need administrator rights (on RDS, the master user). It is applied once per cell by the gated pipeline (applying it on AWS needs founder approval, D-025). Later changes to roles are new reviewed bootstrap revisions. Validated blocks 01 and 02 are its content; each runs as a single transaction. **The administrator is privileged and is outside the protections in this specification:** on PostgreSQL 16 and later, the role that creates a role keeps `ADMIN OPTION` on it (`INHERIT FALSE, SET FALSE`), so the administrator can later grant itself any HOS role. Block 02 uses this only to switch to `hos_owner` while creating schemas, and revokes it in the same transaction (H-MIG-17). Controls on the administrator itself are in E-46. |
| C-24 | Login roles have `TimeZone = 'UTC'` set at role level (block 01), so database sessions never depend on server or client time-zone settings (E-10). |

```sql
-- [validated 01 cluster-admin: bootstrap roles and memberships]
-- Run once per cell by the database administrator (RDS master user). Not a migration (C-23).
CREATE ROLE hos_owner           NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_app             NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_api             LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_worker          LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_migrator        LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_seclog_writer   LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
-- Owners of SECURITY DEFINER functions (C-19, C-21, E-20): cannot log in.
CREATE ROLE hos_lookup_tenant   NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_lookup_identity NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_history_writer  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_history_reader  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE hos_history_eraser  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT hos_app TO hos_api, hos_worker;
GRANT hos_owner TO hos_migrator WITH INHERIT FALSE, SET TRUE;
GRANT hos_lookup_tenant, hos_lookup_identity, hos_history_writer, hos_history_reader, hos_history_eraser
  TO hos_migrator WITH INHERIT FALSE, SET TRUE;

ALTER ROLE hos_api           SET timezone = 'UTC';
ALTER ROLE hos_worker        SET timezone = 'UTC';
ALTER ROLE hos_migrator      SET timezone = 'UTC';
ALTER ROLE hos_seclog_writer SET timezone = 'UTC';
```

```sql
-- [validated 02 database-admin: database privileges and schemas]
-- Run once per cell by the database administrator, connected to the cell database (named hos here),
-- as a single transaction, so the temporary membership below can never be left behind (C-23).
REVOKE ALL ON DATABASE hos FROM PUBLIC;
GRANT CONNECT ON DATABASE hos TO hos_api, hos_worker, hos_migrator, hos_seclog_writer;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- A non-superuser administrator (the RDS master user) must be able to SET ROLE hos_owner to create
-- schemas owned by it. Grant that for these statements only, then remove it.
GRANT hos_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
CREATE SCHEMA app           AUTHORIZATION hos_owner;
CREATE SCHEMA hos_ctx       AUTHORIZATION hos_owner;
CREATE SCHEMA kernel        AUTHORIZATION hos_owner;
CREATE SCHEMA hos_migration AUTHORIZATION hos_owner;
REVOKE hos_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
```

### 3.2 Tenant context variables

The kernel sets these transaction-local settings at the start of every tenant transaction:

| Setting | Value | Used by |
|---|---|---|
| `hos.organization_id` | UUID of the one organization | Policies |
| `hos.property_scope` | `all` or `list` | Policies |
| `hos.property_ids` | PostgreSQL array literal of property UUIDs (empty when the scope is `all`) | Policies |
| `hos.actor_id` | Verified actor UUID | History capture, audit |
| `hos.actor_realm` | `hotel_employee`, `guest` or `machine` | Audit |
| `hos.correlation_id` | Server-generated correlation UUID | History capture, audit, outbox |

| ID | Rule |
|---|---|
| C-06 | The settings are set **only** with `set_config(name, value, true)`, which is the parameterized equivalent of `SET LOCAL`. Session-level `SET` or `set_config(…, false)` on any `hos.*` setting is prohibited. |
| C-07 | Only the kernel's tenant-transaction function sets them, as the first statement after `BEGIN`. An architecture test fails if any other code contains `set_config`, `SET LOCAL` or `SET hos.`. |
| C-08 | All values come from the immutable request context (§4). None is taken from request input. |

```ts
// L0 kernel (P1). Illustrative: the query library is a provisional recommendation (§11).
export async function withTenantTransaction<T>(
  ctx: RequestContext,
  module: ModuleKey,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  assertCompleteContext(ctx);                    // throws ContextMissingError (fail closed)
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(
      `SELECT set_config('hos.organization_id', $1, true),
              set_config('hos.property_scope',  $2, true),
              set_config('hos.property_ids',    $3, true),
              set_config('hos.actor_id',        $4, true),
              set_config('hos.actor_realm',     $5, true),
              set_config('hos.correlation_id',  $6, true)`,
      [ctx.tenant.organizationId,
       ctx.tenant.properties.kind === 'all_in_organization' ? 'all' : 'list',
       toPgUuidArray(ctx.tenant.properties),     // '{}' when the scope is 'all'
       ctx.actor.id, ctx.actor.realm, ctx.correlationId],
    );
    const result = await work(createTenantTx(conn, module));   // enforces B-07 and B-20
    await conn.query('COMMIT');
    return result;
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => conn.destroy());  // never return a broken connection
    throw err;
  } finally {
    conn.release();
  }
}
```

### 3.3 Context functions, policy template and migration helpers

```sql
-- [validated session: migration runner preamble]
-- Executed by the runner as hos_migrator at the start of every migration session (C-18, G-15).
SET ROLE hos_owner;
DO $$
BEGIN
  IF session_user <> 'hos_migrator' OR current_user <> 'hos_owner' THEN
    RAISE EXCEPTION 'migrations must run as hos_migrator under SET ROLE hos_owner (found % / %)',
      session_user, current_user;
  END IF;
END $$;
-- The runner also sets lock_timeout and statement_timeout here, from its configuration (G-06).
```

```sql
-- [validated 03 migration: platform privileges and context functions]
ALTER DEFAULT PRIVILEGES FOR ROLE hos_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

GRANT USAGE ON SCHEMA app, hos_ctx, kernel TO hos_app;
GRANT USAGE ON SCHEMA app TO hos_lookup_tenant, hos_lookup_identity;
GRANT USAGE ON SCHEMA app, hos_ctx TO hos_history_writer, hos_history_reader, hos_history_eraser;
GRANT USAGE, CREATE ON SCHEMA kernel
  TO hos_lookup_tenant, hos_lookup_identity, hos_history_writer, hos_history_reader, hos_history_eraser;

CREATE FUNCTION hos_ctx.org_id() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text := current_setting('hos.organization_id', true);
BEGIN
  -- After a transaction ends, a defined setting reads as '' rather than NULL.
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'tenant context missing' USING ERRCODE = '42501';
  END IF;
  RETURN v::uuid;
END $$;

CREATE FUNCTION hos_ctx.all_properties() RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v text := current_setting('hos.property_scope', true);
BEGIN
  IF v = 'all'  THEN RETURN true;  END IF;
  IF v = 'list' THEN RETURN false; END IF;
  RAISE EXCEPTION 'property scope missing' USING ERRCODE = '42501';
END $$;

CREATE FUNCTION hos_ctx.property_ids() RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(nullif(current_setting('hos.property_ids', true), ''), '{}')::uuid[]
$$;

GRANT EXECUTE ON FUNCTION hos_ctx.org_id(), hos_ctx.all_properties(), hos_ctx.property_ids()
  TO hos_app, hos_history_writer, hos_history_reader, hos_history_eraser;
```

```sql
-- [validated 04 migration: migration helpers and the history guard]
CREATE FUNCTION hos_migration.tenant_predicate(p_scope text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE p_scope
    WHEN 'organization' THEN
      'organization_id = (SELECT hos_ctx.org_id())'
    WHEN 'property' THEN
      'organization_id = (SELECT hos_ctx.org_id()) AND ((SELECT hos_ctx.all_properties())'
      || ' OR property_id = ANY ((SELECT hos_ctx.property_ids())::uuid[]))'
  END
$$;

CREATE PROCEDURE hos_migration.enable_tenant_rls(p_table regclass, p_scope text)
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_pred text := hos_migration.tenant_predicate(p_scope);
BEGIN
  IF v_pred IS NULL THEN RAISE EXCEPTION 'unknown scope class %', p_scope; END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR ALL TO hos_app '
                 'USING (%s) WITH CHECK (%s)', p_table, v_pred, v_pred);
END $$;

CREATE PROCEDURE hos_migration.enable_history_rls(
  p_table regclass, p_scope text, p_sensitive boolean, p_erasable text[])
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_pred text := hos_migration.tenant_predicate(p_scope);
  v_args text := coalesce((SELECT string_agg(quote_literal(c), ', ') FROM unnest(p_erasable) AS c), '');
BEGIN
  IF v_pred IS NULL THEN RAISE EXCEPTION 'unknown scope class %', p_scope; END IF;
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s AS PERMISSIVE FOR SELECT TO hos_app '
                 'USING (%s)', p_table, v_pred);
  EXECUTE format('CREATE POLICY history_write ON %s AS PERMISSIVE FOR INSERT TO hos_history_writer '
                 'WITH CHECK (%s)', p_table, v_pred);
  IF p_sensitive THEN
    EXECUTE format('CREATE POLICY history_read_sensitive ON %s AS PERMISSIVE FOR SELECT '
                   'TO hos_history_reader USING (%s)', p_table, v_pred);
  END IF;
  IF cardinality(p_erasable) > 0 THEN
    EXECUTE format('CREATE POLICY history_erase_select ON %s AS PERMISSIVE FOR SELECT '
                   'TO hos_history_eraser USING (%s)', p_table, v_pred);
    EXECUTE format('CREATE POLICY history_erase ON %s AS PERMISSIVE FOR UPDATE '
                   'TO hos_history_eraser USING (%s) WITH CHECK (%s)', p_table, v_pred, v_pred);
  END IF;
  EXECUTE format('CREATE TRIGGER history_guard BEFORE UPDATE OR DELETE ON %s '
                 'FOR EACH ROW EXECUTE FUNCTION kernel.history_guard(%s)', p_table, v_args);
  EXECUTE format('CREATE TRIGGER history_no_truncate BEFORE TRUNCATE ON %s '
                 'FOR EACH STATEMENT EXECUTE FUNCTION kernel.history_guard()', p_table);
END $$;

-- E-44: the only change a history row accepts is one erasure that clears the erasable columns.
CREATE FUNCTION kernel.history_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_erasable text[] := coalesce(TG_ARGV, '{}');
  v_tombstone text[] := ARRAY['erased_at', 'erasure_reason', 'erasure_reference'];
  v_column text;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'history rows cannot be deleted or truncated (%)', TG_OP USING ERRCODE = '42501';
  END IF;
  IF OLD.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'history version is already erased' USING ERRCODE = '42501';
  END IF;
  IF NEW.erased_at IS NULL OR NEW.erasure_reason IS NULL OR NEW.erasure_reference IS NULL THEN
    RAISE EXCEPTION 'history rows change only by an erasure with a recorded reason' USING ERRCODE = '42501';
  END IF;
  FOREACH v_column IN ARRAY v_erasable LOOP
    IF NOT (to_jsonb(NEW) ? v_column) THEN
      RAISE EXCEPTION 'unknown erasable column %', v_column;
    END IF;
    IF to_jsonb(NEW) -> v_column <> 'null'::jsonb THEN
      RAISE EXCEPTION 'erasure must clear column %', v_column USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF (to_jsonb(NEW) - (v_erasable || v_tombstone)) IS DISTINCT FROM (to_jsonb(OLD) - (v_erasable || v_tombstone)) THEN
    RAISE EXCEPTION 'only erasable columns may change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION kernel.history_guard() FROM PUBLIC;
```

What `enable_tenant_rls(…, 'property')` creates, written out (explanatory):

```sql
ALTER TABLE app.tenant_department ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tenant_department FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON app.tenant_department AS PERMISSIVE FOR ALL TO hos_app
  USING (
    organization_id = (SELECT hos_ctx.org_id())
    AND ((SELECT hos_ctx.all_properties()) OR property_id = ANY ((SELECT hos_ctx.property_ids())::uuid[]))
  )
  WITH CHECK ( /* the same expression */ );
```

An `organization`-scoped table uses only the first predicate. `tenant_organization` and `tenant_property` have their policies written directly (block 05), because their own `id` is the tenant column.

| ID | Rule |
|---|---|
| C-09 **(rev. 2)** | Every `organization`- and `property`-scoped table has row-level security **enabled and forced**, and its policies come only from this allowlist (checked by H-MIG-02): `tenant_isolation` (`FOR ALL TO hos_app`; on history tables `FOR SELECT`); `kernel_lookup` (`FOR SELECT TO` a lookup owner role, C-21); `history_write` (`FOR INSERT TO hos_history_writer`); `history_read_sensitive` (`FOR SELECT TO hos_history_reader`); `history_erase_select` and `history_erase` (`TO hos_history_eraser`). Migrations create tenant policies only through the `hos_migration` helpers, except the two P1 tables whose `id` is the tenant column. |
| C-10 | Policies apply `USING` **and** `WITH CHECK`. Writing a row for another tenant therefore fails, as well as reading one. |
| C-11 **(rev. 2)** | The context functions are wrapped in `(SELECT …)` so PostgreSQL evaluates them once per statement rather than once per row. The property list is written `= ANY ((SELECT hos_ctx.property_ids())::uuid[])`: without the cast, PostgreSQL parses `ANY ((SELECT …))` as a subquery and rejects `uuid = uuid[]` (a defect in revision 1, found by the validation harness). |

### 3.4 Missing context, spoofing and pre-tenant lookups

| ID | Rule |
|---|---|
| C-12 **(rev. 2)** | Code that must run **before** a tenant context exists may use only the allowlisted lookup functions below. Each follows C-21 (access model) and C-22 (definer requirements), and returns status values and IDs only, never business data. Adding a function needs a specification change. |
| C-13 | **Fail closed on missing context.** A tenant query with no context raises SQLSTATE `42501` from `hos_ctx.org_id()` rather than silently returning nothing. The kernel also refuses to open a tenant transaction for an incomplete context, before reaching the database. |
| C-14 | **Spoofing protection, in layers:** (1) context values come only from the trusted context (C-08); (2) only the kernel sets them (C-07); (3) all SQL is parameterized, and string-built SQL fails lint, so SQL injection can't change a setting; (4) `WITH CHECK` blocks writes outside the context even if the context were wrong; (5) a cryptographically signed context is an optional extra layer, **TQ-06**. |
| C-15 | **Connection-pool safety.** Transaction-local settings end at `COMMIT` or `ROLLBACK`, so a pooled connection never carries a tenant into the next transaction. In addition: a connection is destroyed rather than returned if `ROLLBACK` fails; the pool runs in transaction mode only; and if a connection proxy is introduced later, its handling of transaction-local settings must be verified before adoption (its cost also falls under D-025). |
| C-16 **(rev. 2)** | **Objects that could bypass policies:** every view is created `WITH (security_invoker = true)`; materialized views over tenant data are prohibited (they have no row-level security); `SECURITY DEFINER` functions exist only on the C-22 allowlist; **no function, procedure, table or schema in the HOS schemas is usable by `PUBLIC`**. A function whose access list is empty (`proacl IS NULL`) counts as executable by `PUBLIC`, so every function gets an explicit `REVOKE ALL … FROM PUBLIC` in addition to the default-privilege revoke in block 03. Catalog tests enforce all of this (H-MIG-03, H-DEF). |
| C-17 **(rev. 2)** | **The owner sees no tenant rows.** Policies apply only to the roles they name, and row-level security is forced, so `hos_owner` (and therefore a migration) reads and changes **no tenant rows**: a data change on a tenant table inside a schema migration silently affects nothing (H-MIG-12). Schema migrations therefore contain **no DML on tenant tables** (lint rule, G-08). Tenant data backfills run as per-tenant jobs with a normal tenant context (G-09). |
| C-21 | **Access model for pre-tenant lookups.** Each lookup function is owned by a lookup owner role for its module (`hos_lookup_tenant` for P1, `hos_lookup_identity` for P2, a P4 role later). That role has: (1) `SELECT` on **named columns only** (column grants), never whole tables; (2) one `kernel_lookup` policy per table, `FOR SELECT` with `USING (true)`, because a pre-tenant lookup is by nature not yet inside a tenant; (3) no `INSERT`, `UPDATE` or `DELETE`; (4) no login, and no member that inherits or can switch to it except `hos_migrator`, whose membership is `SET`-only and used only to create or replace the role's functions (C-19). Runtime roles therefore reach these privileges **only** by calling the function (H-LOOK-04, H-MIG-09). Lookups that take an organization and a property return `not_found` when the property belongs to a different organization, so they never confirm another tenant's IDs. |
| C-22 | **Requirements for every `SECURITY DEFINER` function:** (1) created by, and owned by, its designated owner role (C-19), never by `hos_owner`, a login role or a superuser; (2) `SET search_path = pg_catalog, pg_temp` in the definition, and every object name schema-qualified; (3) `REVOKE ALL … FROM PUBLIC`, then `GRANT EXECUTE` only to the named roles in the allowlist below; (4) `LANGUAGE sql`, or `plpgsql` **without** dynamic `EXECUTE`; (5) never `LEAKPROOF`; (6) listed in the allowlist below, with owner and callers, which the catalog test compares with the database (H-DEF-01). Combined with C-20 (no `TEMPORARY`, no `CREATE`), callers can't plant objects that the function might resolve by name. |

**Allowlist of `SECURITY DEFINER` functions:**

| Function | Owner | Reads / writes | Returns | Executable by |
|---|---|---|---|---|
| `kernel.organization_status(org)` | `hos_lookup_tenant` | `tenant_organization (id, status)` | `active`, `inactive` or `not_found` | `hos_app` |
| `kernel.property_status(org, property)` | `hos_lookup_tenant` | `tenant_property (id, organization_id, status)` | `active`, `inactive` or `not_found` | `hos_app` |
| `kernel.resolve_principal(org, issuer, subject)` | `hos_lookup_identity` | `iam_user (id, organization_id, idp_issuer, idp_subject, status)` | actor ID and status, or no row | `hos_app` |
| `kernel.list_memberships(issuer, subject)` | `hos_lookup_identity` | same columns | organization IDs where an active user exists | `hos_app` |
| `kernel.<table>_capture_version()` (trigger) | `hos_history_writer` | inserts into `<table>_history` | — | `hos_owner` only, because `CREATE TRIGGER` requires it; runs only when the trigger fires |
| `kernel.<table>_history_sensitive(entity, version)` | `hos_history_reader` | `<table>_history`, current tenant only | sensitive values or tombstone | `hos_app` |
| `kernel.<table>_erase_history(entity, reason, reference)` | `hos_history_eraser` | updates erasable and tombstone columns, current tenant only | number of versions erased | `hos_worker` |
| P4 webhook endpoint lookup | P4 lookup role | P4 connector-instance columns | connector instance, tenant, credential reference | `hos_app` (added with P4) |

```sql
-- [validated 07 migration: P1 pre-tenant lookup functions]
SET ROLE hos_lookup_tenant;           -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.organization_status(p_organization_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT o.status FROM app.tenant_organization AS o WHERE o.id = p_organization_id),
    'not_found')
$$;
REVOKE ALL ON FUNCTION kernel.organization_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.organization_status(uuid) TO hos_app;

CREATE FUNCTION kernel.property_status(p_organization_id uuid, p_property_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(
    (SELECT p.status FROM app.tenant_property AS p
      WHERE p.id = p_property_id AND p.organization_id = p_organization_id),
    'not_found')
$$;
REVOKE ALL ON FUNCTION kernel.property_status(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.property_status(uuid, uuid) TO hos_app;
SET ROLE hos_owner;
```

---

## 4. D. Trusted request and actor context

This section turns the trusted-context rules of [map §7.1](HOS_MODULE_MAP.md#71-tier-0-bootstrap-sequence) into contracts. It doesn't repeat them.

### 4.1 Context type

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganizationId = Brand<string, 'OrganizationId'>;
export type PropertyId     = Brand<string, 'PropertyId'>;
export type ActorId        = Brand<string, 'ActorId'>;

export type ActorRealm = 'hotel_employee' | 'guest' | 'machine';   // realm 1 (Leptron) never exists in a cell, map §1.2

export interface VerifiedActor {
  readonly id: ActorId;
  readonly realm: ActorRealm;
  readonly kind: 'user' | 'service_identity' | 'support_session';
}

export type PropertyScope =
  | { readonly kind: 'all_in_organization' }
  | { readonly kind: 'listed'; readonly propertyIds: readonly PropertyId[] };

export interface RequestContext {
  readonly requestId: string;                  // server-generated
  readonly correlationId: string;              // server-generated (or from a trusted event envelope)
  readonly clientCorrelationId: Untrusted<string> | null;   // recorded for tracing only
  readonly causationId: string | null;         // the event that caused this work, if any
  readonly entryPoint: 'api' | 'event_consumer' | 'scheduled_task' | 'webhook' | 'provisioning';
  readonly actor: VerifiedActor;
  readonly onBehalfOf: VerifiedActor | null;
  readonly tenant: { readonly organizationId: OrganizationId; readonly properties: PropertyScope };
}
```

| ID | Rule | Basis |
|---|---|---|
| CX-01 | A `RequestContext` is created only by the context factory in the L0 kernel, called only from the trusted entry points (API pipeline, event consumer, scheduler, webhook receiver, provisioning endpoint). An architecture test fails if any other code imports the factory. | Map §7.1 |
| CX-02 | The context is deep-frozen when created and held in async-local storage for the unit of work. There is no setter. Work that needs a different tenant or actor is a new unit of work (for example, an enqueued job). | Map §7.1 |
| CX-03 | Department is **not** part of the context. Department scope is evaluated per permission check (CX-07). | A-04 |

### 4.2 API requests

| ID | Rule |
|---|---|
| CX-04 | **Authentication.** A credential verifier interface (`verify(credential) → { issuer, subject, realm, authTime, mfa }`) hides the identity provider, which is not yet chosen. Role, permission or tenant claims in a token are **ignored** for authorization. |
| CX-05 | **Tenant in the route.** Tenant-scoped routes are nested under `/v1/organizations/{organizationId}`, and property-scoped routes under `/v1/organizations/{organizationId}/properties/{propertyId}`. The route value is a **claim** until it is verified. The module map's API groups (`/v1/reservations` and so on) are relative to these prefixes; final paths belong to the API specification. (Provisional recommendation, §11.) |
| CX-06 | **Resolution order** (map §7.1): verify the credential; resolve the principal in the claimed organization through `kernel.resolve_principal` (an active user or service identity in that organization); check with `kernel.organization_status` and `kernel.property_status` that the organization is active and the property exists in this cell and belongs to it; check with P2 that the actor holds an assignment covering the route's scope; only then build the context and open the transaction. |
| CX-07 **(rev. 2)** | **Authorization** uses only HOS-owned role assignments (D-021): `authorize(ctx, permission, { propertyId?, departmentId? })`. An assignment scoped to a department covers only resources whose `department_id` matches. For a change to an existing resource, the department used for the check is the one read from the **locked** row inside the same transaction (CX-17); a department value supplied by the caller is never used for the check. |
| CX-08 | **Same answer for unknown and unauthorized.** An unknown organization or property, and one the actor may not access, both return `404 not_found`, so callers can't discover other tenants. The difference is recorded only in the P7 system security log (`tenant_unknown` vs `authz_denied`, map §7.2). |
| CX-09 | **Tenant values in the payload.** Request bodies do not carry `organization_id` or `property_id`; schemas reject unknown fields (F-01). Where a body legitimately references a property (for example, a transfer target), the value must pass its own authorization check. A value that contradicts the route context is rejected as `context_mismatch` and logged (map §7.2). |
| CX-10 | **Non-tenant routes** are an explicit, short list (for example health checks and `/v1/me`, which lists the caller's memberships through `kernel.list_memberships`). Every route declares its scope type: `tenant`, `non_tenant`, `webhook` or `provisioning`. The application refuses to start if a route has no declaration. `kernel.list_memberships` is called only after the credential has been verified, because it reveals which organizations a subject belongs to. |
| CX-17 | **Department checks against concurrent change.** A change to a department-scoped resource: (1) reads the row with `SELECT … FOR NO KEY UPDATE` (or `FOR UPDATE` if a key column changes) inside the tenant transaction; (2) authorizes against the locked row's `department_id`; (3) writes with a conditional statement that repeats both `department_id` and `version` in its `WHERE` clause (validated statements `task_lock`, `task_complete`). If the row changed in between, zero rows are updated and the API returns `409 version_conflict`; the client re-reads and is authorized again. |
| CX-18 | **Reassignment** (changing a resource's department) requires the permission in **both** the current and the target department, both checked against the locked row. The target department must be active and belong to the same property; the composite foreign key enforces the property part (B-10, H-DEPT-07). The write is conditional on the old department and the version (validated statement `task_reassign`). |
| CX-19 | **Changes to role assignments** take effect from the next authorization check. Any permission cache is invalidated by `iam.role_assignment.changed` and expires after a short, configurable time; a request that has already passed its check completes. An assignment scoped to an inactive department grants nothing. |

```sql
-- [validated statement task_lock(uuid, uuid)]
SELECT department_id, version
  FROM app.hk_task
 WHERE id = $1 AND organization_id = $2
   FOR NO KEY UPDATE;
```

```sql
-- [validated statement task_complete(uuid, uuid, uuid, bigint, uuid)]
UPDATE app.hk_task
   SET status = 'done', version = version + 1, updated_at = now(), updated_by = $5
 WHERE id = $1 AND organization_id = $2 AND department_id = $3 AND version = $4;
```

```sql
-- [validated statement task_reassign(uuid, uuid, uuid, uuid, bigint, uuid)]
UPDATE app.hk_task
   SET department_id = $4, version = version + 1, updated_at = now(), updated_by = $6
 WHERE id = $1 AND organization_id = $2 AND department_id = $3 AND version = $5;
```

### 4.3 Background work, webhooks and provisioning

| ID | Rule | Basis |
|---|---|---|
| CX-11 | **Event consumers.** The tenant scope comes from the event envelope (organization, plus property when present). The actor is the consuming module's own cell service identity; `onBehalfOf` is the envelope's actor; the correlation ID is carried over; the causation ID is the event ID. Before handling, the consumer checks `kernel.organization_status` (and `kernel.property_status` when the envelope names a property), and sends events for unknown or inactive tenants to the dead-letter path with an alert. Envelope trust depends on the events specification (only the outbox writer creates envelopes; queue publish permissions). | Map §7.1, D-018 |
| CX-12 | **Consumer permissions.** Each handler declares the permissions its service identity needs in its subscription manifest; P2 checks them on every handled event, exactly as for an API call (G6). | D-021, G6 |
| CX-13 | **Scheduled and batch jobs** run **one tenant per transaction**. A job that covers many tenants (for example B1 hold expiry) lists due work through its system role (events specification), then processes each tenant in its own tenant transaction. No statement ever updates rows of two organizations. | D-017 |
| CX-14 | **Webhooks.** Each connector instance gets an unguessable endpoint ID: `/v1/webhooks/{provider}/{endpointId}`. A P4 lookup function (C-12 allowlist) returns the connector instance, its tenant and the credential reference. The signature is verified **before** anything else is processed. The payload's own tenant or account identifiers are compared with the connector instance and never used to choose a tenant; a mismatch is a `context_mismatch`. Where a provider sends events for many accounts to one URL, the provider account ID in the **verified** payload may be used as the lookup key into connector-instance records; this variant is defined per connector in the P4 specification. | Map §7.1, D-012 |
| CX-15 | **Provisioning.** The provisioning entry point accepts only the Control Plane machine identity with the provisioning scope (map §1.2, §7.1). Its context uses the organization and property IDs in the verified command, because that path creates them. The provisioning identity can only create or update the organization, property, configuration snapshot and first-administrator invitation; every other route denies it. | D-020, map §7.1 |
| CX-16 | **Support sessions.** A Leptron support session (C6) acts in the cell as actor kind `support_session`, inside one organization, with the grant's scope and expiry. The grant format belongs to the Control Plane–cell contract specification. | Map §1.2 |

---

## 5. E. Data conventions

### 5.1 Identifiers

| ID | Rule | Basis |
|---|---|---|
| E-01 | Primary keys are **UUIDv7**, generated by the application. They are globally unique across cells (no cell-local sequences). | Technical architecture §4, D-013 |
| E-02 | UUIDv7 values contain their creation time. Identifiers that guests or the public see in links (for example document links or self-service tokens) use separate random tokens, not primary keys. | — |
| E-03 | **Deterministic operation IDs** (map §6.1, for example the hold ID derived from reservation and attempt) are UUIDv5 values over a namespace UUID registered for each operation type in code. | Map §6.1 |
| E-04 | In TypeScript, each entity ID is a branded type (`ReservationId`, `PropertyId` and so on), so IDs of different entities can't be swapped by mistake. In JSON and SQL, IDs are lowercase canonical UUID strings. | — |
| E-05 | Human-readable references (confirmation numbers, invoice numbers) are separate fields, unique within their tenant scope (B-14). Their format, and for invoices any legal numbering rules, belong to the owning module and jurisdiction configuration (F2, P8; U-013). | U-013 |

### 5.2 Money, currency, precision and rounding

| ID | Rule | Basis |
|---|---|---|
| E-06 **(rev. 2)** | Money is always an **exact decimal amount plus an ISO 4217 currency code**. Storage: `<name>_amount numeric(38, 4)` with its currency columns (E-39). **The `numeric(38, 4)` type is provisional: it is conditional on financial validation (§11).** Floating-point types (`real`, `double precision`, JavaScript `number`) are prohibited for money. | G7 |
| E-07 | **Every amount carries its own currency.** No column is assumed to be in "the property currency" or "the organization currency". Which currency a given financial record uses, conversions and exchange rates all depend on the four currency concepts of **U-014**, and are defined in the finance specifications. Arithmetic on two amounts with different currencies throws. A row may share one set of currency columns across several amounts only where its module specification states that all of them are always in the same currency. | U-014 |
| E-08 **(rev. 2)** | **Precision.** A settled or posted amount must not have more decimal places than its currency's minor unit, and the **database enforces this** (E-39). Intermediate calculations keep full precision and round only at a point the module specification defines. Rates and percentages are stored as decimal fractions in `numeric` columns whose scale is declared per column. Values that exceed a column's precision are rejected, never truncated (PostgreSQL raises `22003`). | — |
| E-09 **(rev. 2)** | **Rounding.** Every rounding call names its mode explicitly; the money library has **no default mode**. Tax rounding (mode, and whether per line or per document) comes from F6 tax configuration for the jurisdiction (MM-16, U-013) and is not decided here. Splitting an amount uses E-41, which needs no rounding mode. | MM-16, U-013 |
| E-39 | **Currency reference and database enforcement.** `app.ref_currency` (`global_reference`) holds each ISO 4217 code with its minor unit; rows are keyed by `(code, minor_unit)`, and exactly one row per code is current. Every posted amount stores its `currency` **and** the `currency_minor_unit` that applied, with a composite foreign key to `ref_currency (code, minor_unit)` and `CHECK (amount = round(amount, currency_minor_unit))`. The foreign key proves the minor unit is the right one for the code; the check proves the amount respects it. If ISO 4217 changes a minor unit, a new row becomes current and existing records keep the unit they were created with (D-012). The `0–4` range in the reference table matches the `numeric(38, 4)` scale and changes with it. | D-012, E-06 |
| E-40 | **Decimal arithmetic.** Code uses one configured decimal context, never the library default: at least **64 significant digits**, exponent notation disabled for output. With that precision, addition, subtraction and multiplication of stored amounts (at most 38 digits) by rates with at most 26 significant digits are exact. **Division**, and any operation whose result can exceed the configured precision, is always followed by an explicit rounding to a declared scale and mode. Parsing accepts only `^-?(0|[1-9][0-9]*)(\.[0-9]+)?$`; exponent notation, leading `+`, thousands separators and `NaN`/`Infinity` are rejected. | — |
| E-41 | **Allocation** (splitting an amount across folios, instalments or lines). Weights are **non-negative decimal strings or integers, never floating-point numbers**, and at least one weight must be positive. The algorithm uses exact integer arithmetic: convert the total to a count of minor units and scale the weights to integers; give each part `floor(units × wᵢ / Σw)`; hand the remaining units, one each, to the parts with the largest remainders, breaking ties by lowest index; restore the sign of the total. The parts are always exact multiples of the minor unit, always add up to exactly the total, and a zero total gives zero parts. | — |
| E-42 | **Comparison and output.** Amounts are compared numerically, never as text (`"1.5"` equals `"1.50"`). In API responses, posted amounts are formatted with exactly the currency's minor-unit scale (`"1.50"` for USD, `"100"` for JPY). | — |

```ts
// Provisional library: decimal.js (§11). One configured context; the default export is never used.
const Dec = Decimal.clone({ precision: 64, toExpNeg: -64, toExpPos: 64 });

export interface Money { readonly amount: string; readonly currency: CurrencyCode }   // amount as a decimal string
export type RoundingMode = 'half_up' | 'half_even' | 'half_down' | 'up' | 'down';

// No default mode: callers must choose, and tax code takes the mode from F6 configuration.
export function roundToMinorUnit(m: Money, mode: RoundingMode): Money;
// E-41: weights are decimal strings (or integers), never JavaScript numbers; exact integer arithmetic inside.
export function allocate(total: Money, weights: readonly string[]): Money[];
```

In the API, amounts are JSON **strings** (`{"amount": "1250.50", "currency": "EUR"}`). A JSON number in a money field is a validation error. The database driver must return `numeric` as a string, and code never converts it to a JavaScript `number`.

```sql
-- [validated 11 migration: currency reference and an illustrative posting table]
CREATE TABLE app.ref_currency (                              -- global_reference (A-10)
  code        char(3)  NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  minor_unit  smallint NOT NULL CHECK (minor_unit BETWEEN 0 AND 4),
  is_current  boolean  NOT NULL,
  PRIMARY KEY (code, minor_unit)
);
CREATE UNIQUE INDEX ref_currency_one_current ON app.ref_currency (code) WHERE is_current;
GRANT SELECT ON app.ref_currency TO hos_app;

-- Illustrative F1 shape: shows E-39 (minor-unit enforcement) and E-43 (date provenance).
CREATE TABLE app.fol_posting (
  id                         uuid          PRIMARY KEY,
  organization_id            uuid          NOT NULL,
  property_id                uuid          NOT NULL,
  amount                     numeric(38, 4) NOT NULL,
  currency                   char(3)       NOT NULL,
  currency_minor_unit        smallint      NOT NULL,
  posting_date               date          NOT NULL,
  posting_date_time_zone     text          NOT NULL CHECK (posting_date_time_zone <> ''),
  posting_config_version_id  uuid          NOT NULL,
  tzdb_version               text          NOT NULL CHECK (tzdb_version <> ''),
  created_at                 timestamptz   NOT NULL DEFAULT now(),
  created_by                 uuid          NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id),
  FOREIGN KEY (currency, currency_minor_unit) REFERENCES app.ref_currency (code, minor_unit),
  CHECK (amount = round(amount, currency_minor_unit))
);
CREATE INDEX fol_posting_property_date_idx ON app.fol_posting (organization_id, property_id, posting_date);  -- B-16
CALL hos_migration.enable_tenant_rls('app.fol_posting', 'property');
GRANT SELECT, INSERT ON app.fol_posting TO hos_app;          -- posted records are append-only (E-18)
```

### 5.3 Time and dates

| ID | Rule | Basis |
|---|---|---|
| E-10 | Instants are `timestamptz`, stored and transmitted in UTC (`2026-11-26T09:30:00Z`). `timestamp without time zone` is prohibited for instants. Database sessions run with `TimeZone = 'UTC'` (C-24). | G7 |
| E-11 | Property-local **dates** (stay dates, posting dates) are `date` columns, computed from the property's IANA time zone in P8 configuration at the moment of the business event, and **stored**. They are never recomputed later from a UTC timestamp, so a later time-zone change (U-016) can't move historical dates. Important dates also record their provenance (E-43). | D-012 |
| E-12 | Property-local **times of day** (for example a standard check-in time) are stored as local time plus the time zone. When such a time doesn't exist on a date (clocks go forward), the next valid instant is used; when it occurs twice (clocks go back), the earlier one is used. Both rules are tested (H-TIME). | — |
| E-13 | Time-zone calculations use the IANA database through the Temporal API (native where the chosen Node.js LTS supports it, otherwise a polyfill; provisional recommendation, §11). Fixed offsets such as `+05:30` are never stored in place of a zone. | — |
| E-14 | A hotel **business date** (the date the property is "trading on", which may differ from the calendar date) is not defined in the blueprint. How and by whom it is advanced is **TQ-04**. Until then, no table may treat the calendar date as the business date. | U-001 context, TQ-04 |
| E-15 | Expiry checks that must be race-free (for example hold expiry, map §6.1) compare against the **database clock** inside the same statement. | Map §6.1 |
| E-43 | **Provenance of important historical dates.** Each module specification lists its important dates (at least: financial posting dates, invoice and tax-point dates, stay dates). Every record holding one stores, at creation and never updated: the **IANA time zone** used (`<date>_time_zone`), the **P8 configuration version** it was derived from (`<…>_config_version_id`), and the **time-zone database version** of the runtime (`tzdb_version`, from Node.js `process.versions.tz`). All three are `NOT NULL`. A later configuration change never alters them (D-012). When TQ-04 is resolved, business-date records also reference the business-day record. Block 11 shows the columns. | D-012, U-016 |

### 5.4 Deletion

| ID | Rule |
|---|---|
| E-16 | Records with a lifecycle use **domain statuses** (`active`, `inactive`, `cancelled` and so on). A generic `deleted_at` column is used only where "deleted" is a genuine user-facing state, together with partial unique indexes (B-15). |
| E-17 | **Hard deletion** at runtime is allowed only for: (a) transient technical records past their expiry (idempotency records, expired sessions); (b) retention expiry jobs; (c) lawful erasure (E-35). Each such table is marked deletable in the manifest (C-03), and each deletion job is audited. History rows are never deleted (E-44). |
| E-18 | **Financial records are never deleted or updated after posting.** Corrections are reversals or new records (D-012: historical financial records keep the values that applied). The F1 specification defines the `ledger` schema grants. |

### 5.5 Versioning, optimistic concurrency and history

| ID | Rule | Basis |
|---|---|---|
| E-19 | Updatable rows have `version bigint`. Every update is `… SET version = version + 1 WHERE id = $id AND organization_id = $org AND version = $expected`. Zero rows updated is a `409 version_conflict`. The API exposes the version as an `ETag`, and updates to versioned resources require `If-Match` (`428 precondition_required` if missing). | G5 |
| E-20 **(rev. 2)** | **Protected history writes.** Every audited entity keeps a version history (map §1.1), written **in the same transaction** by a per-table trigger function `kernel.<table>_capture_version()`, which is `SECURITY DEFINER` and owned by `hos_history_writer` (C-22). Runtime roles have **no** `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE` on history tables, so application code can't forge, change or remove history. The `history_write` policy only accepts rows for the transaction's own tenant. Because the history key includes `version`, an update that doesn't increment `version` fails with a unique violation, which also enforces E-19. | Map §1.1 |
| E-21 **(rev. 2)** | History rows hold: `organization_id`, `property_id` (when property-scoped), `entity_id`, `version`, `recorded_at`, `correlation_id`, `actor_id`, the field values of that version (erasable columns nullable), and the tombstone columns (E-37). Primary key `(organization_id, entity_id, version)`. Same scope class as the base table. **No foreign key to the base table**, because history must outlive the base record's retention. | Map §1.1 |
| E-22 | History is kept as long as the matching audit records are kept, unless retention or lawful erasure applies (map §1.1). | Map §1.1 |
| E-23 **(rev. 2)** | **History access.** Runtime roles may `SELECT` only the **non-sensitive** columns of a history table (column grants), within their tenant. Sensitive historical values are available only through `kernel.<table>_history_sensitive(entity_id, version)` (`SECURITY DEFINER`, owned by `hos_history_reader`, limited to the transaction's tenant by policy). Before calling it, the owning module checks `<module>:history:read_sensitive`, records the purpose and writes the audit record (map §1.1). An architecture test ensures only the module's history repository calls it. | Map §1.1 |
| E-44 **(rev. 2.1)** | **History guard.** Every history table has the `kernel.history_guard` trigger (block 04): it rejects any `DELETE` or `TRUNCATE`, and any `UPDATE` except one erasure that sets the erasable columns to `NULL` and fills all tombstone columns. **What it protects against:** any data change through the application roles and the erasure function, and accidental data changes by maintenance roles. It fires for every role's ordinary DML. **What it does not protect against:** (1) the **table owner** (`hos_owner`, reached only through migrations), which can `DISABLE TRIGGER`, `DROP TRIGGER` or alter the table, so this path is limited by migration lint (G-16), review, and the catalog check that the triggers exist and are enabled (H-MIG-13, run in CI and on a schedule in each environment, H-HIST-12); (2) a **superuser or the RDS administrator**, who can additionally skip ordinary triggers with `session_replication_role = replica` (H-HIST-11), grant itself any role (C-23), change the catalog, or restore an altered backup. **The guard is not a control against privileged database administrators**; that risk is addressed by the independent detection and monitoring in E-46. | Map §1.1 |
| E-46 | **Independent tamper detection for privileged access.** Because no in-database control binds a superuser or the RDS administrator, history and audit integrity against privileged access relies on controls outside that administrator's reach. **Required (detailed in the security and audit specification; none is implemented or tested yet):** (1) administrator credentials are break-glass only, with MFA, short-lived access and an audited request; (2) privileged sessions and DDL are logged to a destination the database administrator can't alter (on RDS, for example, database logs exported to CloudWatch Logs under separate IAM control, with the `pgaudit` extension if approved; an extension and its log volume need approval under B-01 and D-025); (3) AWS CloudTrail records RDS control-plane actions (parameter changes, snapshot restores, master-password resets); (4) the H-MIG-13 and H-DEF catalog checks run on a schedule from a monitoring identity, not only in CI, and alert on drift; (5) history is cross-checked against the hash-chained audit records (E-45), so a changed or deleted version is **detectable** after the fact, even though it can't be **prevented**. | Map §1.1, D-025 |
| E-45 | Whether history rows also carry a digest linked into the audit hash chain is decided in the security and audit specification. Any such digest must not let a reader confirm a guessed sensitive value (for example an identity-document number), so it can't be a plain hash of sensitive values readable by runtime roles. | Map §1.1 |

```sql
-- [validated 06 migration: P1 department history (non-sensitive example)]
CREATE TABLE app.tenant_department_history (
  organization_id    uuid        NOT NULL,
  property_id        uuid        NOT NULL,
  entity_id          uuid        NOT NULL,
  version            bigint      NOT NULL,
  recorded_at        timestamptz NOT NULL,
  correlation_id     uuid        NOT NULL,
  actor_id           uuid        NOT NULL,
  code               text        NOT NULL,
  name               text        NOT NULL,
  status             text        NOT NULL,
  erased_at          timestamptz,
  erasure_reason     text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference  uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.tenant_department_history', 'property', false, '{}');
GRANT SELECT ON app.tenant_department_history TO hos_app;
GRANT INSERT ON app.tenant_department_history TO hos_history_writer;

SET ROLE hos_history_writer;          -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.tenant_department_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.tenant_department_history
    (organization_id, property_id, entity_id, version, recorded_at,
     correlation_id, actor_id, code, name, status)
  VALUES
    (NEW.organization_id, NEW.property_id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid,   -- fails if the context is missing: fail closed
     current_setting('hos.actor_id')::uuid,
     NEW.code, NEW.name, NEW.status);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.tenant_department_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.tenant_department_capture_version() TO hos_owner;   -- CREATE TRIGGER requires it (C-22)
SET ROLE hos_owner;
CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.tenant_department
  FOR EACH ROW EXECUTE FUNCTION kernel.tenant_department_capture_version();
```

```sql
-- [validated 10 migration: illustrative B3 guest profile with sensitive, erasable history]
CREATE TABLE app.crm_guest_profile (
  id                  uuid        PRIMARY KEY,
  organization_id     uuid        NOT NULL REFERENCES app.tenant_organization (id),
  full_name           text,                       -- personal
  id_document_number  text,                       -- sensitive
  version             bigint      NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid        NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid        NOT NULL,
  UNIQUE (organization_id, id)
);
CALL hos_migration.enable_tenant_rls('app.crm_guest_profile', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.crm_guest_profile TO hos_app;

CREATE TABLE app.crm_guest_profile_history (
  organization_id     uuid        NOT NULL,
  entity_id           uuid        NOT NULL,
  version             bigint      NOT NULL,
  recorded_at         timestamptz NOT NULL,
  correlation_id      uuid        NOT NULL,
  actor_id            uuid        NOT NULL,
  full_name           text,
  id_document_number  text,
  erased_at           timestamptz,
  erasure_reason      text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order')),
  erasure_reference   uuid,
  PRIMARY KEY (organization_id, entity_id, version)
);
CALL hos_migration.enable_history_rls('app.crm_guest_profile_history', 'organization', true,
                                      ARRAY['full_name', 'id_document_number']);
-- Runtime: non-sensitive columns only (E-23).
GRANT SELECT (organization_id, entity_id, version, recorded_at, correlation_id, actor_id,
              full_name, erased_at, erasure_reason, erasure_reference)
  ON app.crm_guest_profile_history TO hos_app;
GRANT INSERT ON app.crm_guest_profile_history TO hos_history_writer;
GRANT SELECT ON app.crm_guest_profile_history TO hos_history_reader;
GRANT SELECT (organization_id, entity_id, erased_at),
      UPDATE (full_name, id_document_number, erased_at, erasure_reason, erasure_reference)
  ON app.crm_guest_profile_history TO hos_history_eraser;

SET ROLE hos_history_writer;          -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.crm_guest_profile_capture_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO app.crm_guest_profile_history
    (organization_id, entity_id, version, recorded_at, correlation_id, actor_id,
     full_name, id_document_number)
  VALUES
    (NEW.organization_id, NEW.id, NEW.version, now(),
     current_setting('hos.correlation_id')::uuid, current_setting('hos.actor_id')::uuid,
     NEW.full_name, NEW.id_document_number);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION kernel.crm_guest_profile_capture_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.crm_guest_profile_capture_version() TO hos_owner;   -- CREATE TRIGGER requires it (C-22)
SET ROLE hos_owner;
CREATE TRIGGER capture_version AFTER INSERT OR UPDATE ON app.crm_guest_profile
  FOR EACH ROW EXECUTE FUNCTION kernel.crm_guest_profile_capture_version();

SET ROLE hos_history_reader;
CREATE FUNCTION kernel.crm_guest_profile_history_sensitive(p_entity_id uuid, p_version bigint)
RETURNS TABLE (id_document_number text, erased_at timestamptz, erasure_reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.id_document_number, h.erased_at, h.erasure_reason
    FROM app.crm_guest_profile_history AS h
   WHERE h.entity_id = p_entity_id AND h.version = p_version
$$;
REVOKE ALL ON FUNCTION kernel.crm_guest_profile_history_sensitive(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.crm_guest_profile_history_sensitive(uuid, bigint) TO hos_app;

SET ROLE hos_history_eraser;
CREATE FUNCTION kernel.crm_guest_profile_erase_history(p_entity_id uuid, p_reason text, p_reference uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  UPDATE app.crm_guest_profile_history AS h
     SET full_name = NULL, id_document_number = NULL,
         erased_at = now(), erasure_reason = p_reason, erasure_reference = p_reference
   WHERE h.entity_id = p_entity_id AND h.erased_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;
REVOKE ALL ON FUNCTION kernel.crm_guest_profile_erase_history(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.crm_guest_profile_erase_history(uuid, text, uuid) TO hos_worker;
SET ROLE hos_owner;
```

### 5.6 Audit references

| ID | Rule | Basis |
|---|---|---|
| E-24 | An audit record refers to the changed record as `(module, entity_type, entity_id, entity_version)`, never as "the current record" (map §1.1). | Map §1.1 |
| E-25 | The audit writer (P7 kernel) and its record schema belong to the security and audit specification. This specification supplies the inputs: the context (actor, on-behalf-of, tenant, correlation ID), the entity reference above, and the field classification (E-26) that drives redaction. | G5, G12 |

### 5.7 Sensitive data classification

| Class | Meaning | Handling |
|---|---|---|
| `public` | Safe to publish (for example a property's display name) | No restriction beyond tenancy |
| `internal` | Business data without personal content | Normal permissions |
| `personal` | Identifies or relates to a person (name, email, phone, stay history) | Minimized in logs and audit; erasure and retention rules apply |
| `sensitive` | Personal data whose exposure causes greater harm (identity document numbers, dates of birth from ID documents, health or dietary data where captured) | Field-level encryption where the security and audit specification requires it; redaction marker plus reference in audit; history read only through the E-23 function |
| `secret` | Credentials, keys, tokens | **Never stored in tenant tables.** Kept in AWS Secrets Manager and referenced by ID (P4). The audit writer rejects them (map §1.1) |

| ID | Rule | Basis |
|---|---|---|
| E-26 | Every column of every table has a class in the manifest. CI fails on any unclassified column. | Map §1.1 |
| E-27 | Which legal category a class corresponds to in each jurisdiction (for example "special category" data) needs legal input (U-013, U-020). The technical classes don't decide that. | U-013, U-020 |
| E-28 | **No card data** (D-022). No column may hold a primary account number, card security code or track data. Payment references are provider tokens (M5). A CI scan of fixtures, logs and audit payloads looks for card-number patterns (H-FIN-07). | D-022 |
| E-29 | Logs never contain `personal`, `sensitive` or `secret` values. The logging library redacts by classification, and P6 scrubs again before data leaves the cell (Technical architecture §9). | D-020 |

### 5.8 Retention and erasure boundaries

| ID | Rule | Basis |
|---|---|---|
| E-30 | Each table has a **retention class** in its manifest: `transient`, `operational`, `financial`, `security`, `audit`. | — |
| E-31 | **Retention periods are not set here.** They come from jurisdiction configuration (P8, D-012) and need legal input (U-013, U-020). Until they are approved, no automated purge runs on `financial`, `security` or `audit` data. | U-013, U-020 |
| E-32 | `transient` records (idempotency records, expired sessions) have technical expiry periods set in their own specifications (for example F-23). | — |
| E-33 | Every erasure or purge job is a per-tenant job (CX-13), is audited, and is idempotent. | D-017 |
| E-34 | **Erasure is performed by the owning module.** P7 receives a data-subject request (P7 `/v1/data-requests`) and publishes it; every module that holds `personal` or `sensitive` data for that subject implements an erasure handler and reports completion back to P7. | Map P7, G2 |
| E-35 | Erasure **pseudonymizes or nulls** `personal` and `sensitive` values in the current record and **nulls** them in every history version (map §1.1). Values that financial retention requires are kept until their retention ends; which values those are needs legal input (Technical architecture §10, U-013). | Map §1.1, D-012 |
| E-36 **(rev. 2)** | Erasure changes history rows **only** through `kernel.<table>_erase_history(entity_id, reason, reference)`: `SECURITY DEFINER`, owned by `hos_history_eraser`, executable only by `hos_worker`, limited to the transaction's tenant by policy. The eraser role has `UPDATE` on the erasable and tombstone columns only, and the guard (E-44) rejects anything other than a correct erasure. No runtime role has `UPDATE` on history. | Map §1.1 |
| E-37 | **Tombstone format** (completing map §1.1): columns `erased_at timestamptz`, `erasure_reason text CHECK (erasure_reason IN ('retention_expired', 'data_subject_request', 'legal_order'))` and `erasure_reference uuid` (the P7 data-request ID or the retention policy version). The row keeps `entity_id`, `version` and timestamps; the erased values become `NULL`. Audit references then resolve to a record that says the value was erased, when and why. | Map §1.1 |
| E-38 | **Backups.** Erased data remains in backups until those backups expire. P7 keeps an erasure log, and every restore procedure re-applies it before the restored database is used. | Technical architecture §8 |

---

## 6. F. API and application conventions

### 6.1 Requests, responses and errors

| ID | Rule | Basis |
|---|---|---|
| F-01 | **Validation** happens at the boundary, against the OpenAPI schema: unknown fields are rejected (`additionalProperties: false`); every string has a maximum length; IDs must be UUIDs; money follows E-06 and E-40; dates and times follow §5.3. Validation failures return before any database access. | Technical architecture §3 |
| F-02 | A single resource is returned as plain JSON. A list is returned as `{ "data": [...], "page": { "next_cursor": "…", "has_more": true } }`. | — |
| F-03 | **Errors** use RFC 9457 Problem Details (`application/problem+json`) with a stable machine-readable `code` and the server `request_id`. | — |

```json
{
  "type": "urn:hos:problem:version_conflict",
  "title": "The resource was changed by another request",
  "status": 409,
  "code": "version_conflict",
  "detail": "Expected version 7, found version 8.",
  "request_id": "0193b2f4-6c1e-7cc2-9a51-3f0b7d2a9e10",
  "errors": []
}
```

`type` is a stable URN per error code. Whether it also resolves to published documentation is decided in the API specification.

| `code` | HTTP | When |
|---|---|---|
| `validation_failed` | 400 | Schema validation failed; `errors[]` lists the fields |
| `unauthenticated` | 401 | Credential missing, invalid or expired |
| `forbidden` | 403 | Authenticated and inside the tenant, but the permission check failed for this action (CX-07) |
| `not_found` | 404 | Resource not found, **or** tenant unknown or not authorized (CX-08) |
| `version_conflict` | 409 | Optimistic concurrency failure (E-19, CX-17) |
| `state_conflict` | 409 | Business transition not allowed; a module code follows, for example `inventory.hold_not_active` |
| `idempotency_in_progress` | 409 | Another request with the same idempotency key is still running (F-21); retry after `Retry-After` |
| `idempotency_key_reuse` | 422 | Same key, different request (F-09) |
| `precondition_required` | 428 | `If-Match` missing on a versioned update |
| `rate_limited` | 429 | Protective safeguard (D-013) |
| `internal_error` | 500 | Unexpected failure; no internal detail is returned |
| `unavailable` | 503 | Dependency temporarily unavailable |

| ID | Rule |
|---|---|
| F-04 | Module-specific codes are namespaced `<module>.<code>` and listed in the module's OpenAPI document. |
| F-05 | Error bodies never contain stack traces, SQL, other tenants' identifiers or `personal` values not supplied by the caller. |

### 6.2 Idempotency keys

| ID | Rule | Basis |
|---|---|---|
| F-06 | Every `POST` that creates something or triggers a side effect requires an `Idempotency-Key` header (`400 validation_failed` if missing). `PUT` and `DELETE` are idempotent by design; `PATCH` is protected by `If-Match` (E-19). | G7, map §6.1 |
| F-07 **(rev. 2)** | The key is an opaque client string of 1–255 characters (a protective safeguard); clients should use a random UUID. Its scope is `(organization_id, actor_id, operation, key)`, where `operation` is the HTTP method plus the route template. The same key used for two different operations is two independent keys. | — |
| F-08 **(rev. 2)** | Each module stores keys in its own table, `<prefix>_idempotency_key`, with the standard shape in block 09, written **in the same transaction** as the business change (map §6.1). Expiry is set per operation (F-23). | Map §6.1, G2 |
| F-09 **(rev. 2)** | **Behaviour.** The key row is acquired first in the business transaction (F-20). If a committed, unexpired row exists with the **same** fingerprint (F-19), its stored response is replayed (F-22). A **different** fingerprint returns `422 idempotency_key_reuse`. If the business transaction rolls back, the key row goes with it, so a retry executes again. | Map §6.1 |
| F-10 | Calls between modules use deterministic operation IDs (E-03) instead of client keys. Events use inbox deduplication (D-018, events specification). | Map §6.1 |
| F-19 | **Fingerprint:** SHA-256 over the RFC 8785 (JSON Canonicalization Scheme) form of `{ method, route_template, path_params, query, body, if_match }`, where `query` holds the decoded parameters sorted by name and `body` is the parsed JSON body. Whitespace and key order therefore don't matter. Other headers, credentials and tracing IDs are excluded. A change in any included element makes a retry a reuse (`422`). | — |
| F-20 | **Acquisition** uses the validated statement `idem_acquire`: an `INSERT … ON CONFLICT … DO UPDATE … WHERE` the existing row has expired. It returns a row when this request now owns the key (new, or replacing an expired record). It returns nothing when an **unexpired** row exists; the module then reads it (`idem_lookup`) and replays it or answers `422`. | — |
| F-21 | **Concurrent requests with the same key.** A second request's `idem_acquire` waits for the first request's transaction: if the first commits, the second replays its response; if the first rolls back, the second proceeds as the owner. The wait is bounded by the transaction's `lock_timeout` (configurable); on timeout (SQLSTATE `55P03`) the API returns `409 idempotency_in_progress` with `Retry-After`. Verified with two real sessions (H-IDEM-04 to H-IDEM-06). | — |
| F-22 | **Replay.** The stored response is: status code, the allowlisted headers (`Location`, `ETag`, `Content-Type`) and the body (`idem_complete`). A replay returns it unchanged, with the header `Idempotent-Replayed: true`, even if the resource has changed since. A replay happens only **after** the current request has passed authentication and tenant authorization (CX-06); because the actor is part of the key scope, only the same actor can replay. Only responses from a **committed** transaction are stored: requests rejected before the transaction (validation), rolled-back conflicts and `5xx` errors leave no record, so a retry executes again. | — |
| F-23 | **Expiry and cleanup.** `expires_at = created_at + retention for the operation`. The default retention is **24 hours, provisional (§11)**; a module specification sets a longer period for an operation where client retry windows or business rules need it. An expired record behaves as absent. A per-tenant purge job (`idem_purge`, `hos_worker` only) deletes expired records in bounded batches; the table is marked deletable for that job only (C-03). | E-32 |
| F-24 | **Stored responses are data.** `response_body` is classified like the data it contains (at least `personal` when it contains personal data), is never logged, and is removed by the purge job. | E-26, E-29 |

```sql
-- [validated statement idem_acquire(uuid, uuid, text, text, bytea, interval)]
INSERT INTO app.hk_idempotency_key AS k
       (organization_id, actor_id, operation, idempotency_key, request_fingerprint, created_at, expires_at)
VALUES ($1, $2, $3, $4, $5, now(), now() + $6)
ON CONFLICT (organization_id, actor_id, operation, idempotency_key) DO UPDATE
   SET request_fingerprint = EXCLUDED.request_fingerprint,
       response_status = NULL, response_headers = NULL, response_body = NULL,
       created_at = EXCLUDED.created_at, completed_at = NULL, expires_at = EXCLUDED.expires_at
 WHERE k.expires_at <= now()
RETURNING k.idempotency_key;
```

```sql
-- [validated statement idem_lookup(uuid, uuid, text, text)]
SELECT request_fingerprint, response_status, response_headers, response_body
  FROM app.hk_idempotency_key
 WHERE organization_id = $1 AND actor_id = $2 AND operation = $3 AND idempotency_key = $4
   AND expires_at > now();
```

```sql
-- [validated statement idem_complete(uuid, uuid, text, text, smallint, jsonb, jsonb)]
UPDATE app.hk_idempotency_key
   SET response_status = $5, response_headers = $6, response_body = $7, completed_at = now()
 WHERE organization_id = $1 AND actor_id = $2 AND operation = $3 AND idempotency_key = $4;
```

```sql
-- [validated statement idem_purge(uuid, integer)]
DELETE FROM app.hk_idempotency_key AS k
 USING (SELECT organization_id, actor_id, operation, idempotency_key
          FROM app.hk_idempotency_key
         WHERE organization_id = $1 AND expires_at <= now()
         LIMIT $2) AS e
 WHERE (k.organization_id, k.actor_id, k.operation, k.idempotency_key)
     = (e.organization_id, e.actor_id, e.operation, e.idempotency_key);
```

### 6.3 Pagination

| ID | Rule | Basis |
|---|---|---|
| F-11 | Lists use **cursor pagination only**; offset pagination is prohibited (G9). | G9, D-013 |
| F-12 | The order is always total: the requested sort key, then `id` as the tie-breaker. The cursor is an opaque, versioned, base64url token holding the last row's sort values and ID plus a hash of the filters; using it with different filters returns `validation_failed`. Cursors grant no access: every page runs under the caller's own context. | — |
| F-13 | `limit` has a default and a maximum per request. Both are configurable **protective safeguards** (D-013), never a limit on total volume. Values are set in the API specification. | D-013 |

### 6.4 OpenAPI and module communication

| ID | Rule | Basis |
|---|---|---|
| F-14 | The public API is contract-first OpenAPI 3.1, versioned `/v1`. Each module owns its own OpenAPI document; CI merges them and fails on a breaking change to a published version. | Technical architecture §3 |
| F-15 | **Inside the monolith**, a module is used only through its public interface (`modules/<name>/public`). Importing another module's internals or repositories fails the architecture test. | D-014 |
| F-16 | Synchronous calls between modules pass the caller's `RequestContext` unchanged. The called module authorizes the call itself; a module never assumes the caller already checked. | D-021, G5 |
| F-17 | **No module writes another module's tables**, directly or through SQL, views, triggers or functions (B-07, B-20). The only shared write paths are the kernel writers listed in B-07. | G2, D-014 |
| F-18 | Asynchronous communication is through events from the outbox only (D-018; contracts in the events specification). | D-018 |

---

## 7. G. Database migration conventions

| ID | Rule | Basis |
|---|---|---|
| G-01 | Migrations are **forward-only, versioned SQL files**. There are no down migrations. A mistake is corrected by a new forward migration. | Technical architecture §4 |
| G-02 | **Naming and order:** `migrations/<UTC yyyyMMddHHmmss>_<module>_<description>.sql`. They are applied in strict timestamp order. CI fails if a branch adds a migration older than the newest migration on `main`. | — |
| G-03 | Applied migrations are recorded with a checksum. Editing an applied migration fails the run. | — |
| G-04 | Each migration belongs to one module and changes only that module's tables (checked against the manifest). Shared objects (`hos_ctx`, `kernel`, `hos_migration`, the history guard) belong to P1 and P7 platform migrations. Roles and schemas belong to the bootstrap script, not to migrations (C-23). | G2 |
| G-05 | Each migration runs in one transaction, unless it is marked `-- hos:no-transaction` because it needs `CREATE INDEX CONCURRENTLY`. Such a migration contains exactly one statement. | — |
| G-06 | Migration sessions set a short `lock_timeout` and a `statement_timeout`. Values are set in the runner configuration, not here. A migration that can't get its lock fails and is retried, rather than blocking traffic. | — |
| G-07 | **New tenant tables** in the same migration: row-level security enabled and forced through the `hos_migration` helper, grants from the manifest, the `UNIQUE` targets required by B-09, and indexes per B-13 and B-16. History tables also get their capture function and trigger (E-20). The catalog tests (H-MIG, H-FK, H-DEF) fail otherwise. | D-017 |
| G-08 | **No DML on tenant tables in schema migrations** (lint). DML is allowed only on `global_reference` tables, for reference data. | C-17 |
| G-09 | **Backfills** are separate, versioned, idempotent data-migration jobs that run per tenant under a normal tenant context and a system maintenance service identity, are audited, and record progress so they can resume. | D-017, G5 |
| G-15 | **Runner session.** The runner connects as `hos_migrator`, executes the validated session preamble (`SET ROLE hos_owner` and its check), sets its timeouts, applies the pending migrations, and ends the session. It refuses to run if the preamble's check fails. Inside migration files, `SET ROLE` appears only in the C-19 pattern, and every migration ends as `hos_owner`; the H-MIG-11 ownership test catches any object created under the wrong role. | C-18, C-19 |
| G-16 | **Migration lint rejects:** `CREATE ROLE`, `ALTER ROLE`, `DROP ROLE` and role-membership `GRANT`s (bootstrap only, C-23); `RESET ROLE`; any `SET ROLE` other than to a definer owner role directly before creating, replacing or granting an allowlisted function, followed by `SET ROLE hos_owner`; `DISABLE TRIGGER`; `ALTER … OWNER TO`; `SECURITY DEFINER` on any function not on the allowlist; `GRANT … TO PUBLIC`; `BYPASSRLS`; and DML on tenant tables (G-08). | C-16, C-19, C-22, C-23 |
| G-17 | The bootstrap script (blocks 01–02) is versioned in the repository next to the migrations, reviewed like them, and changed only by new revisions. Applying a revision to an AWS environment needs founder approval under D-025. | C-23, D-025 |

### 7.1 Expand and contract

A breaking change takes several releases, so the previous release (N-1) always works against the current schema (Technical architecture §8: N-1 compatibility).

| Step | Example: replacing column `a` with `b` | Release |
|---|---|---|
| 1. Expand | Add `b` as nullable | N |
| 2. Dual write | Code writes both `a` and `b`; reads `a` | N |
| 3. Backfill | Per-tenant job fills `b` (G-09) | N |
| 4. Switch reads | Code reads `b`, still writes both | N+1 |
| 5. Enforce | `ADD CONSTRAINT … CHECK (b IS NOT NULL) NOT VALID`, then `VALIDATE CONSTRAINT`, then `SET NOT NULL` | N+1 |
| 6. Contract | Stop writing `a`; drop it in a later release | N+2 or later |

Foreign keys are also added `NOT VALID` and then validated. Constraint validation and index builds read all rows regardless of row-level security, so they work under the owner role. Indexes on existing large tables are created `CONCURRENTLY`. A history table gains a new column through the same steps, and its capture function is replaced in the same migration.

### 7.2 Rollback, recovery and production safeguards

| ID | Rule | Basis |
|---|---|---|
| G-10 | **Code rollback** is always possible to N-1, because expand steps never break the previous release. **Schema rollback** isn't performed; recovery is a forward fix. | Technical architecture §8 |
| G-11 | A destructive contract step (dropping a column or table) runs only after the code has stopped using the object for at least one release, and only after a recovery point is confirmed (RDS point-in-time recovery). | Technical architecture §8 |
| G-12 | In production, migrations run as a **gated pipeline step before the code deploy**, per cell, with the `hos_migrator` credentials available only to that step (Technical architecture §11). | D-023, Technical architecture §8, §11 |
| G-13 | Every migration is tested in CI against real PostgreSQL: from an empty database, and from the previous release's schema with representative fixture data. The resulting schemas must match. The previous release's test suite runs against the new schema to prove N-1 compatibility. | Technical architecture §11 |
| G-14 | Rehearsing risky migrations on a restored copy of production data needs AWS resources, so it requires founder approval under D-025. | D-025 |

---

## 8. H. Testing requirements and acceptance tests

All tests below are automated, run in CI against real PostgreSQL (the production major version), and use **test fixtures only** (PROJECT_RULES §3). Fixtures: organizations `OrgA` and `OrgB`; `OrgA` has properties `A1` and `A2` in different countries and time zones (Technical architecture §15 exit criteria); `OrgB` has property `B1`. §12 lists which tests have already been executed against PostgreSQL.

```sql
-- [validated 08 migration: illustrative P2 identity tables and P2 pre-tenant lookups]
CREATE TABLE app.iam_user (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL REFERENCES app.tenant_organization (id),
  idp_issuer       text        NOT NULL,
  idp_subject      text        NOT NULL,
  display_name     text        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('active', 'inactive')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idp_issuer, idp_subject)
);
-- Serves kernel.list_memberships only: the listed B-13 exception.
CREATE INDEX iam_user_subject_idx ON app.iam_user (idp_issuer, idp_subject);
CALL hos_migration.enable_tenant_rls('app.iam_user', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.iam_user TO hos_app;
GRANT SELECT (id, organization_id, idp_issuer, idp_subject, status) ON app.iam_user TO hos_lookup_identity;
CREATE POLICY kernel_lookup ON app.iam_user AS PERMISSIVE FOR SELECT TO hos_lookup_identity USING (true);

CREATE TABLE app.iam_role_assignment (
  id                   uuid        PRIMARY KEY,
  organization_id      uuid        NOT NULL,
  user_id              uuid        NOT NULL,
  role_code            text        NOT NULL,
  scope_property_id    uuid,
  scope_department_id  uuid,
  version              bigint      NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid        NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid        NOT NULL,
  UNIQUE (organization_id, id),
  CONSTRAINT department_scope_needs_property
    CHECK (scope_department_id IS NULL OR scope_property_id IS NOT NULL),       -- B-25
  FOREIGN KEY (organization_id, user_id) REFERENCES app.iam_user (organization_id, id),
  FOREIGN KEY (organization_id, scope_property_id) REFERENCES app.tenant_property (organization_id, id),
  FOREIGN KEY (organization_id, scope_property_id, scope_department_id)
    REFERENCES app.tenant_department (organization_id, property_id, id)
);
CREATE INDEX iam_role_assignment_user_idx  ON app.iam_role_assignment (organization_id, user_id);
CREATE INDEX iam_role_assignment_scope_idx ON app.iam_role_assignment (organization_id, scope_property_id, scope_department_id);
CALL hos_migration.enable_tenant_rls('app.iam_role_assignment', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.iam_role_assignment TO hos_app;

SET ROLE hos_lookup_identity;         -- C-19: definer functions are created by their owner role
CREATE FUNCTION kernel.resolve_principal(p_organization_id uuid, p_issuer text, p_subject text)
RETURNS TABLE (actor_id uuid, actor_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.status
    FROM app.iam_user AS u
   WHERE u.organization_id = p_organization_id AND u.idp_issuer = p_issuer AND u.idp_subject = p_subject
$$;
REVOKE ALL ON FUNCTION kernel.resolve_principal(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.resolve_principal(uuid, text, text) TO hos_app;

CREATE FUNCTION kernel.list_memberships(p_issuer text, p_subject text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.organization_id
    FROM app.iam_user AS u
   WHERE u.idp_issuer = p_issuer AND u.idp_subject = p_subject AND u.status = 'active'
$$;
REVOKE ALL ON FUNCTION kernel.list_memberships(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kernel.list_memberships(text, text) TO hos_app;
SET ROLE hos_owner;
```

```sql
-- [validated 09 migration: illustrative O2 department-scoped tables and an idempotency store]
CREATE TABLE app.hk_task (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  property_id      uuid        NOT NULL,
  department_id    uuid        NOT NULL,
  status           text        NOT NULL CHECK (status IN ('open', 'done')),
  version          bigint      NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, property_id, id),
  FOREIGN KEY (organization_id, property_id) REFERENCES app.tenant_property (organization_id, id),
  FOREIGN KEY (organization_id, property_id, department_id)
    REFERENCES app.tenant_department (organization_id, property_id, id)       -- same property (B-10)
);
CREATE INDEX hk_task_department_idx ON app.hk_task (organization_id, property_id, department_id);
CALL hos_migration.enable_tenant_rls('app.hk_task', 'property');
GRANT SELECT, INSERT, UPDATE ON app.hk_task TO hos_app;

CREATE TABLE app.hk_task_note (
  id               uuid        PRIMARY KEY,
  organization_id  uuid        NOT NULL,
  property_id      uuid        NOT NULL,
  task_id          uuid        NOT NULL,
  body             text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid        NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, property_id, task_id)
    REFERENCES app.hk_task (organization_id, property_id, id)                 -- same property (B-10, B-27)
);
CREATE INDEX hk_task_note_task_idx ON app.hk_task_note (organization_id, property_id, task_id);
CALL hos_migration.enable_tenant_rls('app.hk_task_note', 'property');
GRANT SELECT, INSERT ON app.hk_task_note TO hos_app;

CREATE TABLE app.hk_idempotency_key (
  organization_id      uuid        NOT NULL REFERENCES app.tenant_organization (id),
  actor_id             uuid        NOT NULL,
  operation            text        NOT NULL,
  idempotency_key      text        NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_fingerprint  bytea       NOT NULL CHECK (length(request_fingerprint) = 32),
  response_status      smallint,
  response_headers     jsonb,
  response_body        jsonb,
  created_at           timestamptz NOT NULL,
  completed_at         timestamptz,
  expires_at           timestamptz NOT NULL,
  PRIMARY KEY (organization_id, actor_id, operation, idempotency_key),
  CHECK (expires_at > created_at)
);
CREATE INDEX hk_idempotency_key_expiry_idx ON app.hk_idempotency_key (organization_id, expires_at);
CALL hos_migration.enable_tenant_rls('app.hk_idempotency_key', 'organization');
GRANT SELECT, INSERT, UPDATE ON app.hk_idempotency_key TO hos_app;
GRANT DELETE ON app.hk_idempotency_key TO hos_worker;      -- purge job only (F-23)
```

### 8.1 Tenant isolation (H-ISO)

| ID | Test | Expected |
|---|---|---|
| H-ISO-01 | Under `OrgA` context, `SELECT` every tenant table | Only `OrgA` rows; zero `OrgB` rows |
| H-ISO-02 | Under `OrgA` context, `INSERT` a row with `organization_id = OrgB` | Rejected by `WITH CHECK` |
| H-ISO-03 | Under `OrgA` context, `UPDATE … WHERE id = <OrgB row>`, and `DELETE` likewise on tables marked deletable | 0 rows affected |
| H-ISO-04 | Insert an `OrgA` row whose composite foreign key points at an `OrgB` parent | Foreign-key violation (B-10) |
| H-ISO-05 | `OrgA` creates a business value that `OrgB` already uses in a unique field | Succeeds; no uniqueness error reveals `OrgB` data (B-14) |
| H-ISO-06 | Every tenant table, generated from the manifest: steps 01–04 run automatically | All pass; a new table without tests fails CI |

### 8.2 Cross-property authorization (H-PROP)

| ID | Test | Expected |
|---|---|---|
| H-PROP-01 | A user with a role on `A1` only calls a route under `/properties/A2` | `404 not_found`; security log `authz_denied` with tenant status `verified_not_authorized` |
| H-PROP-02 | The same user runs an organization-level list | Context scope `listed: [A1]`; only `A1` rows returned |
| H-PROP-03 | Directly in SQL with scope `listed: [A1]`, select an `A2` row by ID | 0 rows |
| H-PROP-04 | A user with an organization-wide role runs the same list | Scope `all_in_organization`; `A1` and `A2` rows |
| H-PROP-05 | Insert a property-scoped row for `A2` under scope `listed: [A1]` | Rejected by `WITH CHECK` |

### 8.3 Composite foreign keys (H-FK)

| ID | Test | Expected |
|---|---|---|
| H-FK-01 | Insert an `A1` task note that references an `A2` task of the same organization | Foreign-key violation (same-property key, B-10) |
| H-FK-02 | Insert an `A1` task whose department belongs to `A2` | Foreign-key violation |
| H-FK-03 | Insert a role assignment with a department scope but no property scope | `CHECK` violation (B-25) |
| H-FK-04 | Insert an `OrgA` role assignment scoped to an `OrgB` property | Foreign-key violation |
| H-FK-05 | Catalog: every foreign key between tenant tables includes `organization_id`, and property-to-property keys include `property_id` (B-26) | Zero violations |
| H-FK-06 | Insert an `A1` task note for an `A1` task | Succeeds |

### 8.4 Department-level permissions (H-DEPT)

| ID | Test | Expected |
|---|---|---|
| H-DEPT-01 | A user whose role is scoped to department `Housekeeping@A1` updates a resource with `department_id = Housekeeping@A1` | Allowed |
| H-DEPT-02 | The same user updates a resource with `department_id = Maintenance@A1` | `403 forbidden`; no change; denial recorded |
| H-DEPT-03 | Inspect the policies on every tenant table | No policy references `department_id` (A-04) |
| H-DEPT-04 | A department belongs to `A1`; assign it to a role assignment scoped to `A2` | Rejected by the composite foreign key |
| H-DEPT-05 | Session 1 locks a task (`task_lock`) and, before completing it, session 2 tries to reassign it | Session 2 waits; after session 1 commits, session 2's conditional update affects 0 rows (`version_conflict`) |
| H-DEPT-06 | Session 2 reassigns the task first and commits; session 1 then completes it with the old department and version | 0 rows (`version_conflict`); session 1 must re-read and be authorized again |
| H-DEPT-07 | Reassign a task to a department of another property | Foreign-key violation (CX-18) |
| H-DEPT-08 | Reassignment by a user with permission in only one of the two departments | `403 forbidden` (application test, CX-18) |

### 8.5 Missing and forged context (H-CTX)

| ID | Test | Expected |
|---|---|---|
| H-CTX-01 | Query a tenant table on a connection with no context | SQLSTATE `42501` "tenant context missing" (C-13) |
| H-CTX-02 | Call `withTenantTransaction` with an incomplete context | `ContextMissingError` before any database call |
| H-CTX-03 | Start the application with a route that has no scope declaration | Startup fails (CX-10) |
| H-CTX-04 | Valid user of `OrgA` calls `/v1/organizations/OrgB/...` | `404`; security log `authz_denied`; no `OrgB` table touched (checked through statement logging in the test database) |
| H-CTX-05 | Call `/v1/organizations/<random UUID>/...` | `404`, same body as H-CTX-04; security log `tenant_unknown` |
| H-CTX-06 | Body contains `organization_id` or `property_id` | `400 validation_failed` (unknown field) |
| H-CTX-07 | A transfer body references a property in another organization | Rejected; security log `context_mismatch` |
| H-CTX-08 | Token contains custom claims for organization, roles or permissions | Claims ignored; authorization uses HOS role assignments only |
| H-CTX-09 | Headers such as `X-Organization-Id` or `X-Actor-Id` are sent | Ignored |
| H-CTX-10 | Static scan of the codebase | `set_config` / `SET LOCAL` only in the kernel; the context factory imported only by entry points; no string-built SQL |
| H-CTX-11 | Attempt to modify the context object during a request | Throws (frozen); context unchanged |

### 8.6 Pre-tenant lookups and definer functions (H-LOOK, H-DEF)

| ID | Test | Expected |
|---|---|---|
| H-LOOK-01 | As `hos_api` with no context, `kernel.property_status(OrgA, A1)` and `kernel.organization_status(OrgA)` | `active` |
| H-LOOK-02 | `kernel.property_status(OrgB, A1)` (property of another organization) and a random ID | `not_found` for both (C-21) |
| H-LOOK-03 | As `hos_api` with no context, `SELECT` from `tenant_property` | `42501` (the lookup grants don't leak to callers) |
| H-LOOK-04 | Logged in as `hos_api`, `SET ROLE hos_lookup_tenant` (or any owner role) | Permission denied |
| H-LOOK-05 | Acting as `hos_lookup_tenant`, read a column outside its grant (`display_name`) or `INSERT` a row | Permission denied |
| H-LOOK-06 | `kernel.resolve_principal` and `kernel.list_memberships` for a fixture subject | The fixture user's ID and status; only organizations where the subject is active |
| H-LOOK-07 | Logged in as `hos_api`: create a temporary table, a table in `app`, a function in `kernel`, or anything in `public` | Permission denied for each (C-20) |
| H-DEF-01 | Catalog: every `SECURITY DEFINER` function in the HOS schemas is on the allowlist, owned by its designated owner role (never `hos_owner` or a login role), and has `search_path=pg_catalog, pg_temp` | Pass |
| H-DEF-02 | Catalog: no function or procedure in the HOS schemas is executable by `PUBLIC` (including `proacl IS NULL`) | Zero rows |
| H-DEF-03 | `hos_api` can't execute the erasure function or the `hos_migration` procedures; `hos_worker` can execute the erasure function | Pass |
| H-DEF-04 | Catalog: no `SECURITY DEFINER` function is `LEAKPROOF` | Pass |
| H-DEF-05 | Catalog: no `plpgsql` `SECURITY DEFINER` function uses dynamic `EXECUTE` | Pass |

### 8.7 History protection (H-HIST)

| ID | Test | Expected |
|---|---|---|
| H-HIST-01 | Insert a department, then update it twice | Three history versions, with actor and correlation from the context |
| H-HIST-02 | As `hos_api`, `INSERT` into a history table | Permission denied |
| H-HIST-03 | As `hos_api`, `UPDATE` or `DELETE` a history row | Permission denied |
| H-HIST-04 | Update a department without incrementing `version` | Unique violation; transaction fails (E-20) |
| H-HIST-05 | As `hos_api`, select the sensitive history column; then select the non-sensitive columns | Permission denied; then allowed |
| H-HIST-06 | Call the sensitive-read function under `OrgA` context for an `OrgA` profile, and under `OrgB` context for the same profile | The value; then no row |
| H-HIST-07 | `hos_api` calls the erasure function; `hos_worker` calls it; `hos_worker` calls it again | Permission denied; versions erased with tombstone; 0 versions the second time |
| H-HIST-08 | Direct DML that bypasses row-level security and grants (run as a superuser **only** to reach the trigger; this is not a test of protection against superusers): change a history value; an erasure that keeps an erasable value or changes a non-erasable column; re-erase; `DELETE`; `TRUNCATE` | Rejected by the guard each time (E-44) |
| H-HIST-09 | Acting as `hos_history_writer` under `OrgA` context, insert a history row for `OrgB` | Rejected by `history_write` |
| H-HIST-10 | After erasure, `hos_api` reads the history rows | Erased values are `NULL`; tombstone columns show when and why |
| H-HIST-11 | **Limitation test.** A superuser sets `session_replication_role = replica` and updates a history row (then rolls back) | The update **succeeds** and the guard doesn't fire: documents that triggers don't bind superusers (E-44, E-46) |
| H-HIST-12 | **Limitation and detection test.** `hos_migrator` under `SET ROLE hos_owner` runs `DISABLE TRIGGER history_guard` (then rolls back) | Succeeds (owner DDL); the H-MIG-13 catalog check reports the disabled trigger while it is disabled |
| H-HIST-13 | `hos_api`, `hos_migrator` and `hos_migrator` under `SET ROLE hos_owner` try `SET session_replication_role = replica`; `hos_api` tries `DISABLE TRIGGER` and `DROP TRIGGER` on a history table | Permission denied each time |

### 8.8 Connection-pool leakage (H-POOL)

| ID | Test | Expected |
|---|---|---|
| H-POOL-01 | Pool of size 1: transaction under `OrgA` commits; next query on the same connection has no context | `42501`; `current_setting('hos.organization_id', true)` is empty |
| H-POOL-02 | Pool of size 1: transaction under `OrgA` throws mid-way | Rolled back; the next transaction under `OrgB` sees only `OrgB` rows |
| H-POOL-03 | `ROLLBACK` itself fails (simulated broken connection) | Connection destroyed, not returned to the pool |
| H-POOL-04 | Concurrency test: many parallel units of work over a small pool, each with a random tenant, each asserting that every row it reads belongs to its own tenant | No cross-tenant row in any run |
| H-POOL-05 | Static scan | No session-level `SET` or `set_config(…, false)` on `hos.*` |

### 8.9 Background jobs and events (H-JOB)

| ID | Test | Expected |
|---|---|---|
| H-JOB-01 | Consumer handles an `OrgA` event | Context: tenant `OrgA`, actor = consumer service identity, `onBehalfOf` = event actor, same correlation ID |
| H-JOB-02 | That consumer tries to read `OrgB` data | 0 rows |
| H-JOB-03 | Event for an unknown or deactivated tenant | Not processed; dead-letter path; alert |
| H-JOB-04 | A job covering `OrgA` and `OrgB` | Two separate transactions, each with its own context; no statement touches both |
| H-JOB-05 | Consumer service identity lacks a declared permission | Handling denied and recorded (CX-12) |
| H-JOB-06 | The same event delivered twice | One business effect (D-018; inbox detail in the events specification) |

### 8.10 Webhooks (H-HOOK)

| ID | Test | Expected |
|---|---|---|
| H-HOOK-01 | Valid signature for an `OrgA` connector instance endpoint | Receipt stored under `OrgA` context |
| H-HOOK-02 | Invalid signature | Rejected before any tenant data access; nothing stored in tenant tables |
| H-HOOK-03 | Valid signature, but the payload names an account or tenant that differs from the instance | Rejected; `context_mismatch` logged |
| H-HOOK-04 | Unknown endpoint ID | `404`; `tenant_unknown` logged |
| H-HOOK-05 | The same provider event delivered twice | One stored receipt (provider event ID deduplication) |

### 8.11 Provisioning identity (H-PROV)

| ID | Test | Expected |
|---|---|---|
| H-PROV-01 | Provisioning identity creates organization and property with Control Plane-issued IDs | Created with exactly those IDs, audited |
| H-PROV-02 | The same command repeated | Same result; no duplicate (idempotent) |
| H-PROV-03 | Provisioning identity calls any non-provisioning route, or reads tenant data | Denied |
| H-PROV-04 | Any other identity calls the provisioning route | Denied |

### 8.12 Migrations, roles and catalog (H-MIG)

| ID | Test | Expected |
|---|---|---|
| H-MIG-01 | Catalog query: tenant tables without forced row-level security (below) | Zero rows |
| H-MIG-02 | Every tenant table has a `tenant_isolation` policy, and every policy is on the C-09 allowlist with the right command and role | Pass |
| H-MIG-03 | Runtime and owner roles: not superuser, no `BYPASSRLS`; runtime roles own no objects; no grants to `PUBLIC` on HOS schemas or tables; every view uses `security_invoker`; no materialized view over tenant tables | Pass |
| H-MIG-04 | Manifest vs catalog: every table claimed once; every column classified; scope class matches the columns | Pass |
| H-MIG-05 | Migrations from empty vs from N-1 with fixtures | Identical schemas |
| H-MIG-06 | The N-1 release's tests against the new schema | Pass |
| H-MIG-07 | Edited applied migration; out-of-order timestamp; DML on a tenant table in a schema migration; any G-16 statement | Each fails CI |
| H-MIG-08 | Every foreign key (except to `global_reference` tables) has a matching index; every tenant index leads with `organization_id`, apart from the listed lookup index | Pass |
| H-MIG-09 **(rev. 2.1)** | Role memberships: `hos_migrator` → `hos_owner` and `hos_migrator` → each definer owner role have `inherit = false, set = true`; no other role can inherit or switch to `hos_owner` or a definer role (the bootstrap administrator's `ADMIN`-only creator rows are checked by H-MIG-17); `hos_migrator` inherits nothing; runtime roles are members of `hos_app` only; owner roles can't log in | Pass |
| H-MIG-10 | Logged in as `hos_migrator` **without** `SET ROLE`, create a table in `app` | Permission denied (C-18) |
| H-MIG-11 | After the migrations: every object in the HOS schemas is owned by `hos_owner`, except allowlisted `SECURITY DEFINER` functions owned by their designated roles; `hos_migrator` owns nothing | Pass |
| H-MIG-12 | As `hos_migrator` under `SET ROLE hos_owner`, update a tenant table | 0 rows affected, no error (why G-08 is a lint rule) |
| H-MIG-13 | Every history table has enabled `capture_version`, `history_guard` and `history_no_truncate` triggers | Pass |
| H-MIG-14 | The session preamble, run by any role other than `hos_migrator` | Fails its check |
| H-MIG-15 | Replace a definer function: as `hos_owner` alone; then as `hos_migrator` switched to the designated owner role | First refused; second succeeds, and the owner and the `PUBLIC` revoke are unchanged |
| H-MIG-16 | The migration `SET ROLE` flow: `pg_has_role` for `hos_owner` and `hos_migrator` on the definer roles; then, logged in as `hos_migrator` with current role `hos_owner`, `SET ROLE hos_history_writer` | `hos_owner` has no membership; `hos_migrator` has `SET` but not `USAGE`; the switch succeeds because it is checked against the session user |
| H-MIG-17 | Run the bootstrap (blocks 01–02) as a **non-superuser** administrator with only `CREATEROLE` and `CREATEDB` (the closest local approximation of the RDS master user), then run the whole suite | Bootstrap succeeds; afterwards the administrator holds only `ADMIN`-only rows (`INHERIT FALSE, SET FALSE`) in HOS roles, so the temporary `SET` on `hos_owner` is gone; all other tests pass unchanged |

```sql
-- H-MIG-01: must return zero rows
SELECT c.oid::regclass AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')   -- app, audit, eventing, ledger …
  AND c.relkind IN ('r', 'p')
  AND EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
  AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
```

### 8.13 Idempotency (H-IDEM)

| ID | Test | Expected |
|---|---|---|
| H-IDEM-01 | `idem_acquire` with a new key | One row: this request owns the key |
| H-IDEM-02 | Complete it (`idem_complete`), then `idem_acquire` again with the same key | No row; `idem_lookup` returns the stored fingerprint and response |
| H-IDEM-03 | `idem_acquire` on a key whose record has expired | One row: the expired record is replaced |
| H-IDEM-04 | Two sessions, same key: session 1 acquires and commits after a delay; session 2 acquires meanwhile | Session 2 waits, then gets no row and finds session 1's committed response |
| H-IDEM-05 | As H-IDEM-04, but session 1 rolls back | Session 2 waits, then gets a row (it now owns the key) |
| H-IDEM-06 | As H-IDEM-04, with a short `lock_timeout` in session 2 | SQLSTATE `55P03`, mapped to `409 idempotency_in_progress` |
| H-IDEM-07 | `idem_purge` as `hos_worker`; `DELETE` as `hos_api` | Expired records of the context's tenant only are deleted; `hos_api` is denied |
| H-IDEM-08 | The same key in `OrgB` | Independent of `OrgA` |
| H-IDEM-09 | Fingerprint of the same JSON body with different key order and whitespace; and with one changed value | Equal; different (application test, F-19) |

### 8.14 Financial precision and time (H-FIN, H-TIME)

| ID | Test | Expected |
|---|---|---|
| H-FIN-01 | Round-trip amounts with 0, 2, 3 and 4 minor units through API, database and back | Exactly equal strings |
| H-FIN-02 | `0.1 + 0.2` in the money library | Exactly `0.3` |
| H-FIN-03 | A money field sent as a JSON number | `400 validation_failed` |
| H-FIN-04 | Rounding without a mode | Compile-time error (no default) |
| H-FIN-05 | Allocate `100.00` with weights `["1","1","1"]`; allocate a 0-minor-unit amount in three parts; allocate a negative total; allocate with weights `["0","0"]` | Parts sum exactly to the total (`33.34, 33.33, 33.33`, extra unit to the lowest index); negative parts mirror positive; all-zero weights rejected |
| H-FIN-06 | Add amounts in two currencies | Throws |
| H-FIN-07 | Scan fixtures, logs and audit payloads for card-number patterns | None found (D-022) |
| H-FIN-08 | Insert postings: USD `1.234`; JPY `100.5`; KWD `1.234`; USD with minor unit 3 | Rejected (`CHECK`); rejected; accepted; rejected (foreign key) |
| H-FIN-09 | Insert an amount with more than 34 integer digits | Rejected (`22003`), never truncated |
| H-FIN-10 | Insert the largest `numeric(38, 4)` value and read it back | Exactly equal |
| H-FIN-11 | Parsing `"1e3"`, `"+1"`, `"1,000"`, `"NaN"` | Each rejected (E-40) |
| H-FIN-12 | Multiply a 38-digit amount by a 26-significant-digit rate with the configured context | Exact result, compared with integer arithmetic (E-40) |
| H-FIN-13 | As `hos_api`, `UPDATE` a posting | Permission denied (append-only) |
| H-FIN-14 | Insert a second current reference row for a currency code | Unique violation (E-39) |
| H-TIME-01 | An event at `2026-11-26T20:00:00Z` at properties in two different time zones | Each stores its own correct local date |
| H-TIME-02 | A local time that doesn't exist on a clock-forward date | Next valid instant (E-12) |
| H-TIME-03 | A local time that occurs twice on a clock-back date | Earlier instant (E-12) |
| H-TIME-04 | Change a property's time zone (controlled change) | Stored local dates on existing records unchanged (E-11) |
| H-TIME-05 | A property in a zone with a +14:00 offset and one with −11:00 | Correct local dates for the same instant |
| H-TIME-06 | Session time zone of every login role | `UTC` (C-24) |
| H-TIME-07 | Insert a posting without its time zone, configuration version or time-zone database version | Rejected (`NOT NULL`, E-43) |
| H-TIME-08 | Change the property's configuration after posting | The posting's stored provenance is unchanged; `hos_api` can't update it |
| H-TIME-09 | Records with important dates (from each module manifest) | All carry the three provenance columns (catalog test per module) |

### 8.15 Cells (H-CELL)

| ID | Test | Expected |
|---|---|---|
| H-CELL-01 | Static and configuration scan | No database link, foreign data wrapper or connection string to another cell's database (A-19) |
| H-CELL-02 | Provisioning command for a property of an organization that the Control Plane reports as hosted in another cell | Rejected by the Control Plane until TQ-05 is resolved (A-22; Control Plane–cell contract test) |
| H-CELL-03 | Organization-level query in a cell | Results labelled as "hosted in this cell" (A-18, A-20) |

---

## 9. Dependencies on the other foundation specifications

| Specification | What it must define that this one relies on |
|---|---|
| **Events and the outbox** | Envelope fields and their trust model (CX-11); outbox and inbox tables in `eventing`; relay, inbox and scheduler system roles and their cross-tenant policies (§3.1 table); queue publish permissions; ordering keys; dead-letter handling (H-JOB-03) |
| **Security and audit** | Audit record schema and writer (E-25); security log schema and `hos_seclog_writer` grants (map §7.2); database login authentication (C-05); field-level encryption rules for `sensitive` data; retention values with legal input (E-31); erasure-log replay after restore (E-38); any history digest (E-45); deleting tombstones after audit retention (TQ-07) |
| **Control Plane–cell contract** | Provisioning API and command format (CX-15); machine-identity trust; support-grant format (CX-16); template publication path for `global_reference` templates (A-10); organizations across cells (TQ-05) and the A-22 guard |
| **Identity and authorization** | Permission model detail and assignment scopes (CX-07, CX-17 to CX-19); identity provider integration behind CX-04; principal resolution details, including service identities (CX-06); the real P2 tables that replace the illustrative ones in block 08 |
| **Repository specification** | Monorepo layout, module prefixes registry (B-04), architecture-test tooling (B-07, CX-01, F-15), migration lint (G-16), and the tooling selections in §11 |

---

## 10. Unresolved questions and their impact

| ID | Question | Affects | Technical consequence | Blocks | Recommendation |
|---|---|---|---|---|---|
| TQ-01 | Can a department belong to the organization rather than a property (for example a group finance office)? The blueprint shows Organization → Property → Department. | P1, P2 | Changes `tenant_department.property_id` from required to optional, and how department-scoped roles resolve | Nothing in Milestone 1; the change would be an expand migration | Keep departments property-scoped (A-03) until the founder decides |
| TQ-02 | Is a hotel employee one P2 user per organization, or one person across organizations (for example a management company serving several owner organizations)? | P2, F7 (MM-13) | Per-organization users fit A-01 directly. Cross-organization identity needs a linking design that never merges tenant data | Nothing in Milestone 1 | One user per organization (same identity-provider subject may map to several) |
| TQ-03 | Is a guest account (realm 3) scoped to one organization, or shared across organizations? | P2, B3, O6 | A shared account would be data outside any tenant, which this specification doesn't allow | O6 guest sign-in (Tier 5), not the foundation | Scoped to one organization |
| TQ-04 | How is a hotel **business date** defined and advanced (for example by a night-audit process)? Not in the blueprint. | O1, F1, F5 | Posting dates and reports depend on it (E-14, E-43) | Tier 3 finance (F1), not the foundation | Define in the F1 and O1 specifications; founder confirmation needed because the blueprint doesn't name a night audit |
| TQ-05 | When an organization has properties in several cells, where do its organization-scoped records (users, roles, policies) live? | P1, P2, P8, M9; U-014 (consolidated reporting) | Each cell would hold its own copy, or one cell would be the organization's home. Rules A-19 to A-22 hold either way; A-22 prevents the situation from arising until this is decided | Only a second cell (D-019); launch has one cell | Decide in the Control Plane–cell contract specification before a second cell is created |
| TQ-06 | Should the tenant context be cryptographically signed, so that a context set outside the kernel (for example by SQL injection) is rejected by the policies? | P1 kernel | Extra defence beyond C-14; adds a per-statement verification cost that must be measured | Nothing; the baseline layers in C-14 apply either way | Prototype in Milestone 1 step 3, measure, then decide |
| TQ-07 | When the audit records that a history tombstone serves have themselves expired, how is the tombstone deleted, given that the guard (E-44) forbids deletion? | P7, every module with history | Without a defined path, tombstones accumulate indefinitely | Nothing until the first retention period ends | Define a separate, audited retention procedure in the security and audit specification |

**Existing open items and how this specification handles them:**

| Item | Effect here | Blocks |
|---|---|---|
| U-013, U-020 (template content, data residency) | Retention periods, the legal meaning of data classes and tax rounding stay open (E-09, E-27, E-31) | Purge jobs and tax calculation; not the schema |
| U-014 (currency concepts) | The money type is neutral: every amount carries its own currency (E-07, E-39) | Finance modules (Tier 3), not the foundation |
| U-015 (legal entity, tax registration) | No such tables or attributes (A-05) | F2 and F6 invoicing (Tier 3) |
| U-016 (country or jurisdiction change) | Stored local dates and their provenance don't move (E-11, E-43); the change procedure itself stays open | The controlled change procedure only |
| U-017, U-019 (override rules, template upgrades) | Not affected; P8 configuration specification | P8 configuration lifecycle |
| U-018 (credential ownership) | Secrets never in tenant tables (E-26 `secret`) | P4 connector work (Tier 1) |
| U-021 (capacity targets) | No numbers here; page limits and timeouts are configurable safeguards (F-13, F-21, G-06) | Load-test targets, not the foundation |
| Identity provider (D-021, open) | Hidden behind the credential verifier (CX-04) | P2 provider integration only |

---

## 11. Provisional recommendations (founder review 2026-11-26)

The founder reviewed these proposals and recorded them as **provisional recommendations**. **None is an approved implementation contract.** Each needs a separate, explicit founder approval before it binds implementation.

| # | Item | Status after founder review | Condition before approval |
|---|---|---|---|
| 1 | Data-access library: **Kysely** | **Recommended** | Confirmed in the repository specification |
| 2 | Migration runner | **Not selected.** Compare an established tool plus HOS-specific checks against a small custom runner, then select | The comparison below, presented for approval |
| 3 | Money storage `numeric(38, 4)` (E-06, E-39) | **Conditional on financial validation** | Validation of precision and scale against finance requirements (rates, unit prices, tax, high-denomination currencies), as part of the finance specifications or earlier |
| 4 | Decimal library **decimal.js**; time handling with the **Temporal API** | **Recommended** | Confirmed in the repository specification (E-40, E-13) |
| 5 | Idempotency record expiry: **24 hours** by default | **Default only**, subject to operation-specific retention and retry requirements (F-23) | Each module specification states any operation that needs longer |
| 6 | Tenant-prefixed routes (CX-05) | **Recommended** | Confirmed in the API specification |

**Migration runner comparison (to be completed before selection).** Candidates: an established forward-only tool (for example node-pg-migrate, dbmate or Flyway; capabilities to be verified, not assumed) combined with HOS-specific checks, against a small runner kept in the repository. Criteria:

| Criterion | Why it matters here |
|---|---|
| Forward-only use with checksums of applied migrations | G-01, G-03 |
| A session preamble before migrations (`SET ROLE hos_owner` and its check) | C-18, G-15 |
| Single-statement migrations outside a transaction | G-05 (`CREATE INDEX CONCURRENTLY`) |
| Strict ordering and rejection of out-of-order migrations | G-02 |
| Hooks for the HOS lint and catalog checks | G-08, G-16, H-MIG |
| Running per cell from the pipeline, with no AWS resources in CI | G-12, D-024, D-025 |
| Licence, maintenance activity and the cost of owning a custom runner | Long-term ownership |

---

## 12. Validation status

**Preserved harness and evidence.** The exact harness that produced the results below, its run logs and instructions for re-running it are in [validation/tenancy-2.1-sql-harness/](validation/tenancy-2.1-sql-harness/README.md).

**Executed against real PostgreSQL.** On 2026-11-26 the validation harness ran against a temporary, local **PostgreSQL 18.4** instance (no AWS resources), twice: once with the bootstrap run by a superuser, and once by a **non-superuser administrator with only `CREATEROLE` and `CREATEDB`** that owns the cell database, the closest local approximation of the RDS master user. It:
1. extracted every `-- [validated …]` block from this document and executed it as written: blocks 01–02 as the database administrator, the session preamble and blocks 03–11 as `hos_migrator` (one session per block, each starting with the preamble);
2. prepared every `-- [validated statement …]` block with its parameter types;
3. ran the SQL-level tests as the real login roles `hos_api`, `hos_worker` and `hos_migrator`, plus a superuser only where a test needs one (H-HIST-08 to reach the trigger with direct DML, and the H-HIST-11 limitation test), and ran the two-session concurrency tests in separate database sessions.

**Result of the final runs (revision 2.1):** in **both** bootstrap modes, all 11 blocks, the session preamble and all 7 statements executed without error, and **165 of 165** SQL-level checks passed, including the two-session concurrency tests. Test groups executed: H-ISO-01 to 05, H-PROP-02 to 05, H-FK-01 to 06, H-DEPT-03 to 07, H-CTX-01, H-LOOK-01 to 07, H-DEF-01 to 05, H-HIST-01 to 13, H-POOL-01 and 02, H-MIG-01 to 03, 08 to 17, H-IDEM-01 to 08, H-FIN-08 to 10, 13 and 14, H-TIME-01, 05 to 08. H-HIST-11 and H-HIST-12 are **limitation tests**: they pass by showing that a superuser and the table owner **can** bypass the guard.

**Defects that the harness found in the SQL, and that this revision fixes:**
1. `= ANY ((SELECT hos_ctx.property_ids()))` was parsed as a subquery and failed (`uuid = uuid[]`); present since revision 1. Fixed with an explicit array cast (C-11).
2. `CREATE TRIGGER` needs `EXECUTE` on the trigger function, which the owner no longer had after the `PUBLIC` revoke. Fixed by an explicit grant to `hos_owner` (C-19).
3. Transferring definer functions to their owner roles with `ALTER … OWNER TO` would have left later migrations unable to replace them. Replaced by the create-as-owner model (C-19, H-MIG-15).
4. The illustrative posting table lacked an index for its property foreign key (B-16). Index added.
5. *(Revision 2.1)* Bootstrap block 02 failed for a non-superuser administrator (`must be able to SET ROLE "hos_owner"` on `CREATE SCHEMA … AUTHORIZATION`); the superuser-only run had hidden this. Fixed with a temporary, `SET`-only membership revoked in the same transaction (C-23, H-MIG-17).

Tests marked *application test* in §8 (for example H-CTX-02, H-DEPT-08, H-FIN-05, H-IDEM-09) need application code, which doesn't exist yet.

**Not yet verified:**
- **Amazon RDS behaviour.** The non-superuser bootstrap run approximates, but is not, the RDS master user: RDS adds the `rds_superuser` role and its own restrictions and permissions. Not verified on RDS: creating roles and granting memberships with `WITH INHERIT FALSE, SET TRUE`; the temporary `SET` grant and its revoke in block 02; `ALTER ROLE … SET`; whether `rds_superuser` can set `session_replication_role` (the H-HIST-11 bypass), which must be assumed possible until checked; and the availability and behaviour of `pgaudit` and log export for E-46. All need an approved RDS environment (D-025).
- **Privileged-access controls (E-46).** None is implemented or tested. No test establishes protection against a superuser, the RDS administrator or the table owner; the tests establish only the application-role protections and the bypasses listed in E-44.
- **PostgreSQL 16 and 17.** Only 18.4 was tested. The syntax used exists in 16 and later, but behaviour on the version finally chosen must be re-run.
- **TypeScript.** The examples (`withTenantTransaction`, money types, context types) have not been compiled or run.
- **Performance.** No performance measurement was made (policy evaluation cost, the TQ-06 option, lock waits).
- **Application-level behaviour.** All tests that depend on application code or the identity provider.
