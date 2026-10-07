// Passwords (Argon2id), login throttling, server-side sessions.
import argon2 from 'argon2';
import type { DB } from '../db/db.js';
import type { Config } from '../config.js';
import { clock, nowIso, randomToken, sha256Hex } from '../lib/core.js';
import { assignedBranches, audit, buildContext, type Ctx } from '../domain/context.js';
import type { Role } from './permissions.js';

// ---------- Passwords ----------
export const MIN_PASSWORD_LENGTH = 10;
export const hashPassword = (pw: string): Promise<string> => argon2.hash(pw, { type: argon2.argon2id });
// Used when the email is unknown, so response time does not reveal which accounts exist.
let dummyHash: Promise<string> | null = null;
export async function verifyPassword(hash: string | null, pw: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword('dummy-password-for-timing');
    await argon2.verify(await dummyHash, pw).catch(() => false);
    return false;
  }
  return argon2.verify(hash, pw).catch(() => false);
}

// ---------- Throttling ----------
export const THROTTLE = { windowMinutes: 15, maxPerAccount: 5, maxPerIp: 30 };

function recentFailures(db: DB, key: string): number {
  const since = new Date(clock.now().getTime() - THROTTLE.windowMinutes * 60_000).toISOString();
  const lastSuccess = db.prepare('SELECT MAX(at) FROM login_attempts WHERE key = ? AND success = 1').pluck().get(key) as string | null;
  const from = lastSuccess && lastSuccess > since ? lastSuccess : since;
  return db.prepare('SELECT COUNT(*) FROM login_attempts WHERE key = ? AND success = 0 AND at > ?').pluck().get(key, from) as number;
}

export function isThrottled(db: DB, email: string, ip: string): boolean {
  return (
    recentFailures(db, `email:${email.toLowerCase()}`) >= THROTTLE.maxPerAccount ||
    recentFailures(db, `ip:${ip}`) >= THROTTLE.maxPerIp
  );
}

function recordAttempt(db: DB, email: string, ip: string, success: boolean): void {
  const stmt = db.prepare('INSERT INTO login_attempts (key, at, success) VALUES (?, ?, ?)');
  stmt.run(`email:${email.toLowerCase()}`, nowIso(), success ? 1 : 0);
  stmt.run(`ip:${ip}`, nowIso(), success ? 1 : 0);
}

// ---------- Login ----------
export type LoginResult =
  | { ok: true; token: string; ctx: Ctx }
  | { ok: false; reason: 'invalid' | 'throttled' | 'no_branch' };

export async function login(db: DB, cfg: Config, email: string, password: string, ip: string): Promise<LoginResult> {
  email = email.trim().toLowerCase();
  if (isThrottled(db, email, ip)) {
    audit({ db, ip }, 'auth.login_throttled', 'user', '', { email_hash: sha256Hex(email).slice(0, 12) });
    return { ok: false, reason: 'throttled' };
  }
  const user = db.prepare('SELECT id, password_hash, is_active FROM users WHERE email = ?').get(email) as
    | { id: string; password_hash: string; is_active: number }
    | undefined;
  const okPw = await verifyPassword(user?.password_hash ?? null, password);
  if (!user || !okPw || !user.is_active) {
    recordAttempt(db, email, ip, false);
    audit({ db, ip, user: user ? { id: user.id } : null }, 'auth.login_failed', 'user', user?.id ?? '');
    return { ok: false, reason: 'invalid' };
  }
  // Pick the first active membership with an assigned branch. (Multi-org users switch afterwards.)
  const memberships = db
    .prepare('SELECT id, role, org_id FROM memberships WHERE user_id = ? AND is_active = 1 ORDER BY created_at')
    .all(user.id) as { id: string; role: Role; org_id: string }[];
  for (const m of memberships) {
    const branches = assignedBranches(db, m.id, m.role, m.org_id);
    if (!branches.length) continue;
    recordAttempt(db, email, ip, true);
    const token = createSession(db, cfg, user.id, m.id, branches[0]!);
    const ctx = buildContext(db, user.id, m.id, branches[0]!, ip)!;
    audit(ctx, 'auth.login', 'user', user.id);
    return { ok: true, token, ctx };
  }
  recordAttempt(db, email, ip, false);
  return { ok: false, reason: 'no_branch' };
}

// ---------- Sessions ----------
export interface SessionRow {
  token_hash: string;
  user_id: string;
  membership_id: string;
  branch_id: string;
  csrf_token: string;
  session_version: number;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

export function createSession(db: DB, cfg: Config, userId: string, membershipId: string, branchId: string): string {
  const token = randomToken(32);
  const now = clock.now();
  const version = db.prepare('SELECT session_version FROM users WHERE id = ?').pluck().get(userId) as number;
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, membership_id, branch_id, csrf_token, session_version, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sha256Hex(token), userId, membershipId, branchId, randomToken(24), version,
    now.toISOString(), now.toISOString(),
    new Date(now.getTime() + cfg.sessionAbsoluteHours * 3_600_000).toISOString(),
  );
  return token;
}

/** Validate a session token and build the context. Returns null (and deletes the session) if invalid. */
export function loadSession(db: DB, cfg: Config, token: string | undefined, ip: string): { session: SessionRow; ctx: Ctx } | null {
  if (!token || token.length > 100) return null;
  const hash = sha256Hex(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash) as SessionRow | undefined;
  if (!s) return null;
  const now = clock.now();
  const idleLimit = new Date(now.getTime() - cfg.sessionIdleMinutes * 60_000).toISOString();
  const userVersion = db.prepare('SELECT session_version FROM users WHERE id = ?').pluck().get(s.user_id) as number | undefined;
  const ctx = buildContext(db, s.user_id, s.membership_id, s.branch_id, ip);
  if (s.expires_at <= now.toISOString() || s.last_seen_at < idleLimit || userVersion !== s.session_version || !ctx) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  // Touch at most once a minute to avoid a write on every request.
  if (now.getTime() - Date.parse(s.last_seen_at) > 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now.toISOString(), hash);
  }
  return { session: s, ctx };
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
}

/** Switch the active branch, after checking the membership is assigned to it. */
export function switchBranch(ctx: Ctx, token: string, branchId: string): boolean {
  if (!ctx.assignedBranchIds.includes(branchId)) return false;
  ctx.db.prepare('UPDATE sessions SET branch_id = ? WHERE token_hash = ?').run(branchId, sha256Hex(token));
  audit({ ...ctx, branch: { id: branchId } }, 'auth.branch_switched', 'branch', branchId);
  return true;
}

/** Revoke all sessions for a user everywhere on this server (deactivation, password change). */
export function revokeUserSessions(db: DB, userId: string): void {
  db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
