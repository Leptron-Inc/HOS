# HOS Decision Log

This log records approved architectural decisions for HOS by Leptron. Each decision is binding
under [PROJECT_RULES.md](../PROJECT_RULES.md) and stays in force unless a later entry
supersedes it.

- **Blueprint:** [blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png](blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png)
- **Interpretation:** [blueprint/BLUEPRINT_INTERPRETATION.md](blueprint/BLUEPRINT_INTERPRETATION.md)
- **Open items:** [blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md](blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md)

| ID | Date | Status | Title |
|---|---|---|---|
| D-001 | 2026-11-24 | Approved | Name the unlabeled Control Plane tile |
| D-002 | 2026-11-24 | Approved | Keep partially visible capabilities that can be read |
| D-003 | 2026-11-24 | Approved | Do not infer unreadable blueprint items |
| D-004 | 2026-11-24 | Approved | Ignore garbled text in the Platform Foundation layer |
| D-005 | 2026-11-24 | Approved | External ecosystem dashed lines are conceptual |
| D-006 | 2026-11-24 | Approved | Inter-row vertical arrows are conceptual |
| D-007 | 2026-11-24 | Approved | Finance & Accounting integration and ownership |
| D-008 | 2026-11-24 | Approved | AI Workforce operating boundary |
| D-009 | 2026-11-24 | Approved | Two separate Billing & Invoicing domains |
| D-010 | 2026-11-24 | Approved | Two separate Inventory domains |
| D-011 | 2026-11-24 | Approved | Payment Gateways to Payment Management contract |
| D-012 | 2026-11-24 | Approved (founder) | Regional provisioning driven by the Control Plane |
| D-013 | 2026-11-25 | Approved (founder) | Global scalability and capacity requirement |
| D-014 | 2026-11-25 | Approved (founder) | Modular monolith with a separate Control Plane |
| D-015 | 2026-11-25 | Approved (founder) | TypeScript, NestJS, React and Vite |
| D-016 | 2026-11-25 | Approved (founder) | PostgreSQL on AWS RDS, standard features only |
| D-017 | 2026-11-25 | Approved (founder) | Shared database per cell with row-level security |
| D-018 | 2026-11-25 | Approved (founder) | Transactional outbox and SQS, at-least-once delivery |
| D-019 | 2026-11-25 | Approved (founder) | Regional cell architecture, starting with one cell |
| D-020 | 2026-11-25 | Approved (founder) | Strict Control Plane data allowlist |
| D-021 | 2026-11-25 | Approved (founder) | Four identity realms; HOS owns authorization |
| D-022 | 2026-11-25 | Approved (founder) | No raw card numbers in HOS |
| D-023 | 2026-11-25 | Approved (founder) | OpenTofu and GitHub Actions |
| D-024 | 2026-11-25 | Approved (founder) | Lean, cost-conscious development environment |
| D-025 | 2026-11-25 | Approved (founder) | AWS-only infrastructure and spending policy |

---

### D-001: Name the unlabeled Control Plane tile
**Context:** The last tile in the Leptron Control Plane has no title. Its items read "Resource Monitoring" and "Business Insights".
**Decision:** The tile is named **"Resource Monitoring & Business Insights"**.
**Scope:** Leptron Control Plane only.

### D-002: Keep partially visible capabilities that can be read
**Context:** In the image, the last line of several modules is cut off but still readable.
**Decision:** These capabilities are part of the approved scope:
- Maintenance Management: **Preventive Maintenance**
- Housekeeping Management: **Productivity Reports**
- Inventory & Procurement: **Low Stock Alerts**

### D-003: Do not infer unreadable blueprint items
**Context:** Some blueprint text is cut off or too low-resolution to read.
**Decision:** The following are recorded as unresolved, and their content must not be guessed:
- the final item in Guest Journey stage 4. In-House Stay
- the final item in Reports & Analytics (BI)
- the unreadable capabilities of Control Plane Property Management

### D-004: Ignore garbled text in the Platform Foundation layer
**Context:** The Platform Foundation Layer's subtitle is garbled, and a stray character appears before "Event & Workflow Engine".
**Decision:** This garbled text and these stray characters are ignored. No requirement may be derived from them.

### D-005: External ecosystem dashed lines are conceptual
**Context:** The dashed lines from the External Ecosystem into the Business Layer do not clearly show which group connects to which module.
**Decision:** These lines are conceptual connections only. Which group connects to which module remains unresolved.

### D-006: Inter-row vertical arrows are conceptual
**Context:** The image draws vertical arrows between the operations, commercial and finance rows.
**Decision:** These arrows show conceptual relationships only. Their direction, event contracts and transaction semantics must be defined in engineering specifications, not guessed from the image.

### D-007: Finance & Accounting integration and ownership
**Decision:** Finance & Accounting integrates with the relevant operating modules through explicit API and event contracts. Financial ownership stays with the appropriate Finance & Accounting module.

### D-008: AI Workforce operating boundary
**Decision:** AI Workforce (Leptron AI) is an authorised intelligence and execution layer.
- Agents interact only through approved APIs, events and workflows.
- Agent actions are subject to permissions, audit trails and business-rule enforcement.
- Bypassing these through direct database access is prohibited.

### D-009: Two separate Billing & Invoicing domains
**Decision:** "Billing & Invoicing" names two separate domains:
1. **HOS hotel financial billing:** Finance & Accounting → Billing & Invoicing.
2. **Leptron SaaS subscription billing:** Leptron Control Plane → Billing & Invoicing.

### D-010: Two separate Inventory domains
**Decision:** "Inventory" names two separate domains:
1. **Room inventory and rates:** Inventory & Rate Engine.
2. **Physical stock and procurement inventory:** Inventory & Procurement.

### D-011: Payment Gateways to Payment Management contract
**Decision:** The External Ecosystem's Payment Gateways integrate with **Payment Management** through an explicitly documented integration contract. That contract is not defined yet (see U-008 in the open items).

### D-012: Regional provisioning driven by the Control Plane
**Context:** The founder approved an extra architectural requirement: centralized onboarding and automatic regional adaptation, so one HOS architecture can serve properties in many countries.

**Decision:**
1. **Centralized onboarding.** The Leptron Control Plane is the central authority for onboarding and provisioning HOS customers. Leptron administrators create organizations and properties, select each property's operating country, and configure its initial regional settings.
2. **Automatic regional adaptation.** When a property is provisioned, HOS applies the regional configuration for its country and jurisdiction. That configuration covers:
   - currency and locale defaults
   - time zone and date formats
   - tax and accounting configuration
   - which regional payment providers are available
   - country-specific integrations
   - applicable compliance capabilities
   - language and document formatting
3. **One architecture everywhere.** Every supported country runs the same application architecture, modules and core business logic. **Country selection changes configuration, not product architecture.**
4. **Multi-country organizations.** One organization may run properties in several countries. Each property has its own regional configuration, while governance and shared policies stay at organization level where appropriate. Properties in the same organization must not be assumed to share a country, currency, time zone or tax jurisdiction.
5. **No new product module.** Responsibility is split across existing approved domains as follows.

| Domain (from the blueprint) | Responsibility under D-012 |
|---|---|
| Leptron Control Plane: Customer Management, Property Management | Creates organizations and properties, selects country and jurisdiction, starts provisioning |
| Configuration & Settings: Property Configuration, System Settings, Localization (Multi-language) | Stores and applies organization and property configuration |
| Multi-Tenant Architecture: Configuration Management | Scopes configuration to the Organization → Property hierarchy |
| Security & Compliance: GDPR / Local Laws, Audit Logs | Permissions for configuration changes, regulatory controls, audit history |
| Integration Hub: API Connectors, Integration Logs & Health | Regional provider connections, eligibility, credential setup |

**Configuration levels:**

| Level | Owns |
|---|---|
| Organization | Governance and shared policies (for example, role and permission policy, and which settings properties may override). Organization settings do not fix any property's country, currency, time zone or tax jurisdiction. |

**Role and permission policy is only an example.** It is listed above as an example of organization-level governance. It is not an approved requirement for a customizable role-policy engine. HOS owns platform-wide RBAC, permission enforcement and security boundaries. Where organization-level policies are supported, they must operate within those boundaries and must not override platform security.
| Property | Country and jurisdiction; currency and locale; time zone and date formats; tax and accounting configuration; payment-provider availability; country-specific integrations; compliance capabilities; language and document formatting |

**Provisioning workflow (requirement level; the technical design belongs in engineering specifications):**
1. A Leptron administrator creates or selects the organization in the Control Plane.
2. The administrator creates the property and selects its country and jurisdiction.
3. HOS proposes the **published regional template version** for that jurisdiction.
4. The administrator reviews the initial regional settings and adjusts them only within the limits the template and organization policy allow.
5. **Validation before provisioning.** Provisioning is blocked until:
   - all required settings are complete
   - settings are consistent with the jurisdiction (for example, a valid currency, time zone and tax configuration)
   - a published template version exists
   - the required compliance capabilities are available
   - organization policy is satisfied
6. **Provisioning.** HOS creates the property configuration, recording the template version it was derived from.
7. **Activation.** The configuration becomes effective and is recorded in the audit history.
8. **Integrations.** Eligible regional integrations are listed but stay **inactive** (see Lifecycle, Integrations).

**Configuration lifecycle:**
- **Templates and versions.** Regional templates are kept per country and jurisdiction and are versioned. A published version cannot be changed; corrections are published as a new version. A new template version is not applied to existing properties automatically.
- **Validation.** The pre-provisioning validation also applies to every later configuration change.
- **Activation and audit.** Every activation and change records:
  - who made it, and when
  - the values before and after
  - the template version
  - the reason
- **Controlled changes.** Configuration changes require permission (through Security & Compliance), are validated, and record an effective date.
- **Historical financial records.** Financial records keep the regional values that applied when they were created, such as currency, tax rules and rates, and time zone. A later configuration change never recalculates or rewrites a posted or closed financial record.
- **Country or jurisdiction change.** This counts as a controlled change and must never alter historical financial records. How it is carried out is unresolved (U-016).
- **Integrations.** Country selection only determines which integrations a property is *eligible* for. An integration that needs credentials, a commercial agreement, provider approval or certification is **never activated automatically**. Each one needs its own explicit setup, a successful connection check, and an audited activation.

**Open items raised by this decision:** U-012 to U-020 in [UNRESOLVED_BLUEPRINT_DETAILS.md](blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md).

### D-013: Global scalability and capacity requirement
**Context:** The founder clarified that HOS must not impose arbitrary fixed capacity limits on customer operations.

**Decision:** HOS supports hotels and hotel groups according to their actual operational requirements, whatever the number of rooms, properties, users, departments, guests, reservations, transactions, documents or integrations. A small hotel and a large international hotel group use the same global HOS product architecture.

**Engineering requirements:**
1. **No hard-coded ceilings.** Application logic contains no hard-coded commercial or technical ceilings for rooms, properties, users, departments, guests or operational records.
2. **Large datasets.** The database design supports large datasets, with appropriate indexing, partitioning where justified, and efficient queries.
3. **Independent scaling.** Application services and background workers can scale independently where appropriate.
4. **Storage growth.** Storage and document management support growth without fixed storage assumptions in the application.
5. **Measured capacity management.** Capacity is managed from measured workload, resource monitoring and performance testing.
6. **Cells and dedicated infrastructure.** Regional cells and dedicated customer infrastructure may be introduced when workload, isolation, data residency or contractual requirements justify them.
7. **Safe scaling and migration.** Scaling and migration preserve tenant isolation, financial integrity, audit history and operational continuity.
8. **Commercial entitlements are separate.** The Leptron Control Plane may enforce entitlements a customer has explicitly purchased. These must be distinguishable from infrastructure and architectural capacity limits in data, enforcement and user-facing messages.
9. **Transparency.** HOS communicates capacity constraints and scaling requirements transparently. It does not silently reject legitimate business growth.

**What this decision does not claim:** HOS does not claim infinite capacity or unlimited performance. Measurable capacity targets come from load testing, service-level objectives (SLOs) and infrastructure sizing. Those targets are engineering and operational limits, not product restrictions, and they are reviewed as measured workload changes. No fixed hotel size, property count or room limit is assumed.

**Three kinds of limit:**

| Kind | Source | Example of how it is handled |
|---|---|---|
| Commercial entitlement | Explicitly purchased plan, enforced by the Control Plane | Shown to the customer as a plan limit, with an upgrade path |
| Operational capacity target | Load testing, SLOs, infrastructure sizing | Monitored; when approached, triggers a scaling action (vertical, horizontal, new cell or dedicated infrastructure) |
| Protective safeguard (e.g., per-request page size, API rate limit, upload size per request) | Abuse protection and system stability | Documented, configurable, and never a ceiling on total customer volume |

**Relationship to other decisions:**
- **D-012:** applies to all regional provisioning.
- **Global architecture and regional cell strategy:** the technical architecture review (2026-11-24) proposes a modular monolith, a separate Control Plane and cells starting with one cell. That proposal is **pending founder approval and is not yet recorded here.** When it is approved, it must satisfy D-013. In particular, a cell's capacity must be a measured, monitored target, and a tenant outgrowing a cell must be handled by scaling or migration, not rejection.

**Open items raised by this decision:** U-021 and U-022 in [UNRESOLVED_BLUEPRINT_DETAILS.md](blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md).

---

## Technical architecture decisions (D-014 to D-025)

The founder approved these on 2026-11-25. Design detail, plus recommendations that are **not** approved, is in [architecture/TECHNICAL_ARCHITECTURE.md](architecture/TECHNICAL_ARCHITECTURE.md). Where D-013 refers to the global architecture and cell strategy as "pending founder approval", those are now approved as D-014 and D-019. D-013 itself is unchanged.

### D-014: Modular monolith with a separate Control Plane
**Decision:** Hotel operations are built as a modular monolith: one codebase deployed as an API service and background workers. The Leptron Control Plane is a separate application with its own database.
**Constraints:**
- Each blueprint module owns its own data.
- Modules interact only through public interfaces and events (D-007, D-008).
- The API service and workers scale independently (D-013).

### D-015: TypeScript, NestJS, React and Vite
**Decision:** TypeScript is the primary language. The backend uses NestJS. Staff and admin frontends use React built with Vite.
**Not decided by this entry:** the guest application approach (PWA or native), and the framework for the public booking site.

### D-016: PostgreSQL on AWS RDS, standard features only
**Decision:** PostgreSQL hosted on Amazon RDS, using standard PostgreSQL features, so the data layer is not tied to one provider's proprietary extensions.
**Not decided by this entry:** instance sizing, Multi-AZ timing and actual spend (D-025).

### D-017: Shared database per cell with row-level security
**Decision:**
- Each cell uses one shared database for its tenants.
- All tenant data is tenant-scoped (organization, and property where applicable).
- PostgreSQL row-level security is a database-level isolation layer underneath application authorization.
- Automated isolation tests are mandatory.

**Constraints:**
- Department is a permission and assignment scope, not a data partition.
- Organization, property, legal entity and tax registration stay distinct concepts (U-015).

### D-018: Transactional outbox and SQS, at-least-once delivery
**Decision:**
- Domain events are written to a transactional outbox in the same transaction as the business change, then delivered through AWS SQS.
- Delivery is **at least once**. Every consumer processes events idempotently.
- The goal is exactly-once **business effects**. Delivery itself is never claimed to be exactly once.

**Constraint:** external side effects (payments, messages, channel updates) need provider idempotency keys where the provider supports them, or reconciliation where it doesn't.

### D-019: Regional cell architecture, starting with one cell
**Decision:**
- HOS runs as regional cells, each a full deployment of the same hotel-operations application, under one global Control Plane.
- Launch uses **one cell**.
- More cells or dedicated customer infrastructure are added only when D-013 justifies them (workload, isolation, data residency, contract).

**Not decided by this entry:** the initial production region (U-012, U-020).

### D-020: Strict Control Plane data allowlist
**Decision:**
- The Control Plane holds only allowlisted organization, property, subscription, entitlement, provisioning and aggregated telemetry data.
- **Hotel operational data and guest data stay in HOS cells.**
- The Control Plane provisions cells through a versioned provisioning API and never writes to a cell's database.

### D-021: Four identity realms; HOS owns authorization
**Decision:** There are four separate identity realms:
1. Leptron employees
2. hotel employees
3. guests
4. machines and AI agents

HOS owns authorization and RBAC. The identity provider only authenticates.

**Not decided by this entry:** which identity provider (see Open decisions in the architecture document).

### D-022: No raw card numbers in HOS
**Decision:** HOS does not store or process raw card numbers. Card data is handled by payment providers, through tokenization and hosted fields or redirects (D-011).

### D-023: OpenTofu and GitHub Actions
**Decision:** Infrastructure is defined as code with OpenTofu. CI/CD runs on GitHub Actions.
**Constraint:** CI usage must stay within D-025.

### D-024: Lean, cost-conscious development environment
**Decision:** The development environment is kept to the minimum needed for engineering and is cost-conscious by design. Engineering that doesn't need AWS runs locally or in CI.
**Constraint:** any AWS resource still requires approval under D-025.

### D-025: AWS-only infrastructure and spending policy
**Decision:**
- **AWS is the exclusive cloud infrastructure direction.** There is no Supabase infrastructure dependency.
- The available AWS credits are **USD 10,000**, and they are to be used carefully.
- **No additional out-of-pocket infrastructure spending** is allowed before a suitable client is secured, unless the founder separately approves it.
- After the credits are used up, infrastructure grows gradually, funded by customer revenue or separately approved funding.
- **No AWS resource may be created and no paid charge incurred without explicit founder approval.** This applies to every environment.
