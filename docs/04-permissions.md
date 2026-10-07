# 04 — Roles and permission matrix

Authorization is based on **explicit permission codes**. Roles are named bundles of permissions (defined in `src/auth/permissions.ts`, which is the source of truth — this table mirrors it and a test checks they agree). Custom per-organization roles are a later feature; the data model already stores the role on the membership so it can be extended.

## How a request is authorized

1. The session cookie identifies the **user** and the active **membership** (user ↔ organization) and **branch**.
2. On every request the server re-loads the membership and checks: user active, membership active, session version current, branch belongs to the membership's organization **and** is assigned to the membership (owners are implicitly assigned to all branches of their organization).
3. Domain functions check the permission code and that every record they touch has `org_id` = the session's organization (and the right branch where the permission is branch-scoped). A record ID from another organization is answered with **404 Not Found**, so IDs from other tenants are not even confirmed to exist.

Organization or branch IDs in URLs or form fields are **never trusted** as the source of scope.

## Scope

* **Branch-scoped** permissions apply to the active branch only (switching branch requires being assigned to it).
* **Org-scoped** permissions (`*.org`, `report.org.view`, `org.settings.manage`) apply across the organization.
* **Patients** are organization-wide identities. Viewing a patient's full record requires `patient.view` and that the patient is connected to one of your assigned branches (registered there, or has an appointment or invoice there) — or `patient.view.all_branches`. Search shows minimal fields only.

## Matrix (✓ = granted by default)

| Permission | Owner | Branch manager | Dentist | Receptionist | Inventory staff |
|---|:-:|:-:|:-:|:-:|:-:|
| `org.settings.manage` | ✓ | | | | |
| `branch.settings.manage` | ✓ | ✓ | | | |
| `staff.manage` | ✓ | ✓ | | | |
| `patient.view` | ✓ | ✓ | ✓ | ✓ | |
| `patient.view.all_branches` | ✓ | | | | |
| `patient.create` | ✓ | ✓ | ✓ | ✓ | |
| `patient.edit` | ✓ | ✓ | ✓ | ✓ | |
| `patient.medical.view` | ✓ | | ✓ | | |
| `patient.medical.edit` | | | ✓ | | |
| `patient.export` | ✓ | | | | |
| `patient.merge` (M2) | ✓ | ✓ | | | |
| `appointment.view` | ✓ | ✓ | ✓ | ✓ | |
| `appointment.manage` | ✓ | ✓ | ✓ | ✓ | |
| `schedule.manage` (chairs, working blocks) | ✓ | ✓ | | | |
| `billing.view` | ✓ | ✓ | ✓ | ✓ | |
| `invoice.draft` | ✓ | ✓ | ✓ | ✓ | |
| `invoice.issue` | ✓ | ✓ | | ✓ | |
| `invoice.void` | ✓ | ✓ | | | |
| `payment.record` | ✓ | ✓ | | ✓ | |
| `payment.reverse` | ✓ | ✓ | | | |
| `catalog.manage` | ✓ | ✓ | | | |
| `report.collections.view` | ✓ | ✓ | | ✓ | |
| `report.branch.view` | ✓ | ✓ | | | |
| `report.org.view` | ✓ | | | | |
| `audit.view` | ✓ | ✓ | | | |
| `backup.view` | ✓ | ✓ | | | |
| `backup.run` | ✓ | ✓ | | | |
| `clinical.view` (M3) | | | ✓ | | |
| `clinical.record` (M3) | | | ✓ | | |
| `inventory.view` / `inventory.manage` (M4) | ✓ | ✓ | | | ✓ |

### Notes on deliberate choices

* **Clinical vs financial are separate.** Dentists can draft invoices for work done but cannot issue, collect or reverse. Receptionists can collect payments but cannot see medical history. Inventory staff get nothing clinical or financial.
* **Owners do not get clinical record access by default.** An owner who is also a practising dentist should be given a second, dentist membership (planned: multiple roles per membership). This avoids business owners reading clinical notes by default.
* **Payment reversal and invoice void** require a manager or owner and a written reason; both are audited.
* `patient.medical.view` lets the holder see allergies, medications and medical history. Receptionists see only a "Has medical alerts" flag (yes/no) so they can alert the dentist without reading details.
