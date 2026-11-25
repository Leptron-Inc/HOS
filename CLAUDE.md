
# HOS BY LEPTRON — PROJECT INSTRUCTIONS

@PROJECT_RULES.md

## Authoritative Product Blueprint

The approved HOS architecture is located at:

docs/blueprint/HOS_MASTER_PRODUCT_ARCHITECTURE.png

Supporting documentation:
- docs/blueprint/BLUEPRINT_INTERPRETATION.md
- docs/blueprint/UNRESOLVED_BLUEPRINT_DETAILS.md
- docs/DECISION_LOG.md
- docs/architecture/TECHNICAL_ARCHITECTURE.md
- CURRENT_STATE.md

These references govern product scope and approved architectural decisions. In
TECHNICAL_ARCHITECTURE.md, only items labelled "Approved" are binding; "Recommended" items
are not approved.

## Infrastructure Spending

Never create AWS resources or incur paid charges without explicit founder approval (D-025).

## Mandatory Session Protocol

At the beginning of every development session:

1. Read and follow PROJECT_RULES.md.
2. Review the authoritative product blueprint.
3. Review relevant approved decisions.
4. Check CURRENT_STATE.md if it exists.
5. Identify the explicitly authorised task.

Never assume previous session context is available.

Never implement unresolved requirements without approval.

Never claim work is complete without verification.
