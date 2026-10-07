# 03 — Data model

Source of truth: `src/db/migrations/001_init.sql` (branch server). This page explains it.

```
organizations ─┬─< branches ─┬─< branch_hours
               │             ├─< operatories (chairs)
               │             └─< sequences (per-branch number allocation)
               ├─< memberships >── users          (role per org; membership_branches = assigned branches)
               │        └─< dentist_schedules     (weekly working blocks per branch)
               ├─< services (catalog, price_minor)
               ├─< patients (org-wide identity, registered_branch_id)
               │      ├─< appointments ─< appointment_events (append-only history)
               │      └─< invoices ─< invoice_lines
               │              └─< payments ─< payment_reversals (append-only)
               └─< audit_events (append-only)
outbox_events (append-only sync queue) · sync_state · backup_runs · sessions · login_attempts · node_identity
```

## Ownership columns

| Table | `org_id` | `branch_id` | Owner for sync |
|---|---|---|---|
| patients | ✓ | `registered_branch_id` (informational) | Shared (org) |
| appointments, invoices, payments, payment_reversals, operatories, dentist_schedules | ✓ | ✓ | Branch |
| services, memberships | ✓ | — / via membership_branches | Organization |
| audit_events | ✓ | ✓ | Branch (uploaded for org audit in M2) |

## Key rules enforced by the database

* `appointments`: no two active (not cancelled/no-show) appointments overlap for the same dentist or the same chair at a branch.
* `invoices`: `total = subtotal − discount`; after issue, only a one-time transition to `void` (with reason, who, when) is allowed; issued invoices cannot be deleted; lines of non-draft invoices are frozen.
* `payments`: must reference an issued invoice of the same org/branch/patient; cannot exceed the outstanding balance; never updated or deleted.
* `payment_reversals`: one per payment, reason ≥ 5 characters, same org/branch, never updated or deleted.
* `invoices` cannot be voided while any unreversed payment exists.
* `audit_events`, `appointment_events`: append-only.

## Money and time

* Money: `INTEGER` minor units + `organizations.currency`. Formatting uses the currency's minor-unit digits.
* Time: UTC ISO-8601 strings; day boundaries for reports and calendars are computed in the **branch** timezone.

## Versioning

`patients.version` and `appointments.version` increase on each change and are used for optimistic concurrency (stale edits are rejected) and as `entity_version`/`base_version` in sync events.

## Planned additions

M2: `sync_conflicts`, `patient_merges`, cloud-side event store and read models, `organization_entitlements`. M3: `tooth_findings`, `treatment_plans`, `clinical_notes` + `clinical_note_amendments`, `consent_templates` (versioned), `consent_records`, `attachments` (content-addressed). M4: `stock_items`, `stock_movements`, `suppliers`, `batches`, `expenses`, `reminder_consents`.
