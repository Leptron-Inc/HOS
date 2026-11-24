# HOS Blueprint Interpretation

**Source of truth:** [HOS_MASTER_PRODUCT_ARCHITECTURE.png](HOS_MASTER_PRODUCT_ARCHITECTURE.png)
(HospitalityOS: End-to-End Product Architecture & Business Logic Map, "A Product of Leptron")

This document is a text transcription of the approved blueprint image, with the approved
interpretation decisions applied. It does not add, remove or redesign any module.

- If this document and the image disagree, the image wins, except where
  [DECISION_LOG.md](../DECISION_LOG.md) records an approved decision.
- Items marked **[UNRESOLVED]** are listed in
  [UNRESOLVED_BLUEPRINT_DETAILS.md](UNRESOLVED_BLUEPRINT_DETAILS.md). Do not build them until
  they are resolved.
- Items marked **[D-nnn]** come from an approved decision in [DECISION_LOG.md](../DECISION_LOG.md).
- Module and capability names keep the blueprint's original wording and spelling.

---

## 1. External Ecosystem

| Group | Systems shown |
|---|---|
| OTAs | Booking.com, Expedia, Agoda, MakeMyTrip, Airbnb, Other OTAs |
| GDS | Amadeus, Sabre, Travelport, Galileo, Other GDS |
| Direct Booking Engine | Website, Mobile, Call Center, Walk-in |
| Corporate / TMC | Companies, Travel Agents, Contracts |
| Payment Gateways | Razorpay, Stripe, PayPal, Cards / UPI |
| Communication Channels | Email, SMS, WhatsApp, Push, Voice |
| Hardware / Devices | Door Lock, Kiosk, POS, Wi-Fi, IoT Devices |
| Government / Compliance | GST, e-Filing, Local Laws, Police e-FRRO, Other |
| Other Integrations | Accounting, HRMS, CRM, ERP, BI Tools, Custom APIs |

- The dashed lines from the External Ecosystem into the Business Layer are conceptual
  connections only. Which group connects to which module is **[UNRESOLVED]** [D-005].
- Payment Gateways connect to **Payment Management** through an explicitly documented
  integration contract [D-011].

---

## 2. HospitalityOS Business Layer (Hotel Operations)

Subtitle: *Complete hotel operations, guest journey, financials, sales, marketing & intelligence.*

### 2.1 Core engines

| Module | Capabilities |
|---|---|
| Channel Manager | Inventory Sync (Push/Pull); Rate Sync; Availability Sync; Reservation Import; Mapping (Rate Plan / Room Type); Modifications & Cancellations; Overbooking Protection; Error Handling & Alerts |
| Inventory & Rate Engine | Room Inventory by Room Type; Rate Plans & Restrictions; Availability & Calculation; Min/Max Stay, CTA, Stop Sell; Yield Rules; Derived Inventory |
| Reservations Engine | Create/Modify/Cancel Reservation; Walk-in / Online / OTA / GDS; Group / Corporate / Package; Rate Plan & Policies; Deposit / Guarantee; Confirmation |
| CRM & Guest Profile | Guest 360° View; Stay History; Preferences; Requests; Communication History; Loyalty Profile; Corporate Profile |
| Communication Engine | Trigger Based Communication; Templates; Multi Channel (Email/SMS/WhatsApp/Push/Voice); Events (Booking, Pre-arrival, Check-in, etc.); Notifications & Alerts |

Connections drawn in the image:
- Two-way: Channel Manager ↔ Inventory & Rate Engine ↔ Reservations Engine ↔ CRM & Guest Profile ↔ Communication Engine.
- Dashed, two-way: Channel Manager ↔ 1. Booking, and Communication Engine ↔ 6. Post Stay.

**Inventory & Rate Engine** owns room inventory and rates. This is a separate domain from
the physical stock inventory in Inventory & Procurement [D-010].

### 2.2 Guest Journey & Property Operations Flow

The stages run in order: 1 → 2 → 3 → 4 → 5 → 6.

| Stage | Steps |
|---|---|
| 1. Booking | Search Availability; Rates & Packages; Guest Details; Add-ons; Payment (if any); Confirmation |
| 2. Pre-Arrival | Booking Confirmed; Pre-arrival Email; Upsell / Add-ons; ID Upload (Digital Check-in); Special Requests |
| 3. Arrival & Check-In | Arrival List; ID Verification; Registration; Room Assignment; Deposit / Payment; Check-in; Welcome Message |
| 4. In-House Stay | Stay Management; Room Charges; Service Requests; Housekeeping; Maintenance; F&B / POS; final item **[UNRESOLVED]** [D-003] |
| 5. Check-Out | Bill Review; Charges & Taxes; Payments; Invoice Generation; Checkout; Feedback Request |
| 6. Post Stay | Thank You Message; Feedback / Review; Loyalty Points; Marketing Campaigns; Guest Retention; Repeat Booking |

### 2.3 Property operations

| Module | Capabilities |
|---|---|
| Front Desk Operations | Dashboards (Arrivals/Departures/In-house); Walk-in Management; Room Assignment / Moves / Upgrades; Early Check-in / Late Check-out; Guest Registration; Billing & Folio Management |
| Housekeeping Management | Room Status Tracking; Task Generation (Checkout / Stayover / Deep Clean); Staff Assignment; Cleaning in Progress / Completed; Inspection; Lost & Found; Linen & Amenities; Productivity Reports [D-002] |
| Maintenance Management | Issue Reporting; Work Order Creation; Priority & SLA; Technician Assignment; Parts / Materials; Work Completion; Room Blocking / Release; Preventive Maintenance [D-002] |
| Engineering Assets | Asset Register; Asset Location; Warranty / AMC; Asset History; Utilization Tracking |
| Security Management | User Access Control; Door Lock Integration; CCTV Integration; Audit Logs; Incident Management |
| Guest Experience (Mobile App) | Pre Check-in / Digital Check-in; Room Info & Hotel Info; Service Requests; F&B Ordering; Housekeeping Requests; Chat / Concierge; Bill Review & Docking (exact transcription, pending visual verification, U-006) |

### 2.4 Commercial, outlets and intelligence

| Module | Capabilities |
|---|---|
| POS (F&B & Outlets) | Outlets (Restaurant/Bar/Cafe/Room Service); Menu & Items; Order Taking; Kitchen / KOT; Billing & Payment; Room Posting; Shift & Cash Management; POS Reports |
| Inventory & Procurement | Items & Categories; Recipes & BOM (for F&B); Suppliers; Purchase Orders; Goods Receipt; Stock Transfers; Stock Adjustment; Consumption / Issue; Wastage; Low Stock Alerts [D-002] |
| Banquets & Events | Leads / Enquiries; Event Spaces; Availability & Calendar; Proposals / Quotations; Contracts; Menu / Packages; Resources; Event Execution; Billing & Settlement |
| Revenue Management | Demand Forecasting; Competitor Rate Tracking; Dynamic Pricing; Rate Recommendations; Occupancy Based Pricing; ADR / RevPAR; Restrictions Management; Promotions |
| Payment Management | Payment Gateway Integration; Multi Currency; Payments (Online/Offline); Refunds; Payment Reconciliation; Tokenization / Security; Payment Logs |
| Loyalty Management | Membership & Tiers; Points Accrual; Redemption; Benefits; Expiry Management |
| Marketing & Campaigns | Segmentation; Campaign Creation; Multi Channel Send; Performance Tracking; Conversion to Booking |
| Reputation Management | Review Aggregation; Sentiment Analysis; Issue Alerts; Resolution Tracking; Guest Recovery |
| Reports & Analytics (BI) | Property Dashboard; Occupancy / ADR / RevPAR; Revenue Reports; F&B Reports; Housekeeping Reports; Maintenance Reports; Inventory Reports; Guest Reports; Custom Reports; final item **[UNRESOLVED]** [D-003] |

**Inventory & Procurement** owns physical stock and procurement inventory. This is a separate
domain from room inventory [D-010].

### 2.5 Finance & Accounting

| Module | Capabilities |
|---|---|
| Folio Management | Automatic Posting; Manual Posting; Adjustments; Transfer Posting; Folio Summary |
| Billing & Invoicing | Bill Generation; Taxes & Charges; Discounts; Invoice Formats; E-Invoicing |
| Accounts Receivable | Credit Management; Receivables; Statements; Payment Follow-up; Aging Analysis |
| Accounts Payable | Supplier Bills; Approvals; Payments; Aging Analysis; Reconciliation |
| General Ledger | Chart of Accounts; Journal Entries; Reconciliations; Period Closing; Financial Statements |
| Tax Management | GST / VAT / Other Taxes; Tax Mapping; Tax Calculation; Returns; Compliance |
| Payroll Management | Employee Master; Attendance; Salary Structure; Payroll Processing; Payslips / Reports |
| Expense Management | Expense Claims; Approvals; Reimbursements; Expense Reports |

- Finance & Accounting connects to the relevant operating modules through explicit API and
  event contracts. Financial ownership stays with the appropriate finance module [D-007].
- **Billing & Invoicing** here means HOS hotel financial billing. It is a separate domain from
  the Leptron Control Plane's Billing & Invoicing [D-009].

### 2.6 Relationships between the operations, commercial and finance rows

The image draws vertical arrows between these three rows. They are conceptual relationships
only. Their direction, event contracts and transaction semantics must be defined in
engineering specifications, not read off the image [D-006].

### 2.7 AI Workforce (Leptron AI)

| Group | Items |
|---|---|
| AI Agents | AI Concierge; AI Front Desk; AI Reservations; AI Housekeeping; AI Revenue; AI Sales; AI CRM; AI Support; AI Operations |
| Capabilities | Natural Language Interaction; Task Automation; Recommendations; Predictive Analytics; Anomaly Detection; Smart Alerts; Report Generation; Voice / Chat Interface |

AI Workforce is an authorised intelligence and execution layer. Agents act only through
approved APIs, events and workflows, and those actions are subject to permissions, audit
trails and business-rule enforcement. Agents must never bypass these by accessing the
database directly [D-008].

---

## 3. Platform Foundation Layer

The image's subtitle and some characters in this layer are garbled. They are ignored and are
not a source of requirements [D-004].

| Module | Capabilities |
|---|---|
| Multi-Tenant Architecture | Organization → Property → Department; Tenant Isolation; Data Partitioning; Configuration Management |
| Identity & Access Management | Authentication (SSO/MFA); RBAC & Permission Engine; Session Management; API Authorization; User/Role Management |
| Event & Workflow Engine | Event Bus; Workflow Automation; Task Scheduling; Approval Workflows; Business Rule Engine |
| Integration Hub | API Connectors; Webhooks; Data Mapping & Transformation; Retry / Idempotency; Sync & Reconciliation; Integration Logs & Health |
| Document Management | Guest IDs / Registration Cards; Invoices / Contracts; Templates & Digital Signatures; Storage & Versioning; Access Control |
| Observability & Monitoring | Application / API Health; Database / Queue / Workers; Integration Health; Logs / Metrics / Traces; Alerts & Incident Management |
| Security & Compliance | Data Encryption; Audit Logs; GDPR / Local Laws; Backup & Disaster Recovery; Vulnerability Management |
| Configuration & Settings | Property Configuration; System Settings; Feature Flags; Localization (Multi-language); Theme & Branding |

Regional configuration is per property, with organization-level governance and a defined
lifecycle. Configuration & Settings, Multi-Tenant Architecture, Security & Compliance and the
Integration Hub share this responsibility [D-012].

---

## 4. Leptron Control Plane (SaaS Operations)

Subtitle: *Manage all clients, properties, subscriptions, health & support.*

The text in this layer is small and low-resolution in the image. Items marked
**[UNRESOLVED]** could not be read reliably.

| Module | Capabilities |
|---|---|
| Customer Management | Organizations; Contracts; third item **[UNRESOLVED]** (U-004) |
| Property Management | Properties; Provisioning; remaining item(s) **[UNRESOLVED]** [D-003] |
| Subscription & Licensing | Plans & Modules; Subscriptions; Usage Tracking |
| Billing & Invoicing | Invoices; Payments; Outstanding |
| Platform Health | System Uptime; Service Health; Error Tracking |
| Support & Diagnostics | User Diagnostics; Log Inspection; Remote Support (Controlled) |
| Deployments & Versions | Release Management; Version Tracking; Feature Flags |
| Usage & Analytics | Customer Usage; Module Adoption; third item **[UNRESOLVED]** (U-005) |
| Resource Monitoring & Business Insights [D-001] | Resource Monitoring; Business Insights |

The Control Plane is the central authority for onboarding and provisioning organizations and
properties, including selecting each property's country and jurisdiction. Country selection
changes configuration, not product architecture [D-012].

**Billing & Invoicing** here means Leptron SaaS subscription billing. It is a separate domain
from HOS hotel financial billing [D-009].
