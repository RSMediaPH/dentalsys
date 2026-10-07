# 02 — Architecture

## Shape of the system

```
            ┌──────────────────────── Cloud coordination service (Milestone 2) ───────────────────────┐
            │  Fastify API · PostgreSQL event store + read models · consolidated reports · enrollment │
            │  Never required for day-to-day branch work                                              │
            └───────────▲───────────────────────────────────────────────▲─────────────────────────────┘
                        │ HTTPS, outbound only (branch → cloud)          │
                        │ upload outbox / download by cursor             │
     ┌──────────────────┴───────────────────┐         ┌────────────────┴────────────────────┐
     │ Branch A server (clinic PC)          │         │ Branch B server                      │
     │  Node.js app + SQLite (WAL) + files  │         │  same software                        │
     │  outbox · audit · encrypted backups  │         │                                       │
     └──────▲───────────▲───────────▲───────┘         └───────────────────────────────────────┘
            │ LAN (HTTPS in production)
     ┌──────┴──┐  ┌─────┴───┐  ┌────┴────┐
     │Reception│  │Dentist  │  │Manager  │   Browsers only. No database on workstations.
     │ browser │  │ browser │  │ browser │
     └─────────┘  └─────────┘  └─────────┘
```

* **Each branch server is the source of truth for its own operational data**: its appointment calendar, the invoices and payments it issues, and (later) its stock movements and clinical records created there.
* **Workstations hold no writable database.** They are browsers pointed at `https://<branch-server>:<port>`. If the branch server is off, the branch cannot work — so the branch server needs a UPS and backups (see `07-backup-recovery.md`).
* **The cloud is a coordinator and aggregator.** It receives each branch's events, enforces organization boundaries, redistributes what other branches are allowed to see (shared patient identity, cross-branch history), and produces consolidated reports with freshness labels.
* **Connections are outbound only.** Branch servers call the cloud; the cloud never connects into a clinic. Branch servers are never exposed directly to the internet. Remote access (Milestone 2+) goes through the cloud, only where an owner explicitly enables it.

## Modules (one application)

| Module | Responsibility | Milestone |
|---|---|---|
| `auth` | Login, sessions, CSRF, throttling, permissions, branch switching | 1 |
| `orgs` | Organization, branches, hours, chairs, staff memberships | 1 (seeded; admin UI partial) |
| `patients` | Registration, search, duplicate suggestions, profile, medical alerts | 1 (merge: 2) |
| `scheduling` | Calendar, working blocks, overlap enforcement, status history | 1 |
| `billing` | Catalog, invoices, payments, reversals, voids, acknowledgements | 1 (refunds/credit notes: later) |
| `reports` | Daily collections, outstanding balances | 1 (others: 2/4) |
| `audit` | Append-only access and change log | 1 |
| `sync` | Outbox (1), sender/receiver, cursors, conflicts (2) | 1 → 2 |
| `backup` | Encrypted backups, restore into clean directory, verification | 1 |
| `clinical`, `consent`, `attachments` | Tooth chart, notes, amendments, consent, files | 3 |
| `inventory`, `expenses`, `reminders` | | 4 |

Each module's domain functions take a request context `{ user, membership, organization, branch, permissions }` resolved **on the server from the session** — never from IDs in the browser request — and check permissions themselves, so a route cannot forget to.

## Stack, installation requirements, costs

| Component | Choice | Licence / cost |
|---|---|---|
| Runtime | Node.js LTS (22 now, 24 before pilot) | Free (MIT) |
| Web framework | Fastify 5 | Free (MIT) |
| Branch DB | SQLite 3.5x via better-sqlite3 | Free (public domain / MIT) |
| Cloud DB | PostgreSQL 16+ (managed) | ~US$15–60/month at pilot scale on a managed provider |
| Cloud app hosting | One small container/VM | ~US$10–40/month at pilot scale |
| Password hashing | argon2 | Free (MIT) |
| Dates/timezones | Luxon | Free (MIT) |

**Branch server minimum (recommendation):** 64-bit Windows 10/11 Pro (or Linux/macOS), 4 CPU cores, 8 GB RAM, SSD with ≥50 GB free, wired Ethernet, a **UPS**, a second disk or USB drive for local backup copies, a fixed LAN IP or DHCP reservation. A normal office PC is enough; it must stay on during clinic hours and not sleep.

**Costs to you as a vendor before revenue:** essentially zero for development. Cloud costs start in Milestone 2 and only when you authorize a deployment. Code-signing certificates for a Windows installer (~US$200–500/year) are needed by Milestone 5.

## Key tradeoffs

* **SQLite on branch vs PostgreSQL on branch.** SQLite: trivial install, single file, excellent durability, fewer moving parts in a clinic with no IT staff. Cost: one writer at a time (fine at clinic scale — writes take milliseconds), and a different SQL dialect from the cloud. We accept this; branch and cloud schemas are deliberately different anyway.
* **Server-rendered pages vs single-page app.** Less interactivity per screen, but much less code, better accessibility by default, and no "the browser thinks it's offline but has stale data" class of bugs.
* **Branch-controlled scheduling.** Each branch owns its calendar, so overlap checks are exact and local. Cost: while a branch is disconnected, other branches and remote users cannot see or book its slots. No global availability guarantee is made during outages.
* **Branch-owned money.** A branch's invoices and payments are only ever written by that branch. Cost: paying branch A's invoice at branch B is deferred (needs online coordination).

## Connectivity states (what the user sees)

The header shows three separate indicators:

| Situation | How it is detected | What the user sees | What still works |
|---|---|---|---|
| **Internet / cloud unavailable** | Branch server's sync worker cannot reach the cloud (M2). In M1: cloud "not configured". | "Cloud: offline since 10:42 — 12 changes waiting to sync" | Everything in the offline scope (`09-scope-and-limitations.md`) |
| **Local server unavailable** | Browser polls `/api/status` every 10 s; request fails while the browser reports a network connection | Red banner: "Cannot reach the clinic server. Changes cannot be saved. Check that the server PC is on." | Nothing can be saved; the page stays visible for reference |
| **Local network unavailable** | Browser reports `navigator.onLine === false` (network cable/Wi-Fi down on this workstation) | Red banner: "This computer is not connected to the clinic network." | Nothing can be saved from this workstation |

Limitation: a browser cannot always tell "server PC is off" from "the switch between us failed"; both show as *server unreachable*. The banner gives the checks to try for both.

## Offline authentication

* Staff accounts, Argon2id password hashes and permissions are stored **in the branch database**. Login is checked locally; it never calls the cloud.
* In Milestone 2, account changes made centrally (new staff, password resets, **revocations**) are delivered to branches by sync. **A revocation made in the cloud cannot reach a disconnected branch until it reconnects.** Mitigations: a branch manager can deactivate an account locally (immediate); sessions expire after idle/absolute timeouts; the cloud flags any events a revoked user created after revocation for review.
* Sessions are server-side; deactivating a user or bumping their session version invalidates all their sessions on the next request.
