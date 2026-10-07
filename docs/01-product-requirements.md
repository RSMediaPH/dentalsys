# 01 — Product requirements (summary)

**Product:** dental clinic management for small and medium independent clinics and multi-branch groups, sold per organization.

**Core promise:** a branch keeps working — registration, scheduling, billing, payments, daily collections — when the internet is down, and owners get consolidated, honestly-labelled reports when it is up.

## Users and top jobs

| User | Top jobs | Success looks like |
|---|---|---|
| Receptionist | Find/register patient, book and move appointments, issue invoice, take payment, close the day | Patient found in seconds; no double bookings; no double-recorded payments; drawer reconciles with the daily report |
| Dentist | See the day, read history and medical alerts, record treatment (M3), draft charges | Clinical record is readable, attributed, never silently changed |
| Branch manager | Oversee schedule and money, correct mistakes with a trail, backups | Every correction has who/when/why |
| Owner | Cross-branch view, settings, staff | Knows how fresh each branch's numbers are |
| Inventory staff | Stock (M4) | No access to clinical or financial data |

## Functional scope by milestone

The full list is in the original brief; delivery is tracked in `09-scope-and-limitations.md`. Milestone 1 delivers the workflow: **register patient → book appointment → issue invoice → record partial payment → see remaining balance → see daily collections**, offline, with audit, backup/restore and synthetic demo data.

## Non-functional requirements

* **Offline:** branch operations need only the branch server and LAN (see offline scope table).
* **Correctness of money:** integer minor units; append-only payments; idempotent submission; corrections by reversal/void with reason.
* **Isolation:** no data crosses organizations; branch scoping enforced server-side.
* **Durability:** committed work survives power loss (`synchronous=FULL`); verified encrypted backups.
* **Performance target:** patient search < 300 ms and page loads < 1 s on a typical clinic PC with 50,000 patients (to be load-tested in M5).
* **Usability:** keyboard-friendly forms, clear errors, visible connection/sync state, printable documents.
* **Honesty:** no fake testimonials, no unsupported claims (no "BIR-compliant", "HIPAA/DPA-compliant", "legal e-signature" or diagnostic claims without review).

## Out of scope (for now)

Automated diagnosis/treatment suggestions, X-ray device integration, card processing, public online booking, insurance/HMO claims, payroll, multi-language UI.
