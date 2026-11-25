# HOS Technical Module Map

**Status: APPROVED** by the founder on **2026-11-26**, after the founder review of 2026-11-25 and its correction passes.

**Approved engineering baseline.** The founder explicitly approved:
- the complete **46-module structure** (§2, §5);
- the **ownership rulings MM-01 to MM-16** (§8);
- the **implementation tiers** (§7);
- the **blueprint-to-module reconciliation** (§10).

Together with D-001 to D-025, these are the approved engineering baseline for HOS.

**What the approval does not do:**
- **The MM rulings are not D-numbered decisions.** Recording them in the decision log as D-026 or later needs separate founder authorization.
- **Detailed technical contracts are not yet approved.** Entity and field names, API paths, event names and payloads, permission names, and every item marked "proposed" stay subject to the review of their specification (tenancy and data conventions; events and the outbox; security and audit; Control Plane–cell contract; module specifications). A specification may refine these details, but it may not change the approved module structure, the ownership rulings or the tiers without founder approval.
- **Open questions stay open.** Q-01 to Q-33 (§9), U-001 to U-022 and the open technical decisions are unchanged by this approval.

**Sources:**
- [Blueprint image](../blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png)
- [Blueprint interpretation](../blueprint/BLUEPRINT_INTERPRETATION.md)
- [Unresolved details](../blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md)
- [Decision log](../DECISION_LOG.md) (D-001 to D-025)
- [Technical architecture](TECHNICAL_ARCHITECTURE.md)
- [PROJECT_RULES.md](../../PROJECT_RULES.md)

This document maps each module in the approved blueprint to its technical responsibilities. It is **not** a new product blueprint. It adds no modules, renames none and does not change scope.

## 0. How to read this document

| Label | Meaning |
|---|---|
| **Blueprint** | Capability stated in the approved blueprint (see the interpretation document for the full list) |
| **Approved** | Covered by a decision D-nnn |
| **Proposed** | A technical interpretation: entity names, API groups, event names and permissions. It becomes binding only when the relevant specification is approved. Field-level detail is finalized in specifications. (Module ownership and the implementation order are approved, 2026-11-26.) |
| **MM-nn** | An ownership ruling. All 16 are founder-approved (2026-11-26); their status is in §8. Recording them as D-numbered decisions needs separate authorization. |
| **Q-nn** | An unresolved architectural question (§9) |
| **U-nnn** | An existing open item in the unresolved register |

All entity names, API groups, event names and permission names here are **proposed**. They become contracts only through the event, API and data specifications.

---

## 1. Global rules (apply to every module)

| # | Rule | Basis |
|---|---|---|
| G1 | Every tenant-owned record carries `organization_id`, plus `property_id` when the data is property-scoped. Row-level security plus isolation tests. | D-017 |
| G2 | A module reads or writes **only its own tables**. Other modules' data is reached through that module's public interface or its events. | D-014 |
| G3 | **One source of truth per data concept** (§3). Other modules may keep read-only copies built from events; those copies are never authoritative. | Founder instruction |
| G4 | State changes publish events through the transactional outbox. Delivery is at least once, and consumers are idempotent. | D-018 |
| G5 | Every state-changing operation is authorized by the HOS permission engine and recorded in the Security & Compliance audit store: actor, on-behalf-of user, tenant, correlation ID, and before-and-after traceability through the source record's ID and version (§1.1). Owning modules keep the version history that this traceability relies on. | D-021, Technical architecture §10 |
| G6 | AI agents are machine identities. They use the **same** APIs, permissions, business rules, approvals and audit as people. No direct database access. | D-008, D-021 |
| G7 | Writes accept an `Idempotency-Key`. Money is stored as an exact amount plus a currency code. Times are in UTC; property-local dates use the property's time zone. | Technical architecture §3–4 |
| G8 | Regional behaviour comes from configuration (D-012). Code never branches on hard-coded country names. | D-012 |
| G9 | No hard-coded capacity ceilings; cursor pagination; no unbounded queries. | D-013 |
| G10 | Control Plane modules never hold hotel operational or guest data. Hotel modules never perform Leptron SaaS operations. | D-020, D-009 |
| G11 | External systems are reached only through Integration Hub connectors. Card data is never handled by HOS. | D-011, D-022 |
| G12 | Audit payloads are protected: no secrets, credentials or card data, and only the personal data that is needed. Redaction of sensitive fields is mandatory. Access to historical values is separately authorized, and erasure leaves tombstones rather than broken references (§1.1). | Founder review |
| G13 | Control Plane and cell identities, permissions and audit records are separate (§1.2). | D-014, D-020, D-021, founder review |

### 1.1 Audit data protection

These requirements are finalized in the security and audit specification.
- **Never in an audit payload:**
  - passwords, credentials, API keys, tokens, secrets, encryption keys;
  - raw card data (HOS never has it, D-022);
  - document contents such as ID images (P5 holds those).
- **Keep personal data to a minimum.** Personal data appears in an audit record only where it is needed to explain the change.
- **Field classification.** The data-conventions specification gives every entity field a classification (for example: public, internal, personal, sensitive, secret).
  - The P7 audit writer applies redaction automatically, based on that classification. Modules cannot bypass it.
  - Fields classified as secret are rejected.
  - Sensitive fields are recorded as a redaction marker plus a reference.
- **Before-and-after traceability without copying sensitive records.** Each audit record holds:
  - the changed field names;
  - the actor and the on-behalf-of user;
  - the time, the tenant and the correlation ID;
  - the **ID and version of the source record**.

  Non-sensitive values are recorded directly. Sensitive values are traced through the owning module's record version history, which keeps that module's own access control, so the audit store doesn't become a second copy of sensitive data.
- **Field-level access:**
  - Reading audit records requires `audit:read` in the relevant scope.
  - Sensitive fields are shown only to users who also hold permission on the underlying data.
  - Reads of sensitive audit fields are themselves audited.
- **Tamper evidence:** the hash chain covers the stored, redacted payload.
- **Version-history contract for owning modules:**
  - **Keep enough history.** For every entity that is audited, the owning module keeps a version record for each change: the version number, the time, a correlation ID that links to the audit record, and the field values of that version. This history is kept **for as long as the matching audit record is kept**, unless lawful erasure or the end of retention applies (below).
  - **Reference a specific version.** Audit records point to a specific ID and version, never to "the current record". A later change therefore can't make an earlier audit entry misleading.
- **Access to historical sensitive values:**
  - Reading a **sensitive value from version history** needs its own permission in the owning module (for example `<module>:history:read_sensitive`), limited to the tenant and property.
  - That permission is **not** implied by `audit:read`.
  - Each access records a purpose and is itself audited.
  - Non-sensitive historical values follow the module's normal read permissions.
- **Retention, lawful erasure and tombstones:**
  - When retention ends, or a lawful erasure request applies (P7, D-012), the owning module erases or pseudonymizes the sensitive values **in the current record and in every historical version**.
  - It keeps a **tombstone** for each affected version. The tombstone holds the ID, the version, the timestamps and the reason (which policy or request), but **no erased values**.
  - Audit references then resolve to the tombstone, which says the value was erased and why. **They never break, and never show a later or substitute value as if it were the original.**
  - The audit record itself is unchanged and its hash chain stays intact, because it never held the sensitive values.
- **Minimization and redaction stay mandatory.** This contract adds no sensitive data to audit records. It only governs how the history that audit points to is kept and accessed. The exact retention periods and tombstone format are defined in the tenancy and data conventions specification.

### 1.2 Separation of Control Plane and cell identity and audit
- **The four identity realms stay distinct** (D-021):
  1. Leptron employees
  2. hotel employees
  3. guests
  4. machines and AI agents
- **Where each realm lives:**
  - Leptron employees exist **only in the Control Plane**.
  - Hotel employees and guests exist only in cells (P2).
  - Machine identities are issued **separately per plane**:
    - Control Plane machine identities (for example, the provisioning client);
    - cell machine identities (workers, integrations, AI agents).

    A cell accepts a Control Plane machine identity **only on the provisioning API, with a provisioning-only scope** (D-020).
- **Permissions are separate.**
  - Control Plane permissions (`cp:*`) are defined and evaluated only in the Control Plane; cell permissions only in cells.
  - No role in one plane grants anything in the other.
- **Leptron employees have no standing access to cells.** They reach a cell only through a time-limited C6 support grant.
  - The grant is approved and audited in both planes.
  - Inside the cell, the session acts under a scoped cell identity.
- **Audit:**
  - **P7 owns cell audit.**
  - The Control Plane has **its own, separately governed audit capability**. It is append-only and tamper-evident (mandatory, Q-20), with its own access controls (Leptron roles only).
  - **Cell audit records are not copied wholesale into the Control Plane.** The Control Plane receives only allowlisted, aggregated telemetry (D-020).
  - Where an action spans both planes (provisioning, support access), each plane audits its own part, linked by a shared correlation ID.
- **Implementation:**
  - The Control Plane reuses the same platform code patterns (identity integration, permission engine, audit writer), deployed separately with its own data and configuration.
  - This is **not a new module**.
  - The storage technology for Control Plane audit is not decided here.

---

## 2. Module index

The modules are grouped by plane:
- **Cell:** a HOS cell (D-019).
- **CP:** the Leptron Control Plane (D-014).

Tier is the approved implementation order (§7, founder approval 2026-11-26).

| ID | Module | Blueprint group | Plane | Tier |
|---|---|---|---|---|
| P1 | Multi-Tenant Architecture | Platform Foundation | Cell | 0 |
| P2 | Identity & Access Management | Platform Foundation | Cell (the Control Plane runs a separate instance, §1.2) | 0 |
| P3 | Event & Workflow Engine | Platform Foundation | Cell | 0 |
| P4 | Integration Hub | Platform Foundation | Cell | 1 |
| P5 | Document Management | Platform Foundation | Cell | 1 |
| P6 | Observability & Monitoring | Platform Foundation | Cell + CP | 0 |
| P7 | Security & Compliance | Platform Foundation | Cell (the Control Plane has a separate audit capability, §1.2) | 0 |
| P8 | Configuration & Settings | Platform Foundation | Cell | 0 |
| C1 | Customer Management | Control Plane | CP | 0 |
| C2 | Property Management | Control Plane | CP | 0 |
| C3 | Subscription & Licensing | Control Plane | CP | 3 |
| C4 | Billing & Invoicing (SaaS) | Control Plane | CP | 4 |
| C5 | Platform Health | Control Plane | CP | 2 |
| C6 | Support & Diagnostics | Control Plane | CP | 3 |
| C7 | Deployments & Versions | Control Plane | CP | 2 |
| C8 | Usage & Analytics | Control Plane | CP | 4 |
| C9 | Resource Monitoring & Business Insights | Control Plane | CP | 4 |
| B1 | Inventory & Rate Engine | Core engines | Cell | 2 |
| B2 | Reservations Engine | Core engines | Cell | 2 (payment link added at Tier 3) |
| B3 | CRM & Guest Profile | Core engines | Cell | 2 |
| B4 | Channel Manager | Core engines | Cell | 4 |
| B5 | Communication Engine | Core engines | Cell | 3 |
| O1 | Front Desk Operations | Property operations | Cell | 3 |
| O2 | Housekeeping Management | Property operations | Cell | 3 |
| O3 | Maintenance Management | Property operations | Cell | 4 (after O4) |
| O4 | Engineering Assets | Property operations | Cell | 4 |
| O5 | Security Management | Property operations | Cell | 6 |
| O6 | Guest Experience (Mobile App) | Property operations | Cell (channel) | 5 |
| M1 | POS (F&B & Outlets) | Commercial | Cell | 5 |
| M2 | Inventory & Procurement | Commercial | Cell | 5 |
| M3 | Banquets & Events | Commercial | Cell | 5 |
| M4 | Revenue Management | Commercial | Cell | 6 |
| M5 | Payment Management | Commercial | Cell | 3 |
| M6 | Loyalty Management | Commercial | Cell | 6 |
| M7 | Marketing & Campaigns | Commercial | Cell | 6 |
| M8 | Reputation Management | Commercial | Cell | 6 |
| M9 | Reports & Analytics (BI) | Commercial | Cell | 3+ (incremental) |
| F1 | Folio Management | Finance & Accounting | Cell | 3 |
| F2 | Billing & Invoicing (hotel) | Finance & Accounting | Cell | 3 |
| F3 | Accounts Receivable | Finance & Accounting | Cell | 4 |
| F4 | Accounts Payable | Finance & Accounting | Cell | 5 |
| F5 | General Ledger | Finance & Accounting | Cell | 4 (initial scope, §7) |
| F6 | Tax Management | Finance & Accounting | Cell | 3 |
| F7 | Payroll Management | Finance & Accounting | Cell | 6 |
| F8 | Expense Management | Finance & Accounting | Cell | 6 |
| A1 | AI Workforce (Leptron AI) | AI Workforce | Cell | 7 |

**The Guest Journey & Property Operations Flow is a process across modules, not a module** (§4).

---

## 3. Source-of-truth matrix

| Data concept | Owner (only writer) | Main consumers (read copies or API) | Basis |
|---|---|---|---|
| Organization, property, department records (operational) | P1 Multi-Tenant | All cell modules | Blueprint, D-017 |
| Organization and property registry, cell placement, provisioning status | C2 Property Mgmt / C1 Customer Mgmt | Routing directory, P1 (via provisioning) | D-020, MM-14 |
| Cell users, role assignments, permissions, cell machine identities | P2 IAM (cell) | All cell modules | D-021 |
| Leptron employee identities, Control Plane permissions, Control Plane machine identities | Control Plane identity capability (§1.2) | Control Plane modules | D-021, founder review |
| Regional templates, active configuration, feature-flag values | P8 Configuration & Settings | All | D-012, MM-15 |
| Cell audit records | P7 Security & Compliance | O5 (restricted view), M9 | Blueprint, G5, G12 |
| Control Plane audit records | Control Plane audit capability (separately governed, §1.2) | Leptron roles only | Founder review (Q-20) |
| Denials before tenant context exists (authentication, missing or unknown tenant, authorization before tenant access) | P7 system security log (§7.2), separate from tenant audit | Leptron security operations, under controlled access; Control Plane receives aggregated counts only | Founder review |
| Domain events, outbox and inbox, workflow instances | P3 Event & Workflow Engine | All | Founder instruction |
| Connector configuration, credentials (references), webhook payloads | P4 Integration Hub | Business modules (via capability interfaces) | Blueprint, D-012 |
| Documents and files (guest IDs, contracts, invoice PDFs, templates) | P5 Document Mgmt | O1, F2, M3, B2 | Founder instruction |
| Physical room identity (`Room`), room types (`RoomType`) and sellable inventory (`InventoryAllocation`): three distinct concepts, all owned by B1. Also inventory holds, availability, rate plans, restrictions | B1 Inventory & Rate | B2, B4, M4, O1, O6 | Founder instruction, D-010, MM-01, MM-02 |
| Reservation lifecycle (including stay status: in-house, checked out) | B2 Reservations | O1, O2, F1, B5, M6, M9 | Founder instruction, MM-03 |
| Room assignment on a reservation | B2 Reservations | O1, O2 | MM-04 |
| Guest profile, preferences (including channel preferences), stay history (read copy), corporate profile | B3 CRM | All guest-facing modules | Founder instruction |
| Guest consent records (authoritative) | B3 CRM | B5 (enforces before sending), M7 | Founder review (Q-06) |
| Room housekeeping status | O2 Housekeeping | O1, B1, O6 | Founder instruction (Property Operations), MM-05 |
| Room maintenance blocks (out of order / out of service) | O3 Maintenance | B1 (availability), O1, O2 | Blueprint, MM-05 |
| Communications sent (including chat conversations), templates, delivery status, property channel configuration | B5 Communication Engine | B3 (history view), M7, O6 (presentation), A1 (references) | Founder instruction, founder review (Q-14) |
| Folios and postings | F1 Folio | O1, F2, F5, M9 | Founder instruction |
| Invoices and bills | F2 Billing & Invoicing | F3, B5, P5 | Blueprint, D-009 |
| Operational tax rules (with jurisdiction, source, effective date, version) and tax calculation | F6 Tax Mgmt (P8 supplies the initial regional configuration) | F1, F2, M1, M3 | Blueprint, MM-16 |
| Ledger accounts, journal entries | F5 GL | M9 | Blueprint, D-007 |
| Payment lifecycle (intents, captures, refunds, tokens by reference) | M5 Payment Mgmt | F1, F3, B2, M1 | Founder instruction, D-011, D-022 |
| Physical stock, items, suppliers, purchase orders | M2 Inventory & Procurement | M1, O2, O3 | D-010 |
| POS orders and checks | M1 POS | F1 (via postings) | Blueprint |
| Events and banquet bookings, event spaces | M3 Banquets & Events | F1, F2 | Blueprint |
| Loyalty membership, points | M6 Loyalty | B3 (view), O6 | Blueprint, MM-07 |
| Campaigns, segments | M7 Marketing | B5 (sending) | Blueprint, MM-08 |
| Reviews, sentiment | M8 Reputation | B3, M9 | Blueprint |
| KPI catalogue, definitions and versions; report definitions; analytical read models | M9 Reports & Analytics (source modules own the underlying business facts) | M4 (uses the agreed definitions), all report users | MM-10 |
| Assets | O4 Engineering Assets | O3 | Blueprint |
| Work orders | O3 Maintenance | O4, M9 | Blueprint |
| Agent definitions, agent runs | A1 AI Workforce | P7 (audit) | D-008 |
| SaaS subscriptions, SaaS invoices | C3, C4 | CP only | D-009 |

---

## 4. Guest journey: who owns each stage

The six stages are a **flow across modules**. Each step is performed by its owning module.

| Stage | Steps (blueprint) | Owning module(s) |
|---|---|---|
| 1. Booking | Search Availability; Rates & Packages | B1 |
| | Guest Details | B3 (profile), B2 (reservation) |
| | Add-ons | B2 (Q-03) |
| | Payment (if any) | M5 |
| | Confirmation | B2 (issues it), B5 (sends it) |
| 2. Pre-Arrival | Booking Confirmed, Pre-arrival Email | B5, triggered by B2 events |
| | Upsell / Add-ons | B2 (Q-03) |
| | ID Upload (Digital Check-in) | O6 (channel), P5 (document) |
| | Special Requests | B3 (preferences) or B2 (Q-04) |
| 3. Arrival & Check-In | Arrival List | O1 (view over B2) |
| | ID Verification | O1, using P5 |
| | Registration | O1, writing B2 and B3 |
| | Room Assignment | B2 (MM-04) |
| | Deposit / Payment | M5, then F1 |
| | Check-in | B2 state change, started from O1. O5 issues a door key only when O5 and a door-lock connector are active. |
| | Welcome Message | B5 |
| 4. In-House Stay | Stay Management | B2 |
| | Room Charges | F1 |
| | Service Requests | Q-05 |
| | Housekeeping | O2 |
| | Maintenance | O3 |
| | F&B / POS | M1, then F1 |
| | Final item | **U-001 (unresolved)** |
| 5. Check-Out | Bill Review | F1 |
| | Charges & Taxes | F1, F6 |
| | Payments | M5 |
| | Invoice Generation | F2 |
| | Checkout | B2 state change, started from O1 |
| | Feedback Request | B5, triggered by B2 |
| 6. Post Stay | Thank You Message | B5 |
| | Feedback / Review | M8 |
| | Loyalty Points | M6 |
| | Marketing Campaigns | M7 |
| | Guest Retention | M7, B3 |
| | Repeat Booking | B2 |

---

## 5. Module specifications

Each module uses the same 12 fields. "Audit" lists only what goes **beyond** rule G5.

### 5.1 Platform Foundation

#### P1 Multi-Tenant Architecture
| Field | Specification |
|---|---|
| Purpose | Holds the Organization → Property → Department hierarchy and enforces tenant isolation inside a cell. |
| Responsibilities (Blueprint) | Organization → Property → Department; Tenant Isolation; Data Partitioning; Configuration Management (the scoping of configuration). |
| Owns | `Organization` (cell copy), `Property`, `Department`; the tenant context and row-level security policy conventions. |
| Does not own | Provisioning decisions or cell placement (C2); configuration values (P8); legal entities and tax registrations (U-015). |
| Operations | Create organization and property **only through the provisioning API** (D-020); create, update and deactivate departments; resolve the tenant context for each request. |
| Exposes | Internal: the tenant-context interface. Provisioning API (receiving side). `/v1/organizations`, `/v1/properties`, `/v1/departments` (read; department admin). |
| Publishes | `tenant.organization.provisioned`, `tenant.property.provisioned`, `tenant.property.status_changed`, `tenant.department.created/updated` |
| Consumes | Provisioning commands from C2 (API, not events) |
| Depends on | Bootstrap layers (§7.1): its own tenant-context primitive, the P7 audit writer and the P3 outbox writer (kernel interfaces). Its management APIs also need P2. |
| Permissions / audit | `tenant:department:manage`. Property records are created only by the provisioning service identity. |
| External | — |
| Order | Tier 0 (milestone 1) |

#### P2 Identity & Access Management
| Field | Specification |
|---|---|
| Purpose | Authentication through the identity provider, plus authorization and RBAC owned by HOS (D-021). Covers the cell realms: hotel employees, guests and cell machine identities. Leptron employees and Control Plane permissions are handled by the Control Plane's separate identity capability (§1.2). |
| Responsibilities (Blueprint) | Authentication (SSO/MFA); RBAC & Permission Engine; Session Management; API Authorization; User/Role Management. |
| Owns | `User` (maps to the identity provider's subject), `Role`, `Permission`, `RoleAssignment` (scoped to organization, property or department), `ServiceIdentity` (machines and AI agents), sessions. |
| Does not own | Employee HR records (F7, MM-13); guest profiles (B3); credentials stored by the identity provider. |
| Operations | Sign in through the provider; check permissions; assign roles; issue machine credentials; revoke sessions. |
| Exposes | Internal permission-check interface; `/v1/users`, `/v1/roles`, `/v1/role-assignments`, `/v1/service-identities`. |
| Publishes | `iam.user.created/deactivated`, `iam.role_assignment.changed`, `iam.service_identity.created/revoked` |
| Consumes | `tenant.property.provisioned` (seeds the property's first administrator invitation) |
| Depends on | The P1 tenant-context primitive and the P7 audit writer (kernel interfaces only, §7.1); the identity provider (**open:** Cognito evaluation) |
| Permissions / audit | `iam:user:manage`, `iam:role:manage`. **Every authorization denial is recorded.** Denials before tenant access go to the P7 system security log (§7.2). Granting privileged roles may require approval (Q-15). |
| External | Identity provider; customer SSO providers (SAML/OIDC) |
| Order | Tier 0 |

#### P3 Event & Workflow Engine
| Field | Specification |
|---|---|
| Purpose | Owns event delivery and workflow execution (D-018). |
| Responsibilities (Blueprint) | Event Bus; Workflow Automation; Task Scheduling; Approval Workflows; Business Rule Engine. |
| Owns | Outbox and inbox records, event schemas registry, `WorkflowDefinition`, `WorkflowInstance`, `ApprovalRequest`, `ScheduledTask`, dead-letter records. |
| Does not own | The business state of other modules. Workflows call module APIs and never write module tables. Module invariants (MM-11). |
| Operations | Relay the outbox to SQS; deduplicate in the inbox; route events; run workflows; process approvals; run scheduled jobs; replay dead letters (audited). |
| Exposes | Internal: publish and subscribe interface. `/v1/workflows`, `/v1/approvals` (approve or reject), `/v1/scheduled-tasks`. |
| Publishes | `workflow.instance.started/completed/failed`, `workflow.approval.requested/approved/rejected` |
| Consumes | All domain events, for routing and workflow triggers |
| Depends on | Outbox writer, relay and inbox: the P1 tenant context and the P7 audit writer. Workflow and approval APIs: also P2 (§7.1). AWS SQS. |
| Permissions / audit | `workflow:approval:decide` (scoped per approval type), `workflow:definition:manage`. Dead-letter replays are audited. |
| External | — |
| Order | Tier 0 |

#### P4 Integration Hub
| Field | Specification |
|---|---|
| Purpose | The only path to external systems. Runs the connector lifecycle (D-012). |
| Responsibilities (Blueprint) | API Connectors; Webhooks; Data Mapping & Transformation; Retry / Idempotency; Sync & Reconciliation; Integration Logs & Health. |
| Owns | `ConnectorCatalogueEntry` (per region), `ConnectorInstance` (with an explicit scope, organization-level or property-level: Q-16 direction set by founder review; credential ownership U-018), credential **references** (secrets in AWS Secrets Manager), `WebhookReceipt` (raw payload, unchanged), integration logs, sync checkpoints. |
| Does not own | Business data from providers once it is mapped into the owning module (for example, reservations from OTAs belong to B2). |
| Operations | Eligibility check → configure → verify → activate (explicit and audited) → suspend → retire. Inbound webhooks: verify the signature, store, acknowledge, process in the background. Outbound calls: rate limiting, retries, circuit breakers. Scheduled reconciliation. |
| Exposes | Capability interfaces used by modules: distribution, payment, messaging, door lock, tax and e-invoicing, accounting export. `/v1/connectors`, `/v1/connector-instances`, `/v1/webhooks/{provider}` (inbound). |
| Publishes | `integration.connector.activated/suspended`, `integration.webhook.received` (typed per capability), `integration.sync.failed`, `integration.reconciliation.discrepancy_found` |
| Consumes | Commands from modules, through capability interfaces |
| Depends on | P1, P2, P3, P7, P8 |
| Permissions / audit | `integration:connector:configure`, `integration:connector:activate` (separate from configure). **Credentials are never logged.** |
| External | Every External Ecosystem group (U-007 for exact mappings) |
| Order | Tier 1 (framework); individual connectors arrive with their modules |

#### P5 Document Management
| Field | Specification |
|---|---|
| Purpose | Owns documents and files. |
| Responsibilities (Blueprint) | Guest IDs / Registration Cards; Invoices / Contracts; Templates & Digital Signatures; Storage & Versioning; Access Control. |
| Owns | `Document`, `DocumentVersion`, `DocumentTemplate`, `SignatureRecord`, retention and classification metadata. Files are stored in S3 (see the protection model below the table). |
| Does not own | The business meaning of a document. Invoice data belongs to F2 and contract terms to the owning module; P5 stores the file and its metadata. |
| Operations | Upload, version, classify, retrieve with an authorization check, render from a template, record a signature, apply retention. |
| Exposes | `/v1/documents`, `/v1/document-templates`. Downloads are either streamed by P5 or delivered as presigned URLs, only under the rules below the table. |
| Publishes | `document.uploaded`, `document.version_created`, `document.signed`, `document.retention_expired` |
| Consumes | Retention policy changes from P8 |
| Depends on | P1, P2, P7, P8; AWS S3 and KMS |
| Permissions / audit | `document:{class}:read/write`. **Every read of a guest ID document is audited.** |
| External | Digital signature provider (**Q-17: not specified**) |
| Order | Tier 1 |

**P5 protection model for sensitive documents (proposed; finalized in the security and audit specification):**
- **Classification.** The workflow that uploads a document gives it a class (for example: identity document, financial, contract, general). The class drives encryption, access and retention.
- **Encryption.** Every object is encrypted at rest with KMS keys for its cell. Sensitive classes, such as guest ID documents, use a **separate key** that only the P5 service role may use to decrypt. No person and no other module's role has direct decrypt rights.
- **No direct storage access.** Buckets are private, with public access blocked. Other modules, AI agents (G6) and the Control Plane (D-020) never read storage directly. Every access goes through P5's API.
- **Downloads: presigned URLs or streaming.**
  - **What a presigned URL is.** A presigned S3 URL gives **direct access to the object for anyone who holds the URL, until it expires**. Holding the URL is the authorization; P5 isn't involved again during that time. Presigned URLs are therefore allowed only under the conditions below.
  - **Authorization before issuing.** P5 issues a URL only after all of these succeed:
    1. The caller is authenticated, and the context is trusted (§7.1).
    2. The caller has permission for the document's class within its tenant and property scope.
    3. P5's own metadata confirms the document belongs to that tenant. The object key is never taken from the client.
    4. The document is not deleted or past its retention period.
  - **Scope.** One object, read-only, for the exact key; no prefixes or wildcards. Response headers force a download (`Content-Disposition: attachment`) and turn off caching (`Cache-Control: no-store`).
  - **Maximum lifetime.** Proposed: **5 minutes**, finalized in the security and audit specification. The URL is signed with P5's short-lived role credentials, so it can't outlive them.
  - **Protection against leaks.**
    - The URL is returned only in an authenticated API response over TLS.
    - It is never stored, never placed in emails, messages or notifications, and never logged in full (the signature is redacted).
    - Pages that show it use `Referrer-Policy: no-referrer`.
    - Object keys are opaque and can't be guessed.
  - **Audit.**
    - Every issued URL is audited: actor, document ID, class, expiry and, where required, purpose.
    - S3 access logging at the object level is recommended for sensitive buckets, subject to cost approval (D-025).
  - **When P5 streams the file instead** (P5 authorizes every request and the content passes through P5's API, so no bearer URL ever exists):
    - for **sensitive classes**, such as guest ID documents;
    - for any request where the content must be redacted or transformed;
    - when the caller is a machine identity or an AI agent.
  - **Presigned URLs are used only** for non-sensitive classes, requested by authenticated hotel employees or guests within their own scope.
  - **Tenant isolation.** The KMS encryption context includes the tenant and property IDs, so decryption needs the matching context. Buckets deny public access and requests without TLS. Classification controls are never relaxed for convenience.
- **Audit.** Every read or download of a sensitive document is audited with the actor, the document ID and the time. The document's contents are never copied into the audit record (§1.1).
- **Retention.** Retention and deletion follow jurisdiction configuration (P8, D-012). Deletion is audited.

#### P6 Observability & Monitoring
| Field | Specification |
|---|---|
| Purpose | Technical health of the cell (not business reporting). |
| Responsibilities (Blueprint) | Application / API Health; Database / Queue / Workers; Integration Health; Logs / Metrics / Traces; Alerts & Incident Management. |
| Owns | Telemetry (logs, metrics, traces), alert rules, incident records. |
| Does not own | Audit records (P7); business reports (M9). |
| Operations | Collect telemetry (OpenTelemetry); scrub personal data from logs; alert; track incidents; export aggregated health to C5. |
| Exposes | Health endpoints; an aggregated, allowlisted telemetry feed to the Control Plane (D-020). |
| Publishes | `ops.incident.opened/resolved` (internal) |
| Consumes | Integration health from P4 |
| Depends on | AWS CloudWatch |
| Permissions / audit | Leptron operations roles only. **By default, hotel staff have no access to internal infrastructure telemetry** (Q-18, founder review). Any future hotel-facing operational health view needs its own design and permissions. |
| External | — |
| Order | Tier 0 (baseline) |

#### P7 Security & Compliance
| Field | Specification |
|---|---|
| Purpose | Audit, encryption, regulatory controls, data protection **for the cell**. The Control Plane has its own audit capability (§1.2). |
| Responsibilities (Blueprint) | Data Encryption; Audit Logs; GDPR / Local Laws; Backup & Disaster Recovery; Vulnerability Management. |
| Owns | `AuditRecord` (append-only, hash-chained; payloads follow §1.1 redaction and field-level access), the audit writer kernel (§7.1), the **system security log** of `SecurityEvent` records for denials that happen before tenant context exists (not tenant-scoped, §7.2) and its security-event writer, data-protection requests (access, erasure), retention policies (values come from P8's regional configuration), key-management policy. |
| Does not own | Hotel physical security (O5); identities (P2). |
| Operations | Append and verify audit records; handle data-subject requests, balancing erasure against financial retention (D-012); restore drills. |
| Exposes | Internal audit-write interface (used by every module); `/v1/audit` (filtered read); `/v1/data-requests`. |
| Publishes | `compliance.data_request.received/completed`, `compliance.audit.integrity_violation` |
| Consumes | All state-change audit writes (an interface, not events, so writes happen in the same transaction) |
| Depends on | Audit writer: the P1 tenant context and the request's correlation and actor context only, **not P2** (§7.1). Audit read and data-request APIs: P2. AWS KMS. |
| Permissions / audit | `audit:read` (scoped; sensitive fields also need permission on the underlying data, §1.1); `compliance:data_request:process`. Audit records can't be modified by anyone. Reads of sensitive audit fields are audited. |
| External | Government / Compliance group, where a regulatory submission applies (Q-19) |
| Order | Tier 0 |

#### P8 Configuration & Settings
| Field | Specification |
|---|---|
| Purpose | Organization and property configuration, including the regional template lifecycle (D-012). |
| Responsibilities (Blueprint) | Property Configuration; System Settings; Feature Flags; Localization (Multi-language); Theme & Branding. |
| Owns | `RegionalTemplate` + `TemplateVersion` (immutable once published); `PropertyConfiguration` (effective-dated); organization policies (within platform boundaries, D-012); localization resources; branding; effective feature-flag values (MM-15). |
| Does not own | Tax rule logic (F6, MM-16); room and rate data (B1); credentials (P4). |
| Operations | Validate, provision, activate and change configuration under control (D-012), with an audit history. Resolve effective settings for the organization and property. |
| Exposes | Internal settings-resolution interface; `/v1/configuration`, `/v1/regional-templates` (read in the cell). The path by which Leptron publishes templates to cells is defined in the Control Plane–cell contract specification. Leptron employees do not write directly in the cell (§1.2). |
| Publishes | `config.property.activated`, `config.property.changed` (with effective date), `config.template_version.published` |
| Consumes | `tenant.property.provisioned` |
| Depends on | P1, P2, P7 |
| Permissions / audit | `config:property:change`. Before and after values, template version and reason are always recorded (D-012). |
| External | — |
| Order | Tier 0 |

### 5.2 Leptron Control Plane (separate application and database, D-014; allowlisted data only, D-020)

#### C1 Customer Management
| Field | Specification |
|---|---|
| Purpose | Leptron's record of customer organizations. |
| Responsibilities (Blueprint) | Organizations; Contracts; third item unresolved (U-004). |
| Owns | `CustomerOrganization` (allowlisted fields), `CustomerContact` (business contacts only), customer contract metadata. |
| Does not own | Any hotel operational or guest data (D-020). |
| Operations | Onboard an organization; manage contacts; track contract status. |
| Exposes | Control Plane admin API and UI (Leptron realm only). |
| Publishes | `cp.customer.created/updated` (internal to the Control Plane) |
| Consumes | — |
| Depends on | Control Plane identity and audit capabilities (§1.2) |
| Permissions / audit | `cp:customer:manage` (a Control Plane permission, §1.2). Changes are recorded in the Control Plane audit capability (Q-20). |
| External | — |
| Order | Tier 0 (minimal) |

#### C2 Property Management (Control Plane)
| Field | Specification |
|---|---|
| Purpose | The property registry, plus orchestration of the D-012 provisioning workflow. |
| Responsibilities (Blueprint) | Properties; Provisioning; remaining items unresolved (U-003). |
| Owns | `PropertyRegistration` (country, jurisdiction, cell ID, template version, lifecycle status), `ProvisioningRequest`, the routing directory entries. |
| Does not own | The cell's operational property record (P1) or active configuration (P8) (MM-14). |
| Operations | The 8-step D-012 workflow: create, select country and jurisdiction, propose template, review, validate, provision through the cell API (idempotent), activate, list eligible integrations. |
| Exposes | Control Plane admin API; read-only directory (property ID → cell host). |
| Publishes | `cp.property.provisioning_requested/completed/failed` |
| Consumes | Provisioning results from cells |
| Depends on | C1, cell Provisioning API (P1, P8) |
| Permissions / audit | `cp:property:provision`. Every provisioning step is audited in the Control Plane audit capability, and the cell audits the steps it carries out (P7), linked by a correlation ID. |
| External | — |
| Order | Tier 0 (minimal) |

#### C3 Subscription & Licensing
| Field | Specification |
|---|---|
| Purpose | Leptron plans and commercial entitlements (D-013, requirement 8). |
| Responsibilities (Blueprint) | Plans & Modules; Subscriptions; Usage Tracking. |
| Owns | `Plan`, `Subscription`, `Entitlement` (kept separate from capacity targets and safeguards, D-013). |
| Does not own | Infrastructure capacity (P6, C9). |
| Operations | Assign a plan; change entitlements; push entitlements to cells (cells cache them). |
| Exposes | Control Plane API; entitlement feed to cells. |
| Publishes | `cp.entitlement.changed` |
| Consumes | Usage aggregates (C8) |
| Depends on | C1, C2 |
| Permissions / audit | `cp:subscription:manage` |
| External | — |
| Order | Tier 3. **Entitlement model U-022 is open.** |

#### C4 Billing & Invoicing (SaaS)
| Field | Specification |
|---|---|
| Purpose | Leptron's billing of its customers (D-009). **Separate from F2.** |
| Responsibilities (Blueprint) | Invoices; Payments; Outstanding. |
| Owns | `SaasInvoice`, `SaasPayment`, outstanding balances. |
| Does not own | Hotel billing (F2). |
| Operations | Generate invoices from subscriptions and usage; record payments; track outstanding balances. |
| Exposes | Control Plane API |
| Publishes | `cp.saas_invoice.issued`, `cp.saas_payment.received` |
| Consumes | `cp.entitlement.changed`, usage |
| Depends on | C1, C3 |
| Permissions / audit | `cp:billing:manage` |
| External | Leptron's own payment provider and accounting system (**Q-21: not specified**) |
| Order | Tier 4 |

#### C5 Platform Health · C6 Support & Diagnostics · C7 Deployments & Versions · C8 Usage & Analytics · C9 Resource Monitoring & Business Insights
| Field | C5 | C6 | C7 | C8 | C9 |
|---|---|---|---|---|---|
| Purpose | Health across all cells | Customer support | Releases across cells | Customer usage | Capacity and business insight for Leptron |
| Blueprint | System Uptime; Service Health; Error Tracking | User Diagnostics; Log Inspection; Remote Support (Controlled) | Release Management; Version Tracking; Feature Flags | Customer Usage; Module Adoption; third item U-005 | Resource Monitoring; Business Insights |
| Owns | Aggregated health status | `SupportCase`, `SupportAccessGrant` (time-limited) | `Release`, `CellVersion`, flag definitions and rollout plans (MM-15) | Aggregated usage | Capacity indicators (D-013), insight reports |
| Does not own | Raw cell telemetry (P6) | Cell data; support sessions run **inside the cell**, audited (D-020) | Effective flag values inside a cell (P8) | Raw activity data | Commercial entitlements (C3) |
| Operations | Aggregate health; record uptime | Grant controlled access; look at logs with personal data scrubbed | Canary-then-wave rollout; track versions | Aggregate and report usage | Compare capacity against targets (U-021); trigger scaling reviews |
| Exposes | Control Plane UI and API | Control Plane UI and API; access grant passed to the cell | Deployment pipeline integration | Control Plane UI and API | Control Plane UI and API |
| Publishes | `cp.health.degraded` | `cp.support_access.granted/revoked` | `cp.release.rolled_out` | — | `cp.capacity.threshold_reached` |
| Consumes | P6 feed | — | — | Allowlisted telemetry | P6 feed, C8 |
| Depends on | P6 (aggregated feed) | Control Plane identity and audit; in the cell, P2 (time-limited grant) and P7 (cell audit) | GitHub Actions (D-023) | Telemetry API | C5, C8 |
| Permissions / audit | Leptron operations | **Granting access is approved and audited, both in the Control Plane and in the cell** | `cp:release:deploy` | Leptron roles | Leptron roles |
| Order | 2 | 3 | 2 | 4 | 4 |

### 5.3 Core engines

#### B1 Inventory & Rate Engine
| Field | Specification |
|---|---|
| Purpose | **Owns room inventory** and the rates that apply to it (D-010). |
| Responsibilities (Blueprint) | Room Inventory by Room Type; Rate Plans & Restrictions; Availability & Calculation; Min/Max Stay, CTA, Stop Sell; Yield Rules; Derived Inventory. |
| Owns | Three distinct concepts (MM-02):<br>• `Room`: physical room identity (number, location), which rarely changes;<br>• `RoomType`: the category that is sold;<br>• `InventoryAllocation`: the sellable count by date and room type, net of holds and maintenance blocks.<br>Also `InventoryHold`, `RatePlan`, `Rate` (by date), `Restriction` (min/max stay, CTA, stop sell), `YieldRule`, derived-inventory rules. |
| Does not own | Reservations (B2: B1 holds only an opaque reservation reference on each hold); room housekeeping status (O2); maintenance blocks (O3, consumed as availability input); pricing recommendations (M4); physical stock (M2). |
| Operations | Calculate availability. Place, commit, release, expire and return **inventory holds**, following the hold state machine (§6.1). Each transition is a single conditional update in B1's own transaction, idempotent by hold ID. `committed`, `released` and `expired` exclude each other, and a commit after expiry fails. B1 is the only place sellable inventory is reduced, which is what prevents overbooking. Maintain rates and restrictions; apply yield rules. |
| Exposes | `/v1/room-types`, `/v1/rooms`, `/v1/availability` (search), `/v1/rate-plans`, `/v1/rates`, `/v1/restrictions`; internal hold interface for B2 (place, commit, release, return). |
| Publishes | `inventory.availability.changed`, `inventory.hold.placed/committed/released/expired/returned`, `rate.rate.changed`, `rate.restriction.changed`, `inventory.room.created/updated` |
| Consumes | • **From B2: no reservation events and no reservation data.** B2 calls B1's internal hold interface (place, commit, release, return) with a hold ID, a reservation reference and the stay details (room type, dates, quantity). B1 stores only the hold and that reference as an opaque ID, never reservation content, so the reservation lifecycle stays with B2 (MM-03).<br>• **From O3:** `maintenance.room_block.created/released` (from Tier 4).<br>• **Optional later extension (Tier 6):** accepted M4 recommendations, received as ordinary rate and restriction changes through B1's API (MM-01). |
| Depends on | P1, P3, P8. **B1 works fully on its own, without M4 or O3.** Rates and restrictions are maintained directly through its API until M4 exists. |
| Permissions / audit | `inventory:rate:write`, `inventory:restriction:write`. Rate changes record their source (user, revenue recommendation or AI agent). |
| External | Through B4 only (OTA/GDS) |
| Order | Tier 2 |

#### B2 Reservations Engine
| Field | Specification |
|---|---|
| Purpose | **Owns the reservation lifecycle.** |
| Responsibilities (Blueprint) | Create/Modify/Cancel Reservation; Walk-in / Online / OTA / GDS; Group / Corporate / Package; Rate Plan & Policies; Deposit / Guarantee; Confirmation. |
| Owns | `Reservation` (status includes pending, confirmed, in-house, checked out, cancelled, no-show, failed and requires_review: MM-03; pending, failed and requires_review are used by §6.1; confirmed only after B1 has committed the hold), the state of each reservation process (§6.1), `ReservationRoom` (room type and assigned room: MM-04), `GroupBlock`, `ReservationPolicy` (cancellation and guarantee terms as applied), source and channel attribution, add-on lines (Q-03). |
| Does not own | Guest profile (B3, referenced by ID); inventory (B1); payments (M5); folio charges (F1). |
| Operations | Create, modify and cancel reservations by **orchestrating** B1 holds and, where required, M5 payments. This runs as a recoverable process with compensating actions, **not a shared transaction** (§6.1). Also: group and corporate bookings; record guarantee status; confirm; check in and check out (started from O1); assign rooms. |
| Exposes | `/v1/reservations`, `/v1/reservations/{id}/check-in`, `/check-out`, `/room-assignment`, `/v1/group-blocks` |
| Publishes | `reservation.created/modified/cancelled/confirmed`, `reservation.checked_in/checked_out`, `reservation.no_show`, `reservation.room_assigned` |
| Consumes | `integration.webhook.received` (OTA/GDS reservations via B4), `inventory.hold.expired`, `payment.*` (guarantee satisfied; from Tier 3), `crm.guest.merged` |
| Depends on | B1, B3, P3. M5 from Tier 3, for deposits and guarantees; booking flows that need a payment are not offered until then. |
| Permissions / audit | `reservation:create/modify/cancel`, `reservation:override_policy` (stricter; may need approval) |
| External | Through B4 (OTA, GDS) and the direct booking channels |
| Order | Tier 2 |

#### B3 CRM & Guest Profile
| Field | Specification |
|---|---|
| Purpose | **Owns guest profiles.** |
| Responsibilities (Blueprint) | Guest 360° View; Stay History; Preferences; Requests; Communication History; Loyalty Profile; Corporate Profile. |
| Owns | • `GuestProfile`.<br>• `GuestPreference`, including **channel preferences**: what the guest *prefers*, such as channel and language.<br>• `ConsentRecord`, the **authoritative** record of what the guest has *permitted*, per purpose and channel, with source, time and jurisdiction basis.<br>• `GuestRequest` (Q-04), `CorporateProfile`, and duplicate-matching and merge records (Q-07). |
| Does not own | Stay history (a read copy from B2 events); communication history (B5, viewed); loyalty membership (M6, viewed: MM-07); corporate credit (F3). |
| Operations | Create profiles from bookings (basic profile creation does not wait for Q-07); record and withdraw consent; manage preferences; maintain corporate profiles; assemble the 360° view from read copies. **Merging duplicate profiles is built only after its contract is defined (Q-07).** |
| Exposes | `/v1/guests`, `/v1/guests/{id}/360`, `/v1/guests/{id}/consents`, `/v1/corporate-profiles`; internal consent-check interface used by B5 |
| Publishes | `crm.guest.created/updated/merged`, `crm.consent.changed`, `crm.corporate_profile.updated` |
| Consumes | `reservation.*`, `communication.message.sent`, `loyalty.*`, `reputation.review.received` (to build read copies) |
| Depends on | P1, P2, P3 |
| Permissions / audit | `crm:guest:read` (personal data), `crm:guest:merge`. **Reads of guest personal data are audited** where a jurisdiction requires it (P8). |
| External | Other Integrations: CRM (external CRM sync, Q-08) |
| Order | Tier 2 |

#### B4 Channel Manager
| Field | Specification |
|---|---|
| Purpose | Synchronizes inventory, rates and reservations with distribution channels. |
| Responsibilities (Blueprint) | Inventory Sync (Push/Pull); Rate Sync; Availability Sync; Reservation Import; Mapping (Rate Plan / Room Type); Modifications & Cancellations; Overbooking Protection; Error Handling & Alerts. |
| Owns | `ChannelMapping` (HOS room type and rate plan to the channel's codes), sync state, sync errors. |
| Does not own | Availability or rates (B1); reservations (B2). Overbooking protection **enforces B1's availability** and never keeps its own count. |
| Operations | Push availability, rates and restrictions on B1 events; import channel reservations, modifications and cancellations into B2 (idempotent by channel reservation ID); report errors. |
| Exposes | `/v1/channel-mappings`, `/v1/channel-sync/status` |
| Publishes | `channel.sync.failed`, `channel.reservation.imported` |
| Consumes | `inventory.availability.changed`, `rate.*`, `reservation.*` (delivery acknowledgements) |
| Depends on | B1, B2, P4 |
| Permissions / audit | `channel:mapping:manage` |
| External | OTAs, GDS (**direct or through an aggregator: open**) |
| Order | Tier 4. **Blocked by the OTA connectivity decision.** |

#### B5 Communication Engine
| Field | Specification |
|---|---|
| Purpose | **Owns communications.** |
| Responsibilities (Blueprint) | Trigger Based Communication; Templates; Multi Channel (Email/SMS/WhatsApp/Push/Voice); Events (Booking, Pre-arrival, Check-in, etc.); Notifications & Alerts. |
| Owns | `MessageTemplate` (localized, D-012), `CommunicationTrigger`, `Message` (with delivery status), conversations including guest-app chat (founder review, Q-14), and property channel configuration (which channels are enabled, and their fallback order). |
| Does not own | Campaign targeting (M7); guest profiles, guest channel preferences and **consent records** (B3). |
| Operations | **Before every send, check the applicable consent with B3.** The message's purpose decides which consent applies, and jurisdiction rules come from P8 (U-013). A send without the required consent is blocked. Also: render and send messages on triggers or requests from other modules; track delivery; send staff notifications; hold chat conversations. |
| Exposes | Internal send interface (used by M7, M8, B2 and others); `/v1/message-templates`, `/v1/communication-triggers`, `/v1/messages` (history) |
| Publishes | `communication.message.sent/delivered/failed` |
| Consumes | `reservation.*`, `folio.*`/`invoice.issued`, and other configured triggers |
| Depends on | B3, P4, P5, P8 |
| Permissions / audit | `communication:template:manage`, `communication:send:manual` |
| External | Communication Channels (Email, SMS, WhatsApp, Push, Voice) |
| Order | Tier 3 |

### 5.4 Property operations

#### O1 Front Desk Operations
| Field | Specification |
|---|---|
| Purpose | The staff workspace for arrivals, in-house guests and departures. **Mainly orchestration and views.** |
| Responsibilities (Blueprint) | Dashboards (Arrivals/Departures/In-house); Walk-in Management; Room Assignment / Moves / Upgrades; Early Check-in / Late Check-out; Guest Registration; Billing & Folio Management. |
| Owns | Registration records, if they are kept separately from P5 documents (Q-09); front desk shift context (Q-10). |
| Does not own | Reservations, room assignment or stay status (B2); folios (F1); room status (O2); guest profiles (B3). |
| Operations | Dashboards (read copies); walk-ins (B2 create); assign, move and upgrade rooms (B2); early or late changes (B2); registration (B3, P5); folio actions (through F1's API). |
| Exposes | Staff UI; composed read endpoints (`/v1/front-desk/arrivals`, `/departures`, `/in-house`) |
| Publishes | `frontdesk.registration.completed` (if Q-09 makes it a separate record) |
| Consumes | `reservation.*`, `housekeeping.room_status.changed`, `maintenance.room_block.*`, `folio.*` |
| Depends on | B1, B2, B3, F1, M5, O2, P5. **O5 is optional:** key issuance at check-in appears only when O5 and a door-lock connector are active. |
| Permissions / audit | Uses the owning modules' permissions; no extra powers |
| External | Hardware: Kiosk (Q-11), Door Lock (through O5) |
| Order | Tier 3 |

#### O2 Housekeeping Management
| Field | Specification |
|---|---|
| Purpose | **Owns room housekeeping status** (Property Operations, MM-05) and housekeeping work. |
| Responsibilities (Blueprint) | Room Status Tracking; Task Generation (Checkout / Stayover / Deep Clean); Staff Assignment; Cleaning in Progress / Completed; Inspection; Lost & Found; Linen & Amenities; Productivity Reports. |
| Owns | `RoomHousekeepingStatus`, `HousekeepingTask`, `Inspection`, `LostAndFoundItem`, linen and amenity **usage** records (stock belongs to M2). |
| Does not own | Occupancy and stay status (B2); maintenance blocks (O3); stock levels (M2). |
| Operations | Generate tasks from reservation events; assign staff; record progress, completion and inspection; change status; log lost-and-found items. |
| Exposes | `/v1/housekeeping/room-status`, `/v1/housekeeping/tasks`, `/v1/lost-and-found`; staff mobile UI (Q-12) |
| Publishes | `housekeeping.room_status.changed`, `housekeeping.task.completed`, `housekeeping.inspection.completed` |
| Consumes | `reservation.checked_out/checked_in`, `reservation.room_assigned`, `maintenance.room_block.*`, guest housekeeping requests (via O6) |
| Depends on | B2, P1 (departments), P2 |
| Permissions / audit | `housekeeping:task:assign`, `housekeeping:room_status:set`, `housekeeping:inspection:approve` |
| External | — |
| Order | Tier 3 |

#### O3 Maintenance Management
| Field | Specification |
|---|---|
| Purpose | Maintenance work and room blocks. |
| Responsibilities (Blueprint) | Issue Reporting; Work Order Creation; Priority & SLA; Technician Assignment; Parts / Materials; Work Completion; Room Blocking / Release; Preventive Maintenance. |
| Owns | `MaintenanceIssue`, `WorkOrder`, `RoomBlock` (out of order / out of service), preventive maintenance schedules, parts **requests and usage** (stock belongs to M2). |
| Does not own | Asset register (O4); availability (B1 consumes the blocks); stock (M2). |
| Operations | Report issue → work order → assign → complete; block and release rooms; schedule preventive work. |
| Exposes | `/v1/maintenance/issues`, `/v1/work-orders`, `/v1/room-blocks` |
| Publishes | `maintenance.work_order.created/completed`, `maintenance.room_block.created/released` |
| Consumes | `asset.*`, stock-issue confirmations from M2 |
| Depends on | O4 (required, and implemented first), B1, P3. M2 for Parts / Materials stock is an **extension added at Tier 5**; the Tier 4 release of O3 has no stock integration. |
| Permissions / audit | `maintenance:room_block:manage` (affects saleable inventory) |
| External | IoT Devices (Q-11) |
| Order | Tier 4 |

#### O4 Engineering Assets
| Field | Specification |
|---|---|
| Purpose | The register of physical assets. |
| Responsibilities (Blueprint) | Asset Register; Asset Location; Warranty / AMC; Asset History; Utilization Tracking. |
| Owns | `Asset`, `AssetLocation`, `WarrantyContract`, asset history (built from O3 events), utilization records. |
| Does not own | Work orders (O3). |
| Operations | Register assets; track location and warranties; record utilization. |
| Exposes | `/v1/assets` |
| Publishes | `asset.created/updated`, `asset.warranty.expiring` |
| Consumes | `maintenance.work_order.completed` |
| Depends on | P1, P5 (warranty documents) |
| Permissions / audit | `asset:manage` |
| External | IoT Devices (Q-11) |
| Order | Tier 4 |

#### O5 Security Management
| Field | Specification |
|---|---|
| Purpose | Hotel-side security operations. |
| Responsibilities (Blueprint) | User Access Control; Door Lock Integration; CCTV Integration; Audit Logs; Incident Management. |
| Owns | `SecurityIncident`, `KeyCredential` issuance records (door-lock keys, through P4), plus the CCTV link (**scope Q-13**). |
| Does not own | Software identities and permissions (P2, MM-06); the audit store (P7). O5's hotel-facing audit view shows **only security-relevant records for the user's own property**, filtered and redacted by P7 under O5 permissions (§1.1). **It gives no unrestricted access to the platform audit store.** |
| Operations | Issue and revoke door keys tied to the stay (B2 events); record incidents; view the audit trail. |
| Exposes | `/v1/security/incidents`, `/v1/keys` |
| Publishes | `security.key.issued/revoked`, `security.incident.opened/closed` |
| Consumes | `reservation.checked_in/checked_out`, `reservation.room_assigned` |
| Depends on | B2, P4, P7 |
| Permissions / audit | `security:key:issue`; every key issuance is audited |
| External | Hardware: Door Lock (vendor open); CCTV (Q-13) |
| Order | Tier 6 (door locks depend on vendor selection). Until then, check-in works without key issuance from HOS. |

#### O6 Guest Experience (Mobile App)
| Field | Specification |
|---|---|
| Purpose | **A guest-facing channel.** It brings other modules together and owns no business data. |
| Responsibilities (Blueprint) | Pre Check-in / Digital Check-in; Room Info & Hotel Info; Service Requests; F&B Ordering; Housekeeping Requests; Chat / Concierge; Bill Review & Docking (exact transcription; U-006 pending verification). |
| Owns | **Presentation only:** guest app sessions (guest realm, P2) and presentation state. **No authoritative business data or content.** |
| Does not own | Reservations (B2), documents (P5), orders (M1), folios (F1), requests (Q-05), chat conversations (B5), hotel and room information content (owner still open, Q-14). |
| Operations | Digital check-in (B2, P5, M5); view bill (F1); order food and drink (M1); submit requests; show hotel and room information (Q-14); chat through B5 (A1 AI Concierge where enabled). |
| Exposes | Guest-facing API layer (`/v1/guest/...`) that aggregates owning modules and enforces guest-realm scope (a guest sees only their own stay) |
| Publishes | — (owning modules publish) |
| Consumes | Read copies |
| Depends on | B2, B3, F1, M1, M5, O2, P5 |
| Permissions / audit | Guest realm. **Access is limited to the guest's own reservations.** |
| External | Push channels (via B5) |
| Order | Tier 5. **PWA or native is deferred.** |

### 5.5 Commercial, outlets and intelligence

#### M1 POS (F&B & Outlets)
| Field | Specification |
|---|---|
| Purpose | Selling in outlets: restaurant, bar, café and room service. |
| Responsibilities (Blueprint) | Outlets (Restaurant/Bar/Cafe/Room Service); Menu & Items; Order Taking; Kitchen / KOT; Billing & Payment; Room Posting; Shift & Cash Management; POS Reports. |
| Owns | `Outlet`, `MenuItem`, `Order`, `KitchenTicket`, `Check`, `Shift`, cash drawer records. |
| Does not own | Recipes and stock (M2, MM-09); folios (F1: room posting **posts to F1**); payments (M5); tax rules (F6). |
| Operations | Take orders, send tickets to the kitchen, settle checks (payment through M5, or room posting to F1), open and close shifts. |
| Exposes | `/v1/outlets`, `/v1/menu-items`, `/v1/orders`, `/v1/checks`, `/v1/shifts` |
| Publishes | `pos.order.placed`, `pos.check.settled`, `pos.check.posted_to_room`, `pos.shift.closed` |
| Consumes | `reservation.checked_in/checked_out` (whether room posting is allowed), stock availability from M2 (Q-22) |
| Depends on | F1, F6, M2, M5, B2 |
| Permissions / audit | `pos:check:void`, `pos:check:discount` (may need approval) |
| External | Hardware: POS devices (Q-11) |
| Order | Tier 5 |

#### M2 Inventory & Procurement
| Field | Specification |
|---|---|
| Purpose | **Physical stock and procurement inventory** (D-010). Separate from room inventory. |
| Responsibilities (Blueprint) | Items & Categories; Recipes & BOM (for F&B); Suppliers; Purchase Orders; Goods Receipt; Stock Transfers; Stock Adjustment; Consumption / Issue; Wastage; Low Stock Alerts. |
| Owns | `StockItem`, `Recipe`/`BOM`, `Supplier`, `PurchaseOrder`, `GoodsReceipt`, `StockMovement` (append-only), stock levels per location. |
| Does not own | Supplier bills and payments (F4); menu items (M1). |
| Operations | Purchase order → goods receipt → stock; transfers, adjustments, issues, wastage; reduce stock by recipe for POS sales (MM-09); low-stock alerts. |
| Exposes | `/v1/stock-items`, `/v1/suppliers`, `/v1/purchase-orders`, `/v1/goods-receipts`, `/v1/stock-movements` |
| Publishes | `stock.goods_received`, `stock.level.low`, `stock.movement.recorded` |
| Consumes | `pos.check.settled` (recipe-based consumption), issue requests from O2 and O3 |
| Depends on | P1, P3 |
| Permissions / audit | `stock:adjust` (audited with a reason), `procurement:po:approve` |
| External | — |
| Order | Tier 5 |

#### M3 Banquets & Events
| Field | Specification |
|---|---|
| Purpose | Event sales and delivery. |
| Responsibilities (Blueprint) | Leads / Enquiries; Event Spaces; Availability & Calendar; Proposals / Quotations; Contracts; Menu / Packages; Resources; Event Execution; Billing & Settlement. |
| Owns | `EventLead`, `EventSpace`, `EventBooking`, `Proposal`, event packages, resource allocations. |
| Does not own | Guest room inventory (B1; room blocks for events go through B2 group blocks, Q-23); contract files (P5); billing (F1/F2). |
| Operations | Lead → proposal → contract → event → settlement (charges posted to F1 or invoiced by F2). |
| Exposes | `/v1/event-leads`, `/v1/event-spaces`, `/v1/event-bookings`, `/v1/proposals` |
| Publishes | `event.booking.confirmed`, `event.booking.executed`, `event.charges.posted` |
| Consumes | `document.signed` |
| Depends on | B2, F1, F2, P5, B3 |
| Permissions / audit | `events:proposal:approve` |
| External | — |
| Order | Tier 5 |

#### M4 Revenue Management
| Field | Specification |
|---|---|
| Purpose | Forecasting and pricing intelligence. |
| Responsibilities (Blueprint) | Demand Forecasting; Competitor Rate Tracking; Dynamic Pricing; Rate Recommendations; Occupancy Based Pricing; ADR / RevPAR; Restrictions Management; Promotions. |
| Owns | `Forecast`, `CompetitorRate`, `PricingRecommendation`, pricing strategies, promotions (MM-01). |
| Does not own | Live rates and restrictions (B1, the only writer). Recommendations are applied **through B1's API** (MM-01). KPI definitions (M9); M4 uses the agreed, versioned definitions (MM-10). |
| Operations | Forecast; collect competitor rates; recommend; apply recommendations through B1 (automatically or after approval, Q-24). |
| Exposes | `/v1/revenue/forecasts`, `/v1/revenue/recommendations` (accept or reject) |
| Publishes | `revenue.recommendation.created/accepted/rejected` |
| Consumes | `reservation.*`, `inventory.availability.changed`, `rate.*` |
| Depends on | B1, B2, P4 |
| Permissions / audit | `revenue:recommendation:apply` |
| External | Competitor rate data source (**Q-25: not specified**) |
| Order | Tier 6 |

#### M5 Payment Management
| Field | Specification |
|---|---|
| Purpose | **Owns the payment lifecycle** (D-011, D-022). |
| Responsibilities (Blueprint) | Payment Gateway Integration; Multi Currency; Payments (Online/Offline); Refunds; Payment Reconciliation; Tokenization / Security; Payment Logs. |
| Owns | `PaymentIntent`, `Payment` (authorize, capture, void), `Refund`, `PaymentMethodToken` (**provider token reference only**), settlement records, payment logs. |
| Does not own | Folio balances (F1); receivables (F3); ledger (F5). **Never stores raw card numbers (D-022).** |
| Operations | Online payments (hosted fields or redirect); offline payments (cash and others); refunds; reconciliation of gateway settlements; currency handling (U-014). |
| Exposes | `/v1/payments`, `/v1/refunds`, `/v1/payment-methods`; internal interface for B2, F1, M1 and O6 |
| Publishes | `payment.authorized/captured/failed/refunded`, `payment.settlement.reconciled`, `payment.reconciliation.discrepancy_found` |
| Consumes | Gateway webhooks (via P4) |
| Depends on | P4 (D-011 contract, U-008), P7 |
| Permissions / audit | `payment:refund` (may need approval), `payment:offline:record` |
| External | Payment Gateways (launch gateways **open**) |
| Order | Tier 3 |

#### M6 Loyalty Management
| Field | Specification |
|---|---|
| Purpose | Loyalty programme. |
| Responsibilities (Blueprint) | Membership & Tiers; Points Accrual; Redemption; Benefits; Expiry Management. |
| Owns | `LoyaltyMember`, `Tier`, `PointsLedgerEntry` (append-only), `Benefit`, expiry rules. |
| Does not own | Guest profile (B3 shows a read copy, MM-07). How redemption is treated financially is defined with F1 and F5 (Q-26). |
| Operations | Enrol; accrue points on qualifying events; redeem; expire points. |
| Exposes | `/v1/loyalty/members`, `/v1/loyalty/redemptions` |
| Publishes | `loyalty.points.accrued/redeemed/expired`, `loyalty.tier.changed` |
| Consumes | `reservation.checked_out`, `folio.closed` (qualifying spend, Q-26) |
| Depends on | B3, F1 |
| Permissions / audit | `loyalty:points:adjust` (audited with a reason) |
| External | — |
| Order | Tier 6 |

#### M7 Marketing & Campaigns
| Field | Specification |
|---|---|
| Purpose | Segmentation and campaigns. |
| Responsibilities (Blueprint) | Segmentation; Campaign Creation; Multi Channel Send; Performance Tracking; Conversion to Booking. |
| Owns | `Segment`, `Campaign`, campaign performance and attribution records. |
| Does not own | Sending messages (B5, MM-08); consent records (B3). |
| Operations | Build segments from B3 data; create campaigns; send through B5; attribute bookings from B2 events. |
| Exposes | `/v1/segments`, `/v1/campaigns` |
| Publishes | `campaign.launched/completed` |
| Consumes | `communication.message.*`, `reservation.created` (attribution) |
| Depends on | B3, B5, B2 |
| Permissions / audit | `marketing:campaign:launch` |
| External | Via B5 channels |
| Order | Tier 6 |

#### M8 Reputation Management
| Field | Specification |
|---|---|
| Purpose | Guest reviews and service recovery. |
| Responsibilities (Blueprint) | Review Aggregation; Sentiment Analysis; Issue Alerts; Resolution Tracking; Guest Recovery. |
| Owns | `Review`, `SentimentResult`, `ReputationIssue` (resolution tracking). |
| Does not own | Guest profile (B3); messages (B5). |
| Operations | Collect reviews; analyse sentiment; alert staff; track resolution and recovery. |
| Exposes | `/v1/reviews`, `/v1/reputation/issues` |
| Publishes | `reputation.review.received`, `reputation.issue.opened/resolved` |
| Consumes | Feedback triggered by `reservation.checked_out` |
| Depends on | B3, B5, P4 |
| Permissions / audit | `reputation:review:respond` |
| External | Review sources (**Q-27: not specified**) |
| Order | Tier 6 |

#### M9 Reports & Analytics (BI)
| Field | Specification |
|---|---|
| Purpose | Reporting. **It is not a source of truth for any business data** (MM-10). |
| Responsibilities (Blueprint) | Property Dashboard; Occupancy / ADR / RevPAR; Revenue Reports; F&B Reports; Housekeeping Reports; Maintenance Reports; Inventory Reports; Guest Reports; Custom Reports; final item U-002. |
| Owns | KPI catalogue, KPI definitions and their versions (MM-10); `ReportDefinition`, `Dashboard`, analytical read models built from events. Source modules own the underlying business facts. |
| Does not own | Source data. Financial reports must agree with F5. |
| Operations | Build read models; run reports in the background; schedule reports. |
| Exposes | `/v1/reports`, `/v1/dashboards` |
| Publishes | `report.generated` |
| Consumes | Domain events from all modules (read-only) |
| Depends on | Only the source modules a given report covers. Initial reporting (Tier 3) uses the modules that exist by then; reports for later modules arrive with those modules. **No future module is a prerequisite for initial reporting.** |
| Permissions / audit | **Report access follows the permissions on the underlying data** (no back door to guest or financial data) |
| External | Other Integrations: BI Tools (export, Q-08) |
| Order | Tier 3 onward, alongside each module |

### 5.6 Finance & Accounting (D-007: explicit contracts; finance keeps ownership)

#### F1 Folio Management
| Field | Specification |
|---|---|
| Purpose | **Owns folios and folio postings.** |
| Responsibilities (Blueprint) | Automatic Posting; Manual Posting; Adjustments; Transfer Posting; Folio Summary. |
| Owns | `Folio` (per reservation, guest or account, Q-28), `FolioPosting` (**append-only; corrected by reversal, never edited**), routing and transfer records. |
| Does not own | Payments (M5: recorded on the folio as payment postings, by reference); invoices (F2); tax rules (F6); journal entries (F5). |
| Operations | Automatic postings (room charges, POS, events); manual postings and adjustments (with permission); transfers; summary; close. |
| Exposes | Internal posting interface (idempotent, used by B2, M1, M3); `/v1/folios`, `/v1/folios/{id}/postings` |
| Publishes | `folio.posting.created`, `folio.posting.reversed`, `folio.transferred`, `folio.closed` |
| Consumes | `payment.captured/refunded`, `pos.check.posted_to_room`, `event.charges.posted`, `reservation.checked_in` (open folio) |
| Depends on | F6, M5, B2 |
| Permissions / audit | `folio:posting:manual`, `folio:posting:adjust` (may need approval), `folio:transfer`. **Postings are never deleted.** |
| External | — |
| Order | Tier 3. **Legal entity (U-015) and currency (U-014) questions affect it.** |

#### F2 Billing & Invoicing (hotel)
| Field | Specification |
|---|---|
| Purpose | Bills and invoices for the hotel (D-009). **Separate from C4.** |
| Responsibilities (Blueprint) | Bill Generation; Taxes & Charges; Discounts; Invoice Formats; E-Invoicing. |
| Owns | `Invoice`, `InvoiceLine`, invoice numbering sequences (per jurisdiction, U-015), credit notes (Q-29). |
| Does not own | Folio postings (F1); tax calculation (F6); the invoice file (P5). |
| Operations | Generate a bill or invoice from a folio or event account; apply discounts (with permission); format per jurisdiction (D-012); submit e-invoices through P4. |
| Exposes | `/v1/invoices` |
| Publishes | `invoice.issued`, `invoice.cancelled`, `invoice.e_invoice.accepted/rejected` |
| Consumes | `folio.closed` |
| Depends on | F1, F6, P4, P5, P8 |
| Permissions / audit | `invoice:issue`, `invoice:cancel` (restricted). **An issued invoice is never changed.** |
| External | Government / Compliance: e-Filing / e-invoicing (per jurisdiction) |
| Order | Tier 3 |

#### F3 Accounts Receivable
| Field | Specification |
|---|---|
| Purpose | Amounts owed to the hotel. |
| Responsibilities (Blueprint) | Credit Management; Receivables; Statements; Payment Follow-up; Aging Analysis. |
| Owns | `ReceivableAccount` (such as corporate accounts), credit limits, statements. |
| Does not own | Corporate profile (B3); payments (M5). |
| Operations | Transfer balances from folios (city ledger); manage credit; issue statements; follow up; aging analysis. |
| Exposes | `/v1/receivables` |
| Publishes | `ar.receivable.created`, `ar.payment.applied` |
| Consumes | `folio.transferred` (to AR), `payment.captured`, `invoice.issued` |
| Depends on | F1, F2, M5, B3 |
| Permissions / audit | `ar:credit_limit:set` |
| External | — |
| Order | Tier 4 |

#### F4 Accounts Payable
| Field | Specification |
|---|---|
| Purpose | Amounts the hotel owes. |
| Responsibilities (Blueprint) | Supplier Bills; Approvals; Payments; Aging Analysis; Reconciliation. |
| Owns | `SupplierBill`, supplier payment records. |
| Does not own | Suppliers and purchase orders (M2); approval workflow execution (P3). |
| Operations | Record bills, matched to M2 receipts (Q-30); approve through P3; pay; age; reconcile. |
| Exposes | `/v1/supplier-bills` |
| Publishes | `ap.bill.approved`, `ap.bill.paid` |
| Consumes | `stock.goods_received`, `workflow.approval.*` |
| Depends on | M2, P3 |
| Permissions / audit | `ap:bill:approve` (separation of duties, Q-15) |
| External | — |
| Order | Tier 5 |

#### F5 General Ledger
| Field | Specification |
|---|---|
| Purpose | The books of account. |
| Responsibilities (Blueprint) | Chart of Accounts; Journal Entries; Reconciliations; Period Closing; Financial Statements. |
| Owns | `Account` (chart of accounts), `JournalEntry` (**balanced and append-only**), `AccountingPeriod`, posting rules that map business events to journal entries. |
| Does not own | Source transactions (F1, F3, F4, F7, F8, M5). |
| Operations | Create journal entries from finance events (idempotent); reconcile; close periods (no posting into closed periods); produce financial statements. |
| Exposes | `/v1/gl/accounts`, `/v1/gl/journal-entries`, `/v1/gl/periods` |
| Publishes | `gl.period.closed` |
| Consumes | Initial scope: `folio.*`, `invoice.*`, `ar.*`, `payment.*`. Extensions: `ap.*`, payroll and expense events. |
| Depends on | **Initial scope (Tier 4):** F1, F2, F3, F6, M5. **Later extensions:** F4 (Tier 5), F7 and F8 (Tier 6), each adding its posting rules when it ships. |
| Permissions / audit | `gl:period:close`, `gl:journal:manual` (restricted) |
| External | Other Integrations: Accounting / ERP export (Q-08) |
| Order | Tier 4, initial scope: chart of accounts; journal entries from the initial sources; reconciliation; period closing; financial statements. **Legal entity (U-015) and currency (U-014) block the design.** |

#### F6 Tax Management
| Field | Specification |
|---|---|
| Purpose | Tax rules and calculation. |
| Responsibilities (Blueprint) | GST / VAT / Other Taxes; Tax Mapping; Tax Calculation; Returns; Compliance. |
| Owns | Operational tax rules (MM-16): `TaxRule` with jurisdiction, source, effective date and version; `TaxMapping` (charge type to tax); tax calculation records; return data. |
| Does not own | The regional template lifecycle (P8), which supplies the initial regional configuration at provisioning (MM-16). **A regional template is not a substitute for legal validation** (U-013). Tax registrations: U-015. |
| Operations | Calculate tax for postings, checks and invoices; keep historical rates (D-012); prepare returns. |
| Exposes | Internal calculation interface; `/v1/tax/rules`, `/v1/tax/returns` |
| Publishes | `tax.rule.changed` |
| Consumes | `config.property.activated/changed` |
| Depends on | P8 |
| Permissions / audit | `tax:rule:change` (effective-dated; never applied retroactively to posted records). Every change records jurisdiction, source, effective date, version and actor. |
| External | Government / Compliance (filing) |
| Order | Tier 3. **Template content: U-013.** |

#### F7 Payroll Management
| Field | Specification |
|---|---|
| Purpose | Payroll. |
| Responsibilities (Blueprint) | Employee Master; Attendance; Salary Structure; Payroll Processing; Payslips / Reports. |
| Owns | `Employee` (HR and payroll record, **separate from the P2 user**, MM-13), attendance, salary structures, payroll runs, payslips (stored in P5). |
| Does not own | System login (P2). |
| Operations | Attendance → payroll run → payslips → journal entries in F5. |
| Exposes | `/v1/employees`, `/v1/payroll-runs` |
| Publishes | `payroll.run.finalized` |
| Consumes | — |
| Depends on | P2 (link), P5, F5 |
| Permissions / audit | `payroll:run:finalize`. **Salary data is highly sensitive.** Audit records refer to salary records without copying the amounts (§1.1). |
| External | Other Integrations: HRMS (Q-08) |
| Order | Tier 6 |

#### F8 Expense Management
| Field | Specification |
|---|---|
| Purpose | Staff expense claims. |
| Responsibilities (Blueprint) | Expense Claims; Approvals; Reimbursements; Expense Reports. |
| Owns | `ExpenseClaim`, reimbursement records. |
| Does not own | Approval execution (P3); receipts (P5). |
| Operations | Claim → approve (P3) → reimburse → journal entries in F5. |
| Exposes | `/v1/expense-claims` |
| Publishes | `expense.claim.approved/reimbursed` |
| Consumes | `workflow.approval.*` |
| Depends on | P3, P5, F5 |
| Permissions / audit | `expense:claim:approve` |
| External | — |
| Order | Tier 6 |

### 5.7 AI Workforce

#### A1 AI Workforce (Leptron AI)
| Field | Specification |
|---|---|
| Purpose | An authorized intelligence and execution layer (D-008). |
| Responsibilities (Blueprint) | Agents: AI Concierge, AI Front Desk, AI Reservations, AI Housekeeping, AI Revenue, AI Sales, AI CRM, AI Support, AI Operations. Capabilities: Natural Language Interaction, Task Automation, Recommendations, Predictive Analytics, Anomaly Detection, Smart Alerts, Report Generation, Voice / Chat Interface. |
| Owns | `AgentDefinition`, agent configuration per tenant, `AgentRun` (tool calls, outcomes, and references to the B5 conversation; transcripts are not copied), agent budgets. |
| Does not own | **Any business data or business rules.** Every action goes through owning modules' APIs as a service identity (P2), under the same permissions, approvals (P3) and audit (P7). |
| Operations | Respond to events and requests; call permitted tools (generated from the APIs); propose or perform actions; ask for human approval where required (Q-31). |
| Exposes | Conversational interfaces, through O6 and staff UIs |
| Publishes | `ai.run.completed`, `ai.action.proposed` |
| Consumes | Configured domain events |
| Depends on | P2, P3, P7, and the APIs of the modules it acts on |
| Permissions / audit | Each agent's scopes are narrower than or equal to those of the user or role it acts for. **Every tool call is audited.** |
| External | Model provider (open; data location U-020) |
| Order | Tier 7 (after the modules it uses) |

---

## 6. Key flow across modules (illustrative)

Reservation to ledger. Each arrow is an API call or an event. No module writes another module's tables, and each step commits in its owning module's own transaction (§6.1).

```
B2 create (pending) ──place hold──▶ B1 ──▶ [M5 payment, if required] ──commit hold──▶ B1 committed ──▶ B2 confirmed
B2 ──reservation.created/confirmed──▶ B3 (stay read model), B5 (confirmation), B4 (channel sync via B1 events)
O1 check-in ──▶ B2 checked_in ──▶ F1 open folio, O2 tasks, O5 key (optional: only when O5 is active)
B2/M1/M3 ──posting API──▶ F1 postings ──(F6 tax calc)
M5 payment.captured ──▶ F1 payment posting
O1 check-out ──▶ B2 checked_out ──▶ F1 close ──▶ F2 invoice ──▶ F5 journal; B5 thank-you; M6 points
```

### 6.1 Transactions and recovery across modules

**Principle:**
- Each module commits **only its own data, in its own database transaction**, together with its outbox events (D-018).
- Modules share one physical database per cell (D-017), but **no business process relies on a single database transaction spanning more than one module's data** (G2).
- A process that spans several modules is a **recoverable sequence of local steps**, with compensating actions when a step fails.

**Who runs a process:**
- The module that owns the business outcome runs the process; for reservations, that is B2.
- It stores the process state in its own tables, so the process can resume after a crash.
- P3 supplies retries, timers and scheduling, but holds no business state.

**Reservation creation:**
1. The request arrives with an `Idempotency-Key`. B2 stores the key with a fingerprint of the request, so a repeated request returns the original result.
2. B2 creates the reservation as `pending` (B2's transaction).
3. B2 asks B1 to place a hold. The hold ID is derived from the reservation and an attempt number, which makes the call idempotent. In B1's own transaction, B1 checks and reduces sellable inventory, and gives the hold an expiry time.
4. If payment is required (Tier 3 onward), B2 asks M5 to take it, using an idempotency key derived from the reservation.
5. B2 asks B1 to **commit the hold**.
6. **Only after B1 reports `committed`** does B2 confirm the reservation (B2's transaction, which publishes `reservation.confirmed`).

**The invariant:** a reservation is never `confirmed` unless B1 holds a committed hold for it.
- The order of steps 5 and 6 guarantees this.
- A reconciliation job also compares B2's confirmed reservations with B1's committed holds, and raises an alert on any mismatch.

**Hold state machine (B1, proposed):**

```
held ──commit──▶ committed ──return (cancellation)──▶ returned
held ──release──▶ released
held ──expiry───▶ expired
```

- **`committed`, `released` and `expired` exclude each other.** A hold leaves `held` exactly once.
- **Every transition is a single conditional update in B1's own transaction.** It applies only if the hold is still in the expected state; in SQL terms, `… WHERE hold_id = ? AND status = 'held'`.
- **When a commit and an expiry happen at the same time, exactly one wins.** The loser gets the hold's actual final state back. No hold can be both committed and expired.
- **A commit after `expires_at` fails**, even if the expiry job hasn't run yet: the commit checks the time itself, using the database clock.
- **Idempotent results:**

  | Call | Result |
  |---|---|
  | commit on a hold that is already `committed` | success |
  | release on a hold that is already `released` or `expired` | does nothing |
  | commit on a `released` or `expired` hold | `hold_not_active`, with the actual state |
  | return on a hold that is already `returned` | does nothing |

- **Inventory changes:**
  - Expiring or releasing a hold puts its inventory back.
  - Returning a committed hold puts the inventory back when a confirmed reservation is cancelled.
  - Each of these happens in the same transaction as the state change.
- Hold expiry should be configured to last longer than the expected payment time. The value is set in the B1/B2 specifications.

**When holds expire and are released:**
- B1 expires holds itself, on a schedule run through P3, using the same conditional update, and publishes `inventory.hold.expired`. B2 consumes that event and moves any still-pending reservation onto the recovery path below.
- When a reservation fails before it is confirmed, B2 calls release explicitly. When a confirmed reservation is cancelled, B2 calls return. Both are idempotent.

**Recovery when the hold expires during confirmation** (B1 answers `hold_not_active` at step 5):
1. B2 tries **once to place and commit a new hold** (the next attempt number), if inventory is available.
2. If that succeeds, B2 confirms the reservation as normal.
3. If no inventory is available, the reservation becomes `failed`.
   - If a payment was captured, B2 asks M5 for a refund, which is idempotent.
   - If the refund can't be completed automatically, the reservation becomes **`requires_review`** and is shown to staff. It is never left as confirmed.

**Idempotency at every boundary:**
- Public API: an `Idempotency-Key` with the stored response.
- Calls between modules: deterministic operation IDs.
- Events: inbox deduplication (D-018).
- External providers: provider idempotency keys (M5) where the provider supports them; otherwise, reconciliation.

**Partial failures and compensating actions:**

| Failure | What happens |
|---|---|
| The hold fails (no availability) | The reservation becomes `failed`; there is nothing to undo |
| Payment fails after the hold | B2 releases the hold; the reservation becomes `failed` |
| Payment is captured, then the hold commit fails (hold expired or released) | The recovery path above: re-hold once; otherwise `failed` with an M5 refund (idempotent); if the refund can't complete, `requires_review` |
| The hold is committed, but B2 crashes before confirming | The recovery job finds the committed hold on a pending reservation and confirms it (idempotent) |
| B2 crashes at any other step | A recovery job resumes pending reservations from their recorded step. Holds that are never resumed expire safely |
| A confirmed reservation is cancelled | B2 returns the committed hold through B1. Refunds or penalties follow the policy, through M5 and F1 (policy rules belong in the reservation specification) |

**Payments and folios:**
- M5 is the single record of payments.
- F1 records a payment posting when it consumes `payment.captured` (idempotent by payment ID).
- A refund publishes `payment.refunded`, and F1 records a reversal posting.
- Reconciliation jobs compare M5 with the gateway, and F1 with M5. A mismatch raises an alert and is resolved by an audited action, **never by silent correction**.
- Whether check-out requires a zero balance or allows a transfer to AR is **Q-32**.

**Visibility.** Intermediate and recovery states are explicit statuses that staff can see, never hidden: pending, failed, `requires_review`, hold expired, mismatch found.

**What the specifications must define:**
- **Tenancy and data conventions:**
  - how idempotency keys are stored, and for how long;
  - how operation IDs are derived;
  - process-state tables in the owning modules;
  - status lists that include pending and failed;
  - the rule that no transaction spans modules;
  - version columns for concurrency control.
- **Events and the outbox:**
  - the events for each step (hold placed, committed, released, expired and returned; payment events);
  - ordering keys (per reservation or per property);
  - retry, timeout and dead-letter policy;
  - what compensation events mean.
- **Module specifications (B1, B2, M5, F1):**
  - hold expiry duration (configurable);
  - the compensation for each step;
  - reconciliation schedules.

---

## 7. Implementation order (founder-approved 2026-11-26)

The tiers below are approved as the engineering baseline. Prerequisites listed against a tier still have to be met before that tier's work starts.

| Tier | Modules | Prerequisites and scope notes |
|---|---|---|
| 0 | P1, P2, P3, P7, P8, P6 baseline; C1 and C2 minimal | **Milestone 1, Platform Foundation** (Technical architecture §15), built in the order in §7.1. <br>• Q-15 approval primitives.<br>• The Control Plane audit contract (Q-20) before the C1 and C2 administrative workflows.<br>• The identity provider decision before P2's provider integration. |
| 1 | P4 framework, P5 | Tier 0. P4 implements both connector scopes (Q-16). |
| 2 | B1, B3, B2 | Tier 1; Q-01 to Q-04. <br>• B3 with basic profiles; merging waits for Q-07.<br>• B2 without booking flows that need a payment. |
| 2 (Control Plane) | C5, C7 | Tier 0 |
| 3 | F6, M5, F1, F2, B5, O1, O2, M9 (initial), C3, C6 | U-008 (payment contract), launch gateways; U-013, U-014 and U-015 enough to cover launch markets. <br>• B2 gains its payment link with M5.<br>• M9 covers only modules that exist by then.<br>• O1 checks guests in without HOS key issuance. |
| 4 | **O4, then O3**; **F3, then F5 (initial scope)**; B4; C4, C8, C9 | <br>• O3 ships without the Parts / Materials stock integration.<br>• F5's initial sources are F1, F2, F3, F6 and M5.<br>• B4 needs the OTA connectivity decision.<br>• U-015. |
| 5 | O6, M1, M2, M3, F4 | Guest app approach; Q-11. <br>Extensions in this tier: O3 Parts / Materials with M2; F5 posting rules for F4. |
| 6 | M4, M6, M7, M8, O5, F7, F8 | Q-25, Q-27; door-lock vendor. <br>Extensions in this tier: F5 posting rules for F7 and F8; O5 key issuance joins the check-in flow. |
| 7 | A1 | The modules it acts on; model provider; U-020; Q-31 |

**Rationale:**
- Platform first: tenancy, identity, audit, events.
- Then the reservation core: inventory, guests, reservations.
- Then the financial core and the day-to-day operations needed to run a stay.
- Then distribution and accounting, then everything else.
- Reports grow alongside each module.

**Optional integrations don't move modules earlier.** When a module depends on a later module only for an optional integration, it ships without that integration, and the integration is added as an extension when the later module ships. Examples: O3 with M2, F5 with F4/F7/F8, O1 with O5, B2 with M5.

### 7.1 Tier 0 bootstrap sequence

**The problem:** P1, P2, P3 and P7 each listed the others as dependencies.

**The fix:**
- Each of these modules is split into a small **kernel** (internal primitives that depend on nothing above them) and its **services** (APIs and workers).
- The kernel code belongs to the same module, so this adds no new module.
- Dependencies point **down the layers only**, and architecture tests enforce that.

| Layer | Contents | Depends on |
|---|---|---|
| L0 Database and context | Migration framework, database roles and grants, row-level security policies, the **tenant-context primitive** (P1 kernel: sets and checks the tenant for each transaction), and the **request context type**: verified actor, authorized tenant, correlation ID. Only the trusted entry points listed below may fill in the request context. | Nothing |
| L1 Kernel writers | **Audit writer** (P7 kernel): writes a redacted audit record (§1.1) in the same transaction as the change. It takes the **verified** actor from the trusted request context, **without calling P2**. **Security-event writer** (P7 kernel): records denials in the system security log (§7.2). **Outbox writer** (P3 kernel): writes events in the same transaction. | L0 |
| L2 Identity | P2: identity-provider integration, token verification, permission engine, role assignments, service identities | L0, L1 |
| L3 Platform services | P1 tenant and department APIs; P3 relay, inbox, workers, scheduler, approval primitives; P7 audit read and data-request APIs; P8 configuration; P6 baseline | L0–L2 |
| L4 Provisioning | The cell's provisioning API; minimal C1 and C2, using the Control Plane's identity and audit (§1.2) | L0–L3 |

**Trusted tenant and actor context (mandatory for every layer):**
- **Verified facts vs. untrusted metadata.**
  - **Verified:** the actor's identity, which comes from a credential checked by L2 (or by the bootstrap or provisioning entry point), and that actor's roles and permissions, which **P2 evaluates from role assignments HOS owns** (D-021).
  - **Untrusted:** everything else in a request: headers, body, query parameters, a client-supplied correlation ID, and any tenant, actor, role or permission value the caller sends. Role or permission claims inside a token are not used for authorization either.
- **Callers can't choose or forge context.**
  - Callers can never set the actor ID, tenant ID, roles or permissions.
  - A client-supplied correlation ID may be recorded for tracing, but it is never used for authorization.
- **The server establishes context, in this order, before any tenant-scoped database access:**
  1. Verify the credential.
  2. Resolve the actor.
  3. Determine the target tenant from the route or the resource, never from a free-form field in the payload.
  4. **Check that the actor is authorized for that tenant and scope** (organization, property or department).
  5. Only then open the transaction, setting the tenant and actor with `SET LOCAL`.

  The context can't be changed for the rest of the request. Application code can set it only through this path, and architecture tests enforce that.
- **Fail closed.** Any of the following rejects the request **before any tenant-scoped database access**. The denial is recorded in the P7 **system security log** (§7.2), never in tenant-scoped audit:
  - a missing, invalid or expired credential;
  - an unknown tenant;
  - an actor who isn't authorized for the tenant;
  - a payload whose tenant disagrees with the context.

  Row-level security also denies access when the tenant variables are missing. The runtime database role has **no** row-level security bypass. Only the migration role, which is never used at runtime, has elevated rights.
- **Background and inbound work:**
  - Event consumers take their context from the event envelope. That is trusted, because only the outbox writer creates envelopes, and it does so from a verified context.
  - Inbound webhooks (P4) take their tenant from the connector-instance record, not from what the payload claims.
- **Bootstrap and provisioning identities are limited to exactly what they need:**
  - **The bootstrap procedure** can only create the first Leptron administrator in the Control Plane. It has no access to cells or tenant data.
  - **The provisioning machine identity** can call only the cell's provisioning endpoints, and can only create or update the organization, property, configuration snapshot and first-administrator invitation.
    - It can't read tenant operational or guest data, or call any other API.
    - Its credentials are short-lived and scoped to one cell.

**The first privileged administrator (Leptron, Control Plane):**
- It is created by a **one-time bootstrap procedure**, run at deployment by an authorized operator using AWS IAM, so no application sign-in is needed.
- The procedure **refuses to run if any Leptron administrator already exists**. It can't be re-run to gain extra privileges.
- The administrator is tied to Leptron's corporate identity (realm 1) and must enrol MFA at first sign-in.
- There are no default or hard-coded passwords. Any bootstrap secret is single-use, short-lived, and never stored in the repository.
- The bootstrap writes the first Control Plane audit record.

**The first tenant:**
- It is created through the **normal D-012 workflow in C2**; there is no special path.
- C2 calls the cell's provisioning API as a **Control Plane machine identity with a provisioning-only scope**.
  - Trust between the Control Plane and the cell is established at deployment, through infrastructure as code, not by a person.
  - The exact mechanism is defined in the Control Plane–cell contract specification.
- The cell creates the organization, the property and the configuration snapshot (layers L0–L3 are already running) and audits each step in P7.
- The first hotel administrator gets a **single-use invitation that expires**, in the hotel-employee realm. Leptron never sets or sees that password, and privileged roles require MFA enrolment.

**Tests:**
- A second bootstrap run is refused.
- Requests with forged or mismatched tenant or actor values, or with missing context, are rejected before any database access.
- The provisioning identity is denied every endpoint except provisioning.
- Provisioning is idempotent.
- No tenant data exists without matching audit records.
- Lower layers never import higher layers.

### 7.2 Recording denials before tenant context exists (P7 system security log)

**Scope.** Requests that §7.1 rejects **before any tenant-scoped database access**:
- authentication failed;
- no valid tenant context;
- the tenant is unknown;
- authorization failed before tenant access;
- the payload's tenant disagrees with the context.

**Where denials are recorded: the P7 system security log.**
- It is part of P7 Security & Compliance (blueprint: "Audit Logs"). **It is not a new module.**
- It is cell-level, append-only and tamper-evident (hash-chained).
- It is kept **separate from the tenant-scoped audit records**. It has no tenant row-level security and is never mixed with tenant audit.
- Denials are **never written into a tenant's audit stream**, because that would require a tenant context the request never established.
- The storage technology isn't chosen here.

**Writer.**
- The P7 kernel's security-event writer (layer L1) uses a **dedicated database role that can only INSERT into the security log**. It can't read the log, touch any tenant table, or set tenant variables.
- It writes in its own short transaction. The rejected request has no transaction of its own.

**Fields recorded (allowlist; the writer rejects any other field):**

| Field | Source | Trust |
|---|---|---|
| Event ID, time recorded | Server | Trusted |
| Cell ID, component, route template, HTTP method | Server. Route template only, without path values or query string | Trusted |
| Outcome code | Fixed list: `authn_failed`, `context_missing`, `tenant_unknown`, `authz_denied`, `context_mismatch` | Trusted |
| Reason code | A fixed list per outcome (for example `token_expired`, `signature_invalid`, `no_role_in_scope`); no free text | Trusted |
| Request ID | Generated by the server | Trusted |
| Actor | The verified actor ID and realm, **only if authentication succeeded**; otherwise `unauthenticated` | Trusted |
| Tenant status | One of:<br>• `verified_not_authorized`: the server resolved the tenant and it exists, but the actor isn't authorized for it;<br>• `unknown`: the server's lookup found no such tenant;<br>• `not_provided`;<br>• `not_evaluated`: rejected before the tenant was resolved | Trusted |
| Target tenant | The tenant ID resolved by the server, **only** when the status is `verified_not_authorized` | Trusted |
| Claimed tenant | The tenant value the caller sent, kept only if it is a well-formed ID. It sits in a field **marked untrusted** and is never looked up, joined or used for authorization | **Untrusted, labelled** |
| Client correlation ID | Sent by the caller; length-limited and sanitized | **Untrusted, labelled** |
| Source network address | From the load balancer. Classified as personal data, so kept for a shorter time | Trusted network metadata |
| Record type | `individual` (one denial) or `aggregate` (a summary of later identical denials; see "Volume and reliability") | Trusted |
| Aggregate fields, on `aggregate` records only | The ID of the first-occurrence record, the count, the first and last time, and the writer instance | Trusted |

**How tenant identity is represented when it can't be verified.**
- The tenant status says exactly what is known.
- A caller's claim is kept apart from verified facts, and visibly labelled untrusted.
- The only tenant lookup is a **P1 kernel existence check**. It returns only "exists" or "not found", plus the ID, and reads no tenant business data.

**Never recorded:**
- credentials, tokens, `Authorization` headers, cookies, passwords, API keys;
- request or response bodies, query strings, full URLs, path values, raw headers;
- free text supplied by the caller;
- any tenant business data.

The writer applies the field classification in §1.1, and rejects fields classified as secret.

**How this avoids touching tenant data or inventing a tenant context.**
- No tenant context is ever set (`SET LOCAL`). The claimed tenant never becomes a context.
- The writer uses only the INSERT-only role on the security log.
- The only tenant-related read is the existence check.
- Untrusted values are labelled, so no reader can mistake them for verified facts.

**Volume and reliability (D-013): records are only ever appended, never updated.**
- **No record is ever updated or deleted.** Aggregation never changes an existing record. It **appends** a new, hash-chained `aggregate` record.
- **What is recorded individually** (one `individual` record per denial, always):
  - every denial with a **verified actor** (`authz_denied`, and `context_mismatch` by an authenticated actor), because these matter most for investigating an incident;
  - the **first occurrence** of every other kind of denial.
- **What is aggregated, and how:**
  - Aggregation applies only to denials **without a verified actor** (`authn_failed`, `context_missing`, `tenant_unknown`), which are the kind most likely to arrive in floods.
  - After the first occurrence, the writer counts later identical denials in memory for a short, fixed window. "Identical" means the same outcome, reason, route, source address and claimed tenant.
  - When the window closes, the writer **appends one `aggregate` record**: the ID of the first-occurrence record, the count, and the first and last time. These events differ from the first occurrence only in their time and request ID.
- **Counts are a lower bound, and are labelled that way.** If a writer instance stops before its window closes, that window's count may be missing.
  - The first-occurrence record is always written durably, so no attack *pattern* goes unrecorded.
  - Each writer instance appends its own aggregates; the reporting layer adds them up.
- **Investigating individual incidents:** Leptron security operations can turn on **full-fidelity mode** for a defined scope (a source address, route or claimed tenant) for a limited time.
  - In that mode, every matching denial is recorded individually.
  - Turning the mode on or off is itself recorded in the security log, and needs the same controlled access as reading it.
- **Reporting layer, separate from the log:** dashboards, P6 spike alerts and the aggregated counts sent to the Control Plane (D-020) are **read-only views computed from the log**. They never write back to it and are not authoritative.
- **A rejection never depends on logging.** If the write fails, the request is still rejected and P6 raises an operational alert.
- **Integrity is unchanged.** Individual and aggregate records sit on the same hash chain, and both are covered by the integrity check.

**Access, retention and auditability:**
- **Reading:** only Leptron security operations roles may read the log, inside the cell, under a time-limited C6 grant (§1.2). Each read is itself recorded in the security log.
- **Control Plane:** receives only aggregated, non-personal counts, through the allowlisted telemetry API (D-020).
- **Hotel staff:** no access by default. Whether a hotel should see denials that targeted its own verified tenant is **Q-33**.
- **Integrity:** nobody can modify or delete records, and that includes aggregation, which only appends. A scheduled integrity check verifies the hash chain and alerts if it fails.
- **Retention:** set in the security and audit specification, with legal input (U-013, U-020). Network addresses are kept for less time than other fields (proposed). Records expire only by policy, and each expiry is itself logged.

**Tests:**
- A forged tenant claim is recorded as claimed and untrusted, and no tenant table is touched (checked through the database role).
- A failed log write still rejects the request.
- Records contain no secrets or bodies (checked by a scan).
- Repeated denials without a verified actor produce one first-occurrence record and then appended aggregate records, and **no existing record is ever modified** (checked through the database role and the hash chain).
- Denials with a verified actor are never aggregated.
- Full-fidelity mode records every matching denial, and switching it on or off is logged.

---

## 8. Ownership rulings (founder-approved 2026-11-26)

These rulings settle overlaps where the blueprint shows a capability in more than one module. Each one keeps a **single source of truth**. None adds a module.

**Status:**
- **All 16 rulings are founder-approved** as part of the engineering baseline (2026-11-26), after the founder review of 2026-11-25 (status table below).
- They are **not D-numbered decisions**. Recording them in the decision log as D-026 or later needs separate founder authorization.
- The rulings for MM-02, MM-10 and MM-16 below are the **founder-revised** versions.

| ID | Overlap in the blueprint | Ruling |
|---|---|---|
| MM-01 | "Restrictions" in Inventory & Rate (B1) **and** "Restrictions Management", "Dynamic Pricing" in Revenue Management (M4) | B1 is the only writer of rates and restrictions. M4 creates recommendations and applies them through B1's API. |
| MM-02 | Who owns the physical room master (room numbers, room-to-type mapping) | B1 owns all three, as **separate concepts**:<br>(1) **physical room identity** (`Room`: number, location);<br>(2) **room types** (`RoomType`: the category sold);<br>(3) **sellable inventory** (`InventoryAllocation`: count by date and type, net of holds and blocks).<br>They have different lifecycles and must not be merged into one record. Physical room *status* is not part of B1 (MM-05). |
| MM-03 | Check-in and check-out appear in Front Desk (O1) and the Guest Journey | Reservation status, **including** in-house and checked out, belongs to B2 ("reservation lifecycle"). O1 starts the transitions. |
| MM-04 | "Room Assignment" in Front Desk (O1) and the Guest Journey | The assigned room is stored on the reservation (B2). O1 provides the user interface. |
| MM-05 | "Room status" (founder: owned by Property Operations) spread across Housekeeping and Maintenance | Housekeeping status belongs to O2 ("Room Status Tracking"). Out-of-order and out-of-service blocks belong to O3 ("Room Blocking / Release"). Occupancy comes from B2. The overall room status is a **combined read view** with no separate store. |
| MM-06 | "User Access Control" and "Audit Logs" in Security Management (O5) **and** IAM (P2) and Security & Compliance (P7) | Software identities and permissions belong to P2; the audit store belongs to P7. O5 covers physical security and provides a hotel-facing audit view. |
| MM-07 | "Loyalty Profile" in CRM (B3) **and** Loyalty Management (M6) | M6 owns membership and points; B3 shows a read copy. |
| MM-08 | "Multi Channel Send" in Marketing (M7) **and** Communication Engine (B5) | M7 owns campaigns and segments; B5 performs all sending. |
| MM-09 | Menu items (M1) vs. items and recipes (M2) | M1 owns menu items; M2 owns recipes and stock; menu items map to recipes. |
| MM-10 | "ADR / RevPAR" in Revenue Management (M4) **and** Reports & Analytics (M9) | **M9 owns the KPI catalogue, definitions and versioning.** Source modules own the underlying business facts. M4 must use the agreed definitions, and refers to a definition version. |
| MM-11 | "Business Rule Engine" (P3) vs. module business rules | Module rules that must always hold (invariants) stay in the owning module. P3's rule engine handles only configurable automation conditions. |
| MM-12 | "Billing & Folio Management" in Front Desk (O1) | O1 is a workspace over F1; F1 owns folios. |
| MM-13 | Hotel staff appear both as a user (P2) and as an employee (F7, "Employee Master") | Two linked records. The P2 user is a system identity; the F7 employee is an HR and payroll record. Neither is copied into the other. |
| MM-14 | A property exists in the Control Plane (C2) and in the cell (P1, P8) | C2 is authoritative for registration, cell placement and provisioning status. The cell is authoritative for operational records and active configuration. Changes go through the controlled provisioning or change flow (D-012). |
| MM-15 | "Feature Flags" in Deployments & Versions (C7) **and** Configuration & Settings (P8) | C7 owns flag definitions and rollout plans. P8 holds the effective value for each property inside the cell. |
| MM-16 | Tax configuration from the regional template (P8, D-012) **and** Tax Management (F6) | **F6 owns operational tax rules and calculation. P8 supplies the initial regional configuration.** Every tax rule keeps its jurisdiction, source, effective date, version and audit information. **Regional templates are not a substitute for legal validation** (U-013). |

**Founder review status:**

| Ruling | Status |
|---|---|
| MM-01, MM-03, MM-04, MM-05, MM-06, MM-07, MM-08, MM-09, MM-11, MM-12, MM-13, MM-14, MM-15 | Approved as proposed |
| MM-02 | Approved with clarification: three distinct concepts |
| MM-10 | Approved as revised: M9 owns the KPI catalogue, definitions and versioning |
| MM-16 | Approved as revised: F6 owns operational tax rules; P8 supplies initial configuration; legal validation is separate |

---

## 9. Unresolved architectural questions

**Questions raised by this module map:**

| ID | Question | Affects |
|---|---|---|
| Q-01 | Can a reservation hold several rooms, or is a multi-room booking a group? | B2, B1 |
| Q-02 | How are packages modelled ("Group / Corporate / Package", "Rates & Packages"): as a rate plan in B1, or as reservation components in B2? | B1, B2 |
| Q-03 | Where do add-ons and upsells live, and do they post to F1 straight away? | B2, F1, O6 |
| Q-04 | Are "Requests" (CRM) and "Special Requests" (Pre-Arrival) the same record, and who owns it: B3 (preference) or B2 (per stay)? | B2, B3 |
| Q-05 | Who owns "Service Requests" (In-House Stay, Guest Experience): Housekeeping, Maintenance, Front Desk, or each by request type? | O1, O2, O3, O6 |
| Q-06 | Where are guest consent records stored and enforced? **Answered by founder review (§9.1).** | B3, B5, M7 |
| Q-07 | The contract for matching and merging duplicate guest profiles. **It must be defined before merging is implemented.** Basic profile creation doesn't wait for it (§9.1). | B3 |
| Q-08 | Scope of "Other Integrations" (Accounting, HRMS, CRM, ERP, BI Tools, Custom APIs): import, export or two-way sync? | P4, F5, F7, B3, M9 |
| Q-09 | Is a registration card a separate record, or only a document in P5? | O1, P5 |
| Q-10 | Do front desk shifts and cashiering exist outside POS "Shift & Cash Management"? Not in the blueprint. | O1, M1 |
| Q-11 | Hardware integration model for Kiosk, POS devices and IoT (edge agent, vendor) | P4, O1, M1, O3 |
| Q-12 | Housekeeping staff device approach (staff mobile or web) | O2 |
| Q-13 | CCTV Integration scope (links only, event alerts, or video storage) | O5, P5, cost |
| Q-14 | Who owns the authoritative hotel and room information content shown in the guest app? (Chat ownership is answered: B5, §9.1.) | O6, B5, A1 |
| Q-15 | The exact separation-of-duties rules for finance approvals (adjustments, refunds, supplier bills, expenses). Foundational primitives are defined now (§9.1). | P2, P3, finance |
| Q-16 | Connector instance scope. **Direction set:** support both organization-level and property-level instances, with an explicit scope (§9.1). Credential ownership remains U-018. | P4 |
| Q-17 | Digital signature provider | P5 |
| Q-18 | Hotel-staff access to observability. **Default set:** no access to internal infrastructure telemetry (§9.1). | P6 |
| Q-19 | Which regulatory submissions (for example Police e-FRRO) belong to which module | P7, O1, P4 |
| Q-20 | The Control Plane audit contract. **Requirement set:** a separate, append-only, tamper-evident capability (§1.2, §9.1). | C1–C9 |
| Q-21 | Leptron's own payment and accounting providers for SaaS billing | C4 |
| Q-22 | Should POS check stock availability in real time? | M1, M2 |
| Q-23 | How events reserve guest rooms (through B2 group blocks?) | M3, B2 |
| Q-24 | Are revenue recommendations applied automatically or only with approval? | M4, B1 |
| Q-25 | Source of competitor rates | M4, P4 |
| Q-26 | Qualifying spend for loyalty points, and the financial treatment of redemptions | M6, F1, F5 |
| Q-27 | Review sources for aggregation | M8, P4 |
| Q-28 | Folio structure (per reservation, guest or account; split folios) | F1 |
| Q-29 | Credit notes and invoice corrections, by jurisdiction | F2, P8 |
| Q-30 | Matching rules for AP (purchase order, receipt and bill) | F4, M2 |
| Q-31 | Which AI agent actions need human approval | A1, P3 |
| Q-32 | Check-out precondition: must the folio balance be zero, or can it be transferred to AR? (raised by §6.1) | B2, F1, F3 |
| Q-33 | Should hotel administrators see denials that targeted their own *verified* tenant (status `verified_not_authorized`), and if so, through which controlled projection of the system security log? (raised by §7.2) | P7, P2, O5 |

### 9.1 Questions settled by founder review

None of these is a D-numbered decision.

| ID | Outcome | What still blocks, and what it affects |
|---|---|---|
| Q-06 | **Answered.** B3 owns the authoritative consent record (what the guest has permitted, per purpose and channel). B5 checks it before every send. Channel preferences (what the guest prefers) are a separate record. | Nothing further; the consent contract is detailed in the B3 and B5 specifications |
| Q-07 | **Partly answered.** A merge contract is required before merging is implemented. Basic profile creation goes ahead. | Blocks merge functionality only |
| Q-14 | **Partly answered.** Chat conversations belong to B5. O6 handles presentation only. | The owner of hotel and room information content is still open; this blocks only that O6 feature |
| Q-15 | **Partly answered.** Tier 0 provides scoped roles and permissions, the P3 approval-request primitive, and the ability to forbid self-approval for each approval type. | The exact finance rules are completed in the finance specifications. They block finance approval workflows (F1 adjustments, M5 refunds, F4, F8), **not Tier 0** |
| Q-16 | **Direction set:** both organization-level and property-level connector instances, with an explicit scope. | Blocks only the affected P4 implementation, **not Tier 0** |
| Q-18 | **Default set:** hotel staff have no access to internal infrastructure telemetry. | Any future hotel-facing health view needs its own design and permissions |
| Q-20 | **Requirement set:** a separate, append-only, tamper-evident Control Plane audit capability is mandatory. | Its contract must be settled **before the Control Plane's administrative workflows** (C1 and C2 in Tier 0) are implemented. It does not block cell Tier 0 work |

**Existing open items that affect this map:**
- U-001, U-002, U-003, U-004, U-005, U-006 (unreadable or unconfirmed blueprint items).
- U-007, U-008 (external mappings, payment contract).
- U-009, U-010 (contracts between rows and with finance; this map **proposes** them, and specifications finalize them).
- U-011 (AI contracts).
- U-012 to U-020 (regional).
- U-021, U-022 (capacity, entitlements).
- Open technical decisions in [TECHNICAL_ARCHITECTURE.md §13](TECHNICAL_ARCHITECTURE.md#13-open-decisions).

---

## 10. Blueprint reconciliation (45 names, 46 modules)

### 10.1 What the blueprint image contains

| Element in the image | Count | Treated as | Basis |
|---|---|---|---|
| Module tiles in the Business Layer: core row 5, property operations 6, commercial 9, Finance & Accounting 8, AI Workforce 1 | 29 | Modules | Image; [interpretation](../blueprint/BLUEPRINT_INTERPRETATION.md) §2 |
| Platform Foundation Layer tiles | 8 | Modules | Image; interpretation §3 |
| Leptron Control Plane tiles (8 labelled, plus 1 unlabelled tile named by D-001) | 9 | Modules | Image; interpretation §4; D-001 |
| **Total module tiles** | **46** | **46 modules** | |
| Guest Journey & Property Operations Flow stages | 6 | A process flow, **not** modules (§4) | Image: one band of numbered steps connected by arrows |
| External Ecosystem groups | 9 | External systems, **not** modules | Image: outside the HOS layers |
| Group headings (Business Layer, Finance & Accounting, Platform Foundation Layer, Control Plane) | — | Labels, **not** modules | Image |

**The AI Workforce is one tile.** Its "AI Agents" and "Capabilities" are two panels inside a single bordered tile, "AI WORKFORCE (LEPTRON AI)". So it is one module, A1, as in interpretation §2.7.

### 10.2 Why there are 45 names but 46 modules

There are **46 tiles but only 45 distinct tile names**, because **"Billing & Invoicing" appears twice**:
- once in the Finance & Accounting group, which is **F2**, hotel financial billing;
- once in the Leptron Control Plane, which is **C4**, Leptron SaaS subscription billing.

**D-009** (approved) records these as two separate domains. **So the difference is intentional and justified.** No module was added, merged or split.

Names that look alike but differ are separate tiles: Inventory & Rate Engine vs. Inventory & Procurement (D-010), and Security Management vs. Security & Compliance (MM-06).

### 10.3 Tile-to-module mapping and capability check

**How capabilities were checked (2026-11-25):** an automated comparison took every capability listed in the interpretation document, which is the founder-accepted transcription of the image, and checked that it appears **verbatim** in the "Responsibilities (Blueprint)" row of the module assigned to it below.
- **Result: all 256 readable tile capabilities were found in their assigned module, with 0 missing.**
- All 36 readable Guest Journey steps appear in §4.
- One wording gap was found and fixed: M1's "Outlets (Restaurant/Bar/Cafe/Room Service)".
- Each module's capabilities are listed in its own specification (§5), so they aren't repeated here.

| # | Blueprint tile | Group | Module | Capabilities matched | Notes |
|---|---|---|---|---|---|
| 1 | Channel Manager | Core | B4 | 8 / 8 | |
| 2 | Inventory & Rate Engine | Core | B1 | 6 / 6 | |
| 3 | Reservations Engine | Core | B2 | 6 / 6 | |
| 4 | CRM & Guest Profile | Core | B3 | 7 / 7 | |
| 5 | Communication Engine | Core | B5 | 5 / 5 | |
| 6 | Front Desk Operations | Property operations | O1 | 6 / 6 | |
| 7 | Housekeeping Management | Property operations | O2 | 8 / 8 | Includes D-002 item |
| 8 | Maintenance Management | Property operations | O3 | 8 / 8 | Includes D-002 item |
| 9 | Engineering Assets | Property operations | O4 | 5 / 5 | |
| 10 | Security Management | Property operations | O5 | 5 / 5 | |
| 11 | Guest Experience (Mobile App) | Property operations | O6 | 7 / 7 | Includes "Bill Review & Docking" (U-006, pending verification) |
| 12 | POS (F&B & Outlets) | Commercial | M1 | 8 / 8 | |
| 13 | Inventory & Procurement | Commercial | M2 | 10 / 10 | Includes D-002 item |
| 14 | Banquets & Events | Commercial | M3 | 9 / 9 | |
| 15 | Revenue Management | Commercial | M4 | 8 / 8 | |
| 16 | Payment Management | Commercial | M5 | 7 / 7 | |
| 17 | Loyalty Management | Commercial | M6 | 5 / 5 | |
| 18 | Marketing & Campaigns | Commercial | M7 | 5 / 5 | |
| 19 | Reputation Management | Commercial | M8 | 5 / 5 | |
| 20 | Reports & Analytics (BI) | Commercial | M9 | 9 / 9 | + final item unreadable (U-002) |
| 21 | Folio Management | Finance | F1 | 5 / 5 | |
| 22 | Billing & Invoicing | Finance | **F2** | 5 / 5 | Same name as tile 46 (D-009) |
| 23 | Accounts Receivable | Finance | F3 | 5 / 5 | |
| 24 | Accounts Payable | Finance | F4 | 5 / 5 | |
| 25 | General Ledger | Finance | F5 | 5 / 5 | |
| 26 | Tax Management | Finance | F6 | 5 / 5 | |
| 27 | Payroll Management | Finance | F7 | 5 / 5 | |
| 28 | Expense Management | Finance | F8 | 4 / 4 | |
| 29 | AI Workforce (Leptron AI) | AI Workforce | A1 | 17 / 17 (9 agents + 8 capabilities) | One tile with two panels |
| 30 | Multi-Tenant Architecture | Platform | P1 | 4 / 4 | |
| 31 | Identity & Access Management | Platform | P2 | 5 / 5 | |
| 32 | Event & Workflow Engine | Platform | P3 | 5 / 5 | Garbled stray character ignored (D-004) |
| 33 | Integration Hub | Platform | P4 | 6 / 6 | |
| 34 | Document Management | Platform | P5 | 5 / 5 | |
| 35 | Observability & Monitoring | Platform | P6 | 5 / 5 | |
| 36 | Security & Compliance | Platform | P7 | 5 / 5 | |
| 37 | Configuration & Settings | Platform | P8 | 5 / 5 | |
| 38 | Customer Management | Control Plane | C1 | 2 / 2 | + third item unreadable (U-004) |
| 39 | Property Management | Control Plane | C2 | 2 / 2 | + remaining items unreadable (U-003) |
| 40 | Subscription & Licensing | Control Plane | C3 | 3 / 3 | |
| 41 | Billing & Invoicing | Control Plane | **C4** | 3 / 3 | Same name as tile 22 (D-009) |
| 42 | Platform Health | Control Plane | C5 | 3 / 3 | Shares a table with C6–C9 in §5.2 |
| 43 | Support & Diagnostics | Control Plane | C6 | 3 / 3 | |
| 44 | Deployments & Versions | Control Plane | C7 | 3 / 3 | |
| 45 | Usage & Analytics | Control Plane | C8 | 2 / 2 | + third item unreadable (U-005) |
| 46 | Resource Monitoring & Business Insights | Control Plane | C9 | 2 / 2 | Tile name from D-001 |

**Totals:** 46 tiles mapped to 46 modules; 45 distinct names; 256 of 256 readable capabilities matched. Unreadable items are tracked as U-001 to U-005, and never invented (D-003).

### 10.4 Capabilities that appear in more than one tile

Each overlap has a **single owner**. None is an unintended duplicate.

| Capability (wording in the image) | Tiles | Owner and basis |
|---|---|---|
| Billing & Invoicing (tile name) | F2, C4 | Two domains (D-009) |
| Room inventory vs. stock inventory | B1, M2 | Two domains (D-010) |
| Rate Plans & Restrictions / Restrictions Management, Dynamic Pricing | B1, M4 | B1 writes; M4 recommends (MM-01) |
| Room Assignment / Moves / Upgrades; journey "Room Assignment", "Check-in", "Checkout" | O1, journey | B2 (MM-03, MM-04) |
| Room Status Tracking / Room Blocking / Release | O2, O3 | O2 and O3, with a combined read-only view (MM-05) |
| User Access Control, Audit Logs | O5, P2, P7 | P2 and P7; O5 has a restricted view (MM-06) |
| Loyalty Profile / Loyalty Management | B3, M6 | M6 (MM-07) |
| Multi Channel / Multi Channel Send | B5, M7 | B5 sends; M7 owns campaigns (MM-08) |
| Menu & Items / Recipes & BOM | M1, M2 | M1 menu; M2 recipes (MM-09) |
| ADR / RevPAR / Occupancy / ADR / RevPAR | M4, M9 | M9 owns KPI definitions (MM-10) |
| Business Rule Engine vs. module rules | P3, all | Module invariants stay in modules (MM-11) |
| Billing & Folio Management / Folio Management | O1, F1 | F1 (MM-12) |
| Employee Master / User/Role Management | F7, P2 | Two linked records (MM-13) |
| Property Management / Property Configuration, Organizations | C2, C1, P1, P8 | Split by plane (MM-14) |
| Feature Flags | C7, P8 | C7 definitions; P8 effective values (MM-15) |
| Taxes & Charges / Charges & Taxes / Tax Management | F2, journey, F6 | F6 (MM-16) |
| Communication History / Communication Engine | B3, B5 | B5 (founder instruction) |
| Chat / Concierge / AI Concierge / Voice / Chat Interface | O6, A1, B5 | B5 conversations; O6 presentation; A1 agent (Q-14) |
| Service Requests / Housekeeping Requests | Journey, O6, O2 | Q-05 (open) |
| Approvals / Approval Workflows | F4, F8, P3 | P3 runs workflows; modules own the business state |
| Payments (several tiles) | M5, F4, C4, M1, M3, B2 | M5 for guest payments; F4 for supplier payments; C4 for SaaS payments |
| Reconciliation / Reconciliations / Payment Reconciliation / Sync & Reconciliation | F4, F5, M5, P4 | Each module reconciles a different scope |
| Aging Analysis | F3, F4 | Receivables vs. payables |
| Contracts | C1, M3, P5, Corporate / TMC | Customer contracts, event contracts, contract files, and an external group |
| Templates / Templates & Digital Signatures | B5, P5 | Message templates vs. document templates |
| Alerts (Error Handling & Alerts, Notifications & Alerts, Issue Alerts, Low Stock Alerts, Smart Alerts, Alerts & Incident Management) | B4, B5, M8, M2, A1, P6 | Each module raises its own alerts; B5 delivers staff notifications; P6 handles platform alerts |
| Incident Management / Alerts & Incident Management | O5, P6 | Hotel security incidents vs. platform incidents |
| Report capabilities inside modules (POS Reports, Productivity Reports, Expense Reports, Payslips / Reports, Report Generation) | M1, O2, F8, F7, A1, M9 | Reports local to each module; M9 for reporting across modules and KPI definitions |
| Usage Tracking / Usage & Analytics | C3, C8 | C8 aggregates usage; C3 uses it for subscriptions |
| Configuration Management / Configuration & Settings | P1, P8 | P1 scopes configuration; P8 holds the values |

**Conclusion:**
- **No blueprint capability is missing.** All 256 readable capabilities are mapped, and unreadable items are tracked rather than invented.
- **No unintended duplicate exists.** Every overlap above has one owner, recorded in an approved decision, an MM ruling or an open question.
- **The 45-to-46 difference comes entirely from the two "Billing & Invoicing" tiles**, which are separate under D-009.
