# 11 — Cloud service and multi-branch setup (Milestone 2)

The cloud service connects the branches of each clinic organization. **Each branch still runs its own clinic server and keeps working without internet.** The cloud only:

* receives each branch's changes (patients, appointments, invoices, payments, staff, settings),
* keeps the shared patient record and flags conflicting edits,
* sends each branch what the other branches did,
* reports how fresh each branch's data is.

```
 Branch A server ──HTTPS (outbound only)──┐                 ┌── Branch B server
   SQLite, works offline                  ▼                 ▼   SQLite, works offline
                              DentalSys cloud (Render) ── Supabase PostgreSQL (Singapore)
```

## Try it locally first (no accounts needed)

Everything below also runs on this Mac with an embedded PostgreSQL (PGlite) instead of Supabase.

```bash
npm run demo:multibranch
```

This creates `demo-multibranch/` with a cloud database, branch A (the seeded demo clinic) connected as the first branch, and a fresh branch B that joined with a connection code. Then start the three servers, each in its own terminal tab:

```bash
CLOUD_DATA_DIR=demo-multibranch/cloud CLOUD_PORT=9090 npm run cloud:dev
```

```bash
DATA_DIR=demo-multibranch/a PORT=8080 SYNC_INTERVAL_SECONDS=5 npm run dev
```

```bash
DATA_DIR=demo-multibranch/b PORT=8081 SYNC_INTERVAL_SECONDS=5 npm run dev
```

Open branch A at **http://localhost:8080** and branch B at **http://127.0.0.1:8081**. Use different host names: browsers share sign-in cookies across ports on the same host name. Things to try:

* At B as `reception2@demo.test`: search "Santos" and book a patient who was registered at branch A.
* At A as `owner@demo.test`: open **Organization** to see both branches with freshness labels.
* Stop the cloud tab and watch the header change to "Cloud offline" while everything keeps working. Restart it and the queued changes go through.
* Edit the same patient's phone at both branches while the cloud is stopped, restart it, and review the conflict under **⚠ to review**.

Delete `demo-multibranch/` to start over.

## Production setup (you create the accounts; nothing is deployed without you)

### 1. Supabase (database)

1. Sign up at supabase.com → **New project**. Name `dentalsys`, region **Southeast Asia (Singapore)**, and a strong database password (store it in a password manager).
2. **Project Settings → Database → SSL Configuration → Download certificate** → save as `supabase-ca.crt`. Keep "Enforce SSL" on.
3. **Connect → Session pooler** → copy the connection string (`postgresql://postgres.<ref>:<password>@aws-…pooler.supabase.com:5432/postgres`).
4. Leave Supabase Auth, Storage and the public Data API unused. DentalSys connects only as a database client and enforces organization isolation itself. Under **Settings → API**, consider disabling the Data API so no table is reachable through Supabase's public REST endpoint.
5. Sign Supabase's **Data Processing Addendum** (Settings → Legal) before any real patient data, and record it in your privacy documentation.

Cost: the free plan works for testing (it pauses after a week of inactivity). For production use **Pro (about US$25/month)** for daily backups and no pausing. Check current pricing.

### 2. Render (cloud service)

1. Render → **New → Blueprint** → your `dentalsys` repository → **Blueprint path: `deploy/render-cloud.yaml`**.
2. Paste the Supabase connection string as `DATABASE_URL`.
3. In the service → **Environment → Secret Files** → add `supabase-ca.crt` with the certificate's contents.
4. Deploy. On first start the cloud creates its tables (`cloud_migrations` tracks them). Check `https://dentalsys-cloud-xxxx.onrender.com/health`.

Cost: Render Starter, about US$7/month (it must not sleep).

### 3. Connect the clinics

Connection codes are created by you (the DentalSys operator), from a computer with the database details:

```bash
DATABASE_URL='<supabase session pooler url>' DATABASE_CA_CERT_FILE=./supabase-ca.crt npm run cloud:admin -- invite-new-org
```

* **First branch of a clinic** (an existing server with its data): on that clinic server, run:

  ```bash
  npm run cloud:connect -- https://dentalsys-cloud-xxxx.onrender.com DS-XXXX-XXXX-XXXX
  ```

  It uploads the organization (staff, services, chairs, hours) and then its full history, in order.
* **Additional branch:** run `npm run cloud:admin -- list` to get the organization ID, then:

  ```bash
  npm run cloud:admin -- invite-branch <org-id> BGC "Branch name"
  ```

  On the new branch's **fresh** server, run `cloud:connect` with that code. Then set up the branch:

  ```bash
  npm run branch:admin -- add-chair "Chair 1"
  ```

  ```bash
  npm run branch:admin -- assign reception2@clinic.example
  ```

  ```bash
  npm run branch:admin -- dentist-hours dentist2@clinic.example 1-6 09:00 18:00
  ```

* Codes are single-use and expire after 72 hours. To retire a server (stolen or replaced): `npm run cloud:admin -- revoke-node <node-id>`.

## What synchronizes, and the rules

| Data | Who can change it | How differences are handled |
|---|---|---|
| Staff accounts, roles, branch assignments, services/prices, organization name | Any branch (staff with permission) | Last change received by the cloud wins. Deactivations end that person's sessions everywhere once they arrive |
| Branch profile, hours, chairs, dentist hours | That branch only | Single writer, no conflicts |
| Patient identity and details (incl. medical) | Any branch | Per-field merge. The same field changed differently at two branches becomes a **conflict to review**; nothing is overwritten silently |
| Appointments, invoices, payments, reversals | The branch that created them | Read-only copies elsewhere; the cloud rejects changes from other branches |

A clinic server only lets staff **work at its own branch**. Staff assigned to several branches see the others in reports (read-only) and work there on that branch's server.

Patients registered at another branch can be found by search (minimal details) and booked. Booking links the patient to this branch, which is recorded in the audit log, and then the full record can be opened.

## Security notes

* Clinic servers connect **out** to the cloud over HTTPS. No ports are opened at the clinic.
* Each server authenticates with its own secret (only a hash is stored in the cloud) and can be revoked.
* Password hashes (Argon2id) of staff are replicated to the organization's branches so staff can sign in offline at any of their branches. They never leave the organization.
* The cloud stores patient data for the organization (needed to share it between branches). Treat Supabase and Render as **data processors**: sign their DPAs, keep the Singapore region, restrict who has dashboard access, and enable 2FA on both accounts.
