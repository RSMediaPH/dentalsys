# 09 — Scope, offline support and known limitations

## Milestone status

| Milestone | Status |
|---|---|
| 0 — Architecture and product decisions | **Done** (docs 00–09) |
| 1 — Single-branch vertical slice | **Done, development quality.** Not production-ready (see below) |
| 2 — Multi-branch and synchronization | **Done, development quality.** Cloud service + Supabase deployment files, enrollment, two-way sync, conflicts, consolidated report. Not production-ready |
| 3 — Clinical workflow | Not started |
| 4 — Inventory and operations | Not started |
| 5 — Release preparation | Not started |

## What works in Milestone 1

| Area | Implemented | Not yet |
|---|---|---|
| Accounts & access | Login (Argon2id), server-side sessions with idle/absolute expiry, CSRF, login throttling, 5 roles with explicit permissions, branch switching, local deactivation with immediate session revocation | Staff management UI, password reset UI, custom roles, 2FA |
| Organizations & branches | Data model with strict org/branch scoping; read-only settings page | Editing org/branch profile, hours, chairs, working blocks in the UI (done via provisioning/seed for now) |
| Patients | Registration, org-wide offline patient numbers, search with minimal result fields, duplicate suggestions (never auto-merge), profile, edit with stale-edit protection, medical fields restricted to clinical roles | Merge workflow (M2), export (M2), attachments (M3) |
| Appointments | Day (by chair) and week calendar, booking with branch hours + dentist blocks + overlap checks (transactional + DB trigger), statuses, reschedule with reason and history | Drag-and-drop, recurring appointments, reminders (M4), online booking (deferred) |
| Billing | Service catalog with prices, draft → issued invoices, line and invoice discounts, partial payments, idempotent payment entry, reversals with reason, voids, printable payment acknowledgement, patient account | Refunds/credit notes and patient credit balances, catalog editing UI, tax handling, paying another branch's invoice |
| Reports | Daily collections (received / reversals / net / by method / by dentist), charges issued, outstanding | Appointment & no-show report, expenses, low stock, consolidated org dashboard (M2/M4) |
| Audit | Append-only audit log for logins, record views, changes, financial actions; viewer for managers | Export, retention policy |
| Sync (M2) | Cloud service, one-time connection codes, upload/download with retries, shared patients, conflicts to review, organization report with freshness, revocation propagation, version gate | Patient merge, remote access via cloud, cloud backup copy, attachment sync, cloud admin web UI |
| Backup | Encrypted, test-restored backups (manual + daily schedule), retention, restore CLI into a clean directory, admin status page | Cloud backup copy (M2), restore UI |

## Supported offline scope

"Offline" means **the internet is down but the branch server and clinic network are up.**

| Function | Internet down | Branch server down / LAN down |
|---|---|---|
| Sign in / out | ✅ | ❌ |
| Register, search, edit patients registered or seen at this branch | ✅ | ❌ |
| Find and book patients registered at other branches | ✅ last-synced copy | ❌ |
| Book / reschedule / update appointments at this branch | ✅ | ❌ |
| Book at another branch | ❌ (requires that branch's server; deferred) | ❌ |
| Issue invoices, record payments and reversals at this branch | ✅ | ❌ |
| Pay another branch's invoice | ❌ (deferred) | ❌ |
| Daily collections for this branch | ✅ complete | ❌ |
| Organization-wide consolidated report | ⚠️ shows each branch as of its last sync, flagged "may be incomplete" | ❌ |
| Local backups | ✅ | ❌ |
| Cloud backup copy, remote access, permission changes from HQ | ❌ (queued until reconnect) | ❌ |

When the branch server or the LAN is down **nothing can be saved**; pages already open stay readable and show a red banner. This is by design (one source of truth per branch) and why the branch server needs a UPS and quick-restore procedure.

Disconnected branches cannot guarantee global schedule availability, and permission revocations made centrally cannot reach a disconnected branch until it reconnects (a local manager can deactivate an account immediately).

## Known limitations and risks (Milestone 1)

* **Multi-branch (M2):** other branches' data is only as fresh as the last sync. Staff/settings changes made at two branches at once: the last one received by the cloud wins. Branch setup (chairs, assignments, dentist hours) is CLI-only for now. Patient duplicates created at two branches while offline must be merged manually (merge workflow pending).
* **Not production-ready.** Needs: TLS on the LAN, installer/Windows service, staff/settings admin UI, security review, dentist and accountant review of workflows and wording, pilot testing.
* Only tested on macOS with Node 22.16. Windows testing is required before pilot.
* The live database file is not encrypted by the application; production relies on full-disk encryption (BitLocker) — see `06-security.md`.
* Branch hours and working blocks do not handle holidays or one-off closures yet.
* The calendar displays appointments in 15-minute rows; non-aligned times are shown in the nearest row with exact times in the label.
* Status changes are not time-gated (staff can mark a future appointment as arrived); intentional for flexibility, may need review.
* "Payment acknowledgement" is explicitly not an official receipt; BIR-compliant receipts/invoices require separate validation.
* No automated accessibility audit has been run yet; forms use labels, focus styles and keyboard navigation, but a WCAG review is pending.
