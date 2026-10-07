# 06 — Security and data protection

Technical controls support, but do not by themselves establish, compliance with the Philippine Data Privacy Act or any other regulation. A privacy/legal review is required before production use.

## Implemented in Milestone 1

| Control | Implementation |
|---|---|
| Password storage | Argon2id via the maintained `argon2` package; minimum length 10; constant-ish timing for unknown accounts |
| Login throttling | 5 failures per account / 30 per IP in 15 minutes → locked for the window; stored in the database, survives restarts |
| Sessions | 256-bit random token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` when TLS is on); only the SHA-256 hash is stored; idle timeout 60 min, absolute 12 h; revocable by bumping the user's `session_version` |
| Authorization | Server-side, permission-based, in the domain layer; scope always from the session; other-tenant IDs return 404 |
| CSRF | Per-session synchronizer token on every POST, pre-login token for the login form, Origin check |
| Web hardening | `@fastify/helmet`: strict Content-Security-Policy (no inline scripts, no third-party origins), `frame-ancestors 'none'`, `nosniff`, HSTS when TLS is on; all output HTML-escaped by default; request body limit 256 KB |
| Injection | All SQL uses bound parameters; dynamic SQL only assembles fixed column names |
| Data integrity | Database triggers make financial records and audit events append-only and block overlapping appointments |
| Audit | Logins (success/failure/throttle), patient record views (including whether medical details were shown), changes (field names only, not values), financial actions, backups, branch switches |
| Logging | Request logs contain method, path (no query string — search terms can be names) and IP; cookies redacted; no request bodies |
| Least privilege | Search results show minimal fields; medical fields stripped server-side for roles without `patient.medical.view` |

## Required for production (Milestone 5 checklist)

* **TLS on the LAN.** Serve HTTPS from the branch server with a certificate from a small private CA installed on clinic workstations (installer automates this), then set `COOKIE_SECURE=true`. Never expose the branch server port to the internet; the router should not forward it.
* **Encryption at rest.** Enable BitLocker (Windows Pro) or FileVault/LUKS on the branch server disk. Backups are already encrypted by the application (AES-256-GCM). Evaluate SQLCipher if customers cannot enable full-disk encryption.
* **Secrets.** The backup key and (M2) the branch enrollment secret live in files readable only by the service account; never in source control (`.gitignore` covers `data/`, `*.key`, `.env`).
* **Dependency review.** `npm audit` at each release, pinned versions, lockfile committed, review changelogs before upgrades.
* **Account lifecycle.** Staff admin UI with deactivation, forced password reset, review of dormant accounts.
* **Vendor access.** None by default. Support diagnostics (M5) export versions, counts, sync and backup status — no patient data. Any remote support session must be initiated and supervised by the clinic.

## Offline authentication and revocation

See `02-architecture.md#offline-authentication`. Summary: logins are checked against the branch database and never need the cloud; a manager can deactivate an account locally with immediate effect; revocations issued centrally only reach a branch when it is online.
