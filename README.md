# DentalSys

Branch-local dental clinic management with cloud coordination. Each clinic branch runs its own server on the clinic network, so registration, scheduling, billing and payments keep working during internet outages. A cloud service (Milestone 2) will synchronize branches and provide consolidated reports.

> **Status:** Milestone 1 — a working single-branch vertical slice for development and evaluation. **Not production-ready.** Synthetic data only. See [docs/09-scope-and-limitations.md](docs/09-scope-and-limitations.md).

## Requirements

* Node.js **22.12+** (tested on 22.16.0; see `.nvmrc`). No database server is needed: the branch database is SQLite, bundled via `better-sqlite3`.
* macOS, Linux or Windows 10/11 (Windows not yet tested — planned before pilot).

## Setup and run (development)

```bash
npm ci
```

```bash
cp .env.example .env
```

```bash
npm run seed:demo
```

```bash
npm run dev
```

Open http://127.0.0.1:8080 and sign in as `reception@demo.test` (other demo accounts: `owner`, `manager`, `dentist1`, `dentist2`, `reception2`, `inventory` @demo.test). The password is `DEMO_PASSWORD` in `.env`. To start again from scratch, stop the server and delete the `data/` folder.

## Checks

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run e2e
```

`npm test` runs the automated suite (tenant isolation, permissions, concurrent booking, billing rules, outbox atomicity, sessions, backup/restore, persistence). `npm run e2e` starts a real server process on a throwaway data folder and runs the full offline workflow, including a hard kill and restart.

## Backups

```bash
npm run backup
```

```bash
npm run restore -- data/backups/<file>.dsbak /path/to/new-empty-folder
```

Restore never overwrites existing data. Read [docs/07-backup-recovery.md](docs/07-backup-recovery.md) — especially the part about keeping a copy of the backup key.

## Documentation

| Doc | Contents |
|---|---|
| [00 Decisions & assumptions](docs/00-decisions-and-assumptions.md) | Defaults, stack decisions, open questions |
| [01 Product requirements](docs/01-product-requirements.md) | Users, scope, non-functional requirements |
| [02 Architecture](docs/02-architecture.md) | Branch/cloud design, stack, costs, connectivity states, offline login |
| [03 Data model](docs/03-data-model.md) | Tables, ownership, database-enforced rules |
| [04 Permissions](docs/04-permissions.md) | Role × permission matrix |
| [05 Sync & conflicts](docs/05-sync-and-conflicts.md) | Outbox, idempotency, cursors, conflict policy per record type |
| [06 Security](docs/06-security.md) | Controls implemented and required for production |
| [07 Backup & recovery](docs/07-backup-recovery.md) | Encryption, verification, restore procedure, key responsibilities |
| [08 Deployment & commercial](docs/08-deployment-and-commercial.md) | Installer/update plan, enrollment, entitlements, licensing proposal |
| [09 Scope & limitations](docs/09-scope-and-limitations.md) | What works, offline scope table, known gaps |
| [10 Online demo](docs/10-online-demo.md) | Hosting the synthetic-data demo on Render |

## Project layout

```
src/
  config.ts            environment configuration
  db/                  SQLite connection, migrations (SQL)
  auth/                passwords, sessions, throttling, permission codes
  domain/              business rules: patients, appointments, billing, reports, outbox, orgs
  backup/              encrypted backup + verified restore
  web/                 Fastify app, pages (server-rendered HTML)
  cli/                 migrate, seed, backup, restore, key generation
public/                CSS and a small progressive-enhancement script
test/                  automated tests (node:test)
scripts/               end-to-end workflow check
```
