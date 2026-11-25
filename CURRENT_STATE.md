# HOS Current State

**Last updated:** 2026-11-25
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
- **Remote:** https://github.com/Leptron-Inc/HOS (branch `main`)

## Approved decisions
| Range | Subject |
|---|---|
| D-001 – D-011 | Blueprint interpretation, domain separations, Finance, AI Workforce and payment contract rules |
| D-012 | Regional provisioning driven by the Control Plane |
| D-013 | Global scalability and capacity (no arbitrary capacity limits) |
| D-014 – D-024 | Technical architecture: modular monolith with separate Control Plane; TypeScript, NestJS, React, Vite; PostgreSQL on RDS; shared database per cell with row-level security; outbox with SQS; cells starting with one; Control Plane allowlist; four identity realms; no raw card numbers; OpenTofu and GitHub Actions; lean dev environment |
| D-025 | AWS-only infrastructure and spending policy |

The full text is in [docs/DECISION_LOG.md](docs/DECISION_LOG.md).

## Open decisions
- **Identity provider.** AWS Cognito is under evaluation: quotas, regional availability, authentication features and exit strategy.
- **Initial production region** (U-012, U-020).
- **Availability, recovery and capacity targets** (U-021).
- **OTA connectivity and payment gateways**, pending customer and market research.
- **Environment sizing and actual AWS spend**, pending budget verification and approval.
- **Blueprint and product open items** U-001 to U-022 in [UNRESOLVED_BLUEPRINT_DETAILS.md](docs/blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md).

## Infrastructure spending restrictions (D-025)
- AWS is the only cloud. No Supabase.
- Credits: USD 10,000; use them carefully. Their expiry date and exclusions are **not yet verified**.
- **No AWS resource may be created and no paid charge incurred without explicit founder approval.**
- No out-of-pocket infrastructure spending before a suitable client is secured, unless separately approved.
- After the credits are used up, infrastructure grows only from customer revenue or separately approved funding.
- CI must stay within the GitHub Actions free allowance unless spending is approved.

## Current engineering milestone
**Milestone 1, Platform Foundation:** **not started.**
- **Plan:** [TECHNICAL_ARCHITECTURE.md §15](docs/architecture/TECHNICAL_ARCHITECTURE.md#15-proposed-first-milestone-platform-foundation-not-started).
- **Steps 1–8** need no AWS resources.
- **Step 9** needs founder approval of AWS spending.

## Next tasks (each needs explicit authorization)
1. Write the four specifications required before coding:
   - architecture and module map;
   - tenancy and data conventions;
   - events and the outbox;
   - Control Plane–cell contract.
2. Founder review and approval of those specifications.
3. Milestone 1 steps 1–8, local and CI only.
4. Cognito verification, then a founder decision on the identity provider.
5. In parallel, commercial work: customer discovery to inform U-012, U-021, U-022, OTA and gateway choices.
