# 00 — Decisions and assumptions

Status: **Milestone 0, agreed defaults** (2026-10-07). Change any of these by editing this file and noting the date.

## Working assumptions (from the product brief)

| Topic | Default | Configurable? |
|---|---|---|
| Customers | Small/medium independent dental clinics and multi-branch groups | — |
| Client devices | Desktop browsers on clinic computers (Chrome/Edge/Firefox, current versions) | — |
| Language | English | Later (strings are centralised in templates) |
| Currency | PHP, stored as integer centavos | Per organization |
| Timezone | Asia/Manila | Per organization default, per branch override |
| Date format | `yyyy-MM-dd` for input, `d MMM yyyy` for display | Per organization |
| Tooth numbering | FDI | Per organization (used from Milestone 3) |
| Branch topology | One designated **branch server** computer per branch; other devices use a browser over the clinic LAN | — |
| Internet | Needed only for cloud sync, cross-branch updates, remote access, cloud backup | — |
| Data | Synthetic only during development | — |
| Clinical decision support | None. No automated diagnosis, prescribing or treatment recommendations | — |

## Technical decisions

| # | Decision | Why (plain language) | Revisit when |
|---|---|---|---|
| D1 | **Node.js (LTS) + TypeScript + Fastify** for both the branch server and (Milestone 2) the cloud service, in one repository | One language end to end; Node has long-term-support releases, installs cleanly on Windows/macOS/Linux, and Fastify is a maintained, fast, well-documented web framework. Sharing code between branch and cloud keeps sync rules identical on both sides. | — |
| D2 | **SQLite (WAL mode, `synchronous=FULL`) as the branch database**, via `better-sqlite3` | A branch has ~2–30 concurrent users. SQLite is a single durable file, needs no separate database service, backs up with a built-in online-backup API, and all writes go through one server process so overlap checks are naturally serialized. This makes installation on a clinic PC far simpler and more reliable than running PostgreSQL there. | A single branch needs >~50 concurrent heavy users, or a customer insists on PostgreSQL |
| D3 | **PostgreSQL for the cloud service** (Milestone 2) | The cloud handles many organizations, concurrent ingestion and consolidated reporting — the workload PostgreSQL is built for. The cloud schema is an event store + read models, not a copy of the branch schema, so the dialect difference is contained. | — |
| D4 | **Server-rendered HTML** with small, local JavaScript files (no frontend framework, no CDN) | Pages work from the branch server over the LAN with zero internet; forms are naturally accessible and keyboard-friendly; far less code than a single-page app. "Offline" is the branch server's job, **not** browser caching. | We need rich interactive screens (tooth chart in M3 may add one small component) |
| D5 | **One modular application**, no microservices | Modules: auth, patients, scheduling, billing, reports, audit, sync, backup. Each has its own file(s) and enforces its own permissions. | — |
| D6 | **UUIDv7** for every record and event ID; human-readable numbers (patient no., invoice no.) allocated per branch from local sequences | Generated offline without collisions; UUIDv7 sorts roughly by time, which helps indexes. Branch code prefixes make human numbers unique org-wide without internet. | — |
| D7 | **Money as integer minor units** (centavos) + an org currency code | Avoids floating-point rounding errors. | Multi-currency per org (not planned) |
| D8 | **Append-only financial records** enforced by database triggers, not just application code | Issued invoices, payments and reversals cannot be edited or deleted, even by a bug. Corrections are new records (reversal, void with reason). | — |
| D9 | **Transactional outbox** written in the same SQLite transaction as each business change | Guarantees "the change happened" ⇔ "a sync event exists". Sync delivery itself is Milestone 2. | — |
| D10 | Passwords hashed with **Argon2id** (`argon2` package); sessions are opaque random tokens stored hashed in the database | Maintained, recommended algorithm; sessions can be revoked server-side immediately. | — |
| D11 | Backups: SQLite online backup + attachments → **AES-256-GCM encrypted archive** with a key file held by the clinic | Encrypted at rest, restorable into a clean directory, verifiable. | — |
| D13 | **Supabase used only as managed PostgreSQL** for the cloud (no Supabase Auth/Data API); PGlite for tests and local demos | Keeps the cloud portable to any PostgreSQL host; the same authorization code protects every organization; real PostgreSQL behaviour in tests without installing anything. | A feature needs Supabase-specific services |
| D14 | **Hosting on Render** (Singapore): online demo (`render.yaml`) and cloud service (`deploy/render-cloud.yaml`) | Simple dashboard setup, persistent disk for the demo, always-on service for sync. | Cost or region needs change |
| D12 | Exact-pinned npm dependencies + committed `package-lock.json`; Node version in `.nvmrc` | Reproducible installs. | Each release (dependency review) |

Tested with **Node 22.16.0** on macOS arm64. Node 22 leaves maintenance in April 2027; plan to move the supported runtime to **Node 24 LTS** before the pilot (Milestone 5) and re-run the full test suite on Windows 10/11, which is what most clinic PCs run.

## Open questions (defaults applied, answers welcome)

1. **Branch server operating system** — default: Windows 10/11 Pro PC (most common in clinics). Affects installer/service packaging in Milestone 5, not the code.
2. **Cloud hosting region/provider** — default: decide in Milestone 2; prefer a provider with a Singapore region for latency from the Philippines and a data-processing agreement. Nothing is deployed without your authorization.
3. **Overpayment / patient credit** — default for M1: a payment cannot exceed the invoice's outstanding balance (no patient credit balances). Credits/refunds come with credit notes later.
4. **Who may reverse a payment** — default: branch manager and owner only, reason required.
5. **Product name** — Name chosen: **DentalSys** (2026-10-07). No logo or brand assets yet; check trademark availability before launch.
