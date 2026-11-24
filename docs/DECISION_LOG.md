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
