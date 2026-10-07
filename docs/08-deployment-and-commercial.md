# 08 — Deployment plan and commercial foundation

## Branch server (target for pilot, Milestone 5)

* Windows installer (signed) that installs a pinned Node.js runtime + the app as a **Windows service**, creates `data/`, generates the backup key (and prompts the owner to save a copy), creates a local TLS certificate from a per-clinic private CA, and opens the port **on the LAN profile only**.
* Workstations open `https://clinic-server.local:8443` (or the fixed IP). The installer exports the CA certificate for workstation install.
* Updates: download signed package → automatic pre-update backup → stop service → migrate (forward-only migrations, each in a transaction) → start → health check. Rollback = reinstall previous version **and** restore the pre-update backup into a new folder (migrations are not reversed in place).
* Version compatibility: the database records applied migrations; an older app refuses to open a newer database. Sync protocol version is checked by the cloud (M2).

## Cloud service (Milestone 2)

* One container + managed PostgreSQL, Singapore region (proposal), private networking, automated backups, TLS.
* **Branch enrollment:** owner creates the branch in the cloud → one-time enrollment code → entered on the branch server → server registers its node ID and receives a long-lived credential (rotatable). Unenrolled servers cannot sync.
* Nothing is deployed publicly without your authorization.

## Commercial foundation

| Item | Plan |
|---|---|
| Customer separation | Every record carries `org_id`; isolation tested at domain and HTTP level; cloud enforces node ↔ org binding |
| Plans & entitlements | `organization_entitlements` (max branches, max staff, features) synced down; checked when *creating* new branches/staff, never when reading data |
| Support diagnostics | Export: app/schema version, OS, disk space, backup status, outbox counts, error codes — **no patient data** |
| Data export / offboarding | Owner-only full export (CSV/JSON + attachments) and an encrypted backup they keep; offboarding deletes cloud copies after a documented retention period, with written confirmation |
| Payment gateway | Deferred until the core product works |

## Proposed licensing / offline grace policy (for your decision — not implemented)

1. The branch server stores a **signed licence token** (organization, plan, expiry) refreshed whenever online.
2. **Grace period: 30 days** after the last successful licence check. Normal work continues; managers see a banner from day 14.
3. After grace or after non-payment: **restricted mode** — the branch can still sign in, view and print all records, export all data, run and restore backups, and record payments against existing invoices. Creating *new* patients/appointments is paused with a clear message.
4. The software **never deletes, encrypts or hides customer data** because of licensing or payment status, and support can issue an offline unlock code (e.g. for prolonged internet outages).

Please confirm or adjust the 30-day grace period and the restricted-mode rules before this is built.
