# 10 — Hosted online demo (Render)

A public, always-on DentalSys **demo** for testers. It runs the same software as a branch server, with:

* **Synthetic data only.** A "TEST SYSTEM — do not enter real patient information" banner is on every page.
* **Automatic reset every night at 03:00 Manila time.** Testers' changes are wiped and fresh demo data is loaded. The reset only runs when `DEMO_MODE=true` *and* the database contains only the demo organization, so it can never wipe real data.
* HTTPS (provided by Render), secure cookies, login throttling, and `noindex` so search engines don't list it.

> Never put real patient data in the demo. It is not a production deployment (see `09-scope-and-limitations.md`).

## Cost (check current prices on render.com)

Render **Starter** web service (~US$7/month) + 1 GB persistent disk (~US$0.25/month). The free plan cannot keep a disk, so testers' work would vanish whenever the service sleeps.

## One-time setup (you do these; nothing is deployed without you)

1. **GitHub account** — sign up at github.com (free) if you don't have one.
2. **Create a private repository** named `dentalsys` (no README, no .gitignore — the project has them).
3. **Push the code** from this folder (Claude can do this once the repository exists and you approve):
   ```bash
   git remote add origin https://github.com/<your-username>/dentalsys.git
   ```
   ```bash
   git push -u origin main
   ```
4. **Render account** — sign up at render.com with your GitHub account, add a payment method.
5. In Render: **New → Blueprint** → select the `dentalsys` repository. Render reads `render.yaml` and proposes the `dentalsys-demo` service in the Singapore region.
6. When asked for **`DEMO_PASSWORD`**, enter a new password (at least 10 characters) that you will share privately with testers. Don't reuse a personal password.
7. Click **Apply**. The first build takes a few minutes. Open the URL Render shows (`https://dentalsys-demo-xxxx.onrender.com`).

## Giving testers access

Share privately (not publicly): the URL, the demo password, and which account to use:

| Account | Role |
|---|---|
| `reception@demo.test`, `reception2@demo.test` | Receptionist |
| `dentist1@demo.test`, `dentist2@demo.test` | Dentist |
| `manager@demo.test` | Branch manager |
| `owner@demo.test` | Organization owner |
| `inventory@demo.test` | Inventory staff |

Remind testers that everything resets at 03:00 Manila time.

## Updating the demo

Every push to `main` redeploys automatically (`autoDeploy: true`). Data on the disk survives redeploys until the nightly reset.

## Turning it off

Render dashboard → `dentalsys-demo` → **Suspend** (stops billing for compute) or **Delete** (also deletes the disk and all demo data).
