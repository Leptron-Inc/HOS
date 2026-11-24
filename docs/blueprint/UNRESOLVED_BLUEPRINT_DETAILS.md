# Unresolved Blueprint Details

This register lists details from [HOS_MASTER_PRODUCT_ARCHITECTURE.png](HOS_MASTER_PRODUCT_ARCHITECTURE.png)
that cannot be read reliably or are not defined. Under [PROJECT_RULES.md](../../PROJECT_RULES.md),
do not guess these or build them until each one is resolved by a recorded decision or an
approved specification.

| ID | Location | Unresolved detail | Basis | Status |
|---|---|---|---|---|
| U-001 | Guest Journey → 4. In-House Stay | Final item is cut off | D-003 | Open |
| U-002 | Reports & Analytics (BI) | Final item is cut off | D-003 | Open |
| U-003 | Leptron Control Plane → Property Management | Capabilities after "Properties; Provisioning" can't be read | D-003 | Open |
| U-004 | Leptron Control Plane → Customer Management | Third item can't be read | Transcription review | Open; do not infer |
| U-005 | Leptron Control Plane → Usage & Analytics | Third item can't be read | Transcription review | Open; do not infer |
| U-006 | Guest Experience (Mobile App) | Final item is transcribed exactly as "Bill Review & Docking" | Transcription review | Pending visual verification against the original image; do not reinterpret or rename |
| U-007 | External Ecosystem → Business Layer | Which external group connects to which module | D-005 | Open, define in specs |
| U-008 | Payment Gateways → Payment Management | The integration contract is not defined yet | D-011 | Open, define in specs |
| U-009 | Operations ↔ Commercial ↔ Finance rows | Direction, event contracts and transaction semantics | D-006 | Open, define in specs |
| U-010 | Finance & Accounting ↔ operating modules | API and event contracts are not defined yet | D-007 | Open, define in specs |
| U-011 | AI Workforce ↔ platform | The approved APIs, events, workflows and permission model for agents are not defined yet | D-008 | Open, define in specs |

## Notes
- U-004 and U-005 stay unresolved. Do not infer or create the missing capabilities.
- U-006 keeps the exact transcription "Bill Review & Docking" until it has been visually
  checked against the original image. Do not reinterpret or rename it.
- U-007 to U-011 are not unreadable text. They are engineering contracts that approved decisions
  require to be defined in specifications.
- Garbled text in the Platform Foundation layer is deliberately not listed here. It is ignored
  under D-004.
