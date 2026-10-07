// Branch-side synchronization: enrollment, upload of the outbox, download of changes.
// Network delivery is assumed to be at-least-once; both directions are idempotent.
import { APP_VERSION } from '../config.js';
import type { DB } from '../db/db.js';
import { tx } from '../db/db.js';
import { nowIso } from '../lib/core.js';
import { applyChange } from './apply.js';
import { orgSnapshot, insertOrgEntityEvent } from './org-entities.js';
import {
  MAX_UPLOAD_BATCH, PROTOCOL_HEADER, SUPPORTED_PROTOCOLS, type ChangesResponse, type EnrollRequest, type EnrollResponse,
  type EventResult, type WireEvent,
} from './protocol.js';

export type CloudState = 'not_configured' | 'online' | 'offline' | 'error' | 'update_required' | 'revoked';

export class CloudUnreachable extends Error {}
export class CloudHttpError extends Error {
  constructor(public readonly status: number, public readonly body: Record<string, unknown>) {
    super(String(body.message ?? body.error ?? `HTTP ${status}`));
  }
}

export interface SyncOptions {
  protocolVersion?: number; // tests: simulate an outdated/newer client
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** tests: throw after applying N changes of a page, to simulate a crash mid-download */
  failAfterApplying?: number;
}

// ---------- sync_state helpers ----------
export function getState(db: DB): Record<string, string> {
  return Object.fromEntries((db.prepare('SELECT key, value FROM sync_state').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
}
function setState(db: DB, values: Record<string, string | null>): void {
  const up = db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const del = db.prepare('DELETE FROM sync_state WHERE key = ?');
  for (const [k, v] of Object.entries(values)) v === null ? del.run(k) : up.run(k, v);
}

// ---------- HTTP ----------
async function call<T>(url: string, init: { method: string; body?: unknown; auth?: string }, o: SyncOptions = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(url, {
      method: init.method,
      signal: ctl.signal,
      headers: {
        [PROTOCOL_HEADER]: String(o.protocolVersion ?? SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1]),
        'x-dentalsys-app-version': APP_VERSION,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw new CloudUnreachable((e as Error).name === 'AbortError' ? 'Cloud did not respond in time' : 'Cannot reach the cloud service (internet or cloud unavailable)');
  } finally {
    clearTimeout(timer);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new CloudHttpError(res.status, body);
  return body as T;
}

// ---------- Enrollment ----------
/**
 * Connect this clinic server to the cloud with a one-time code.
 * - Existing server (has its organization): becomes the first branch of a new cloud organization.
 *   Its organization records are queued first, followed by all history already in the outbox.
 * - Fresh server: joins an existing organization as the branch the code was created for.
 */
export async function connectToCloud(db: DB, cloudUrl: string, code: string, o: SyncOptions = {}): Promise<EnrollResponse> {
  const url = cloudUrl.replace(/\/+$/, '');
  if (getState(db).cloud_configured === 'true') throw new Error('This server is already connected to the cloud.');
  const nodeId = db.prepare('SELECT id FROM node_identity').pluck().get() as string;
  const org = db.prepare('SELECT id, name FROM organizations ORDER BY created_at LIMIT 1').get() as { id: string; name: string } | undefined;
  const orgCount = db.prepare('SELECT COUNT(*) FROM organizations').pluck().get() as number;
  if (orgCount > 1) throw new Error('This server holds more than one organization; a branch server must hold exactly one.');
  const branch = org ? (db.prepare('SELECT id, code, name, timezone FROM branches WHERE org_id = ? ORDER BY created_at').all(org.id) as { id: string; code: string; name: string; timezone: string }[]) : [];
  if (branch.length > 1) throw new Error('This server holds more than one branch; connect each branch from its own server.');

  const req: EnrollRequest = { code, node_id: nodeId, app_version: APP_VERSION, ...(org ? { organization: org, branch: branch[0] } : {}) };
  const res = await call<EnrollResponse>(`${url}/sync/v1/enroll`, { method: 'POST', body: req }, o);

  tx(db, () => {
    if (res.kind === 'join_branch') {
      const og = res.organization as Record<string, unknown>;
      db.prepare(`INSERT INTO organizations (id, name, currency, default_timezone, date_format, tooth_numbering, created_at) VALUES (@id, @name, @currency, @default_timezone, @date_format, @tooth_numbering, @created_at)`).run(og);
      const b = res.branch!;
      db.prepare('INSERT INTO branches (id, org_id, code, name, timezone, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(b.id, res.org_id, b.code, b.name, b.timezone, nowIso());
      const ins = db.prepare('INSERT INTO branch_hours (branch_id, weekday, open_min, close_min) VALUES (?, ?, ?, ?)');
      for (const wd of [1, 2, 3, 4, 5, 6]) ins.run(b.id, wd, 9 * 60, 18 * 60);
    }
    setState(db, { cloud_url: url, node_secret: res.node_secret, org_id: res.org_id, branch_id: res.branch_id, cloud_configured: 'true', download_cursor: '0', cloud_state: 'online' });
    const ident = { orgId: res.org_id, branchId: res.branch_id, nodeId };
    if (res.kind === 'new_org') {
      // Nothing has ever been sent, so the queue can be re-ordered: organization records first,
      // then the existing history in its original order (same event IDs).
      backfillActors(db);
      const history = db.prepare('SELECT * FROM outbox_events ORDER BY seq').all() as Record<string, unknown>[];
      db.prepare('DELETE FROM outbox_events').run();
      for (const e of orgSnapshot(db, res.org_id)) insertOrgEntityEvent(db, ident, e.type, e.id, null);
      if (history.length) {
        const cols = Object.keys(history[0]!).filter((c) => c !== 'seq');
        const reinsert = db.prepare(`INSERT INTO outbox_events (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
        for (const h of history) reinsert.run(Object.fromEntries(cols.map((c) => [c, h[c]])));
      }
    } else {
      insertOrgEntityEvent(db, ident, 'branch', res.branch_id, null); // publish this branch's profile and hours
    }
  });
  return res;
}

/**
 * Events recorded before Milestone 2 have no actor; fill it from the records themselves so other
 * branches can attribute the replicated data (created_by etc.).
 */
function backfillActors(db: DB): void {
  const fill = (type: string, ops: string[], sql: string) =>
    db.prepare(`UPDATE outbox_events SET actor_user_id = (${sql}) WHERE actor_user_id IS NULL AND entity_type = ? AND op IN (${ops.map(() => '?').join(',')})`).run(type, ...ops);
  fill('patient', ['created'], 'SELECT created_by FROM patients WHERE id = outbox_events.entity_id');
  fill('patient', ['updated'], 'SELECT updated_by FROM patients WHERE id = outbox_events.entity_id');
  fill('appointment', ['created'], 'SELECT created_by FROM appointments WHERE id = outbox_events.entity_id');
  fill('appointment', ['status_changed', 'rescheduled'], 'SELECT updated_by FROM appointments WHERE id = outbox_events.entity_id');
  fill('invoice', ['issued'], 'SELECT issued_by FROM invoices WHERE id = outbox_events.entity_id');
  fill('invoice', ['voided'], 'SELECT voided_by FROM invoices WHERE id = outbox_events.entity_id');
  fill('payment', ['recorded'], 'SELECT received_by FROM payments WHERE id = outbox_events.entity_id');
  fill('payment', ['reversed'], 'SELECT reversed_by FROM payment_reversals WHERE payment_id = outbox_events.entity_id');
}

// ---------- One sync cycle ----------
export interface SyncResult { state: CloudState; uploaded: number; rejected: number; downloaded: number; error?: string }

export async function syncOnce(db: DB, o: SyncOptions = {}): Promise<SyncResult> {
  const st = getState(db);
  if (st.cloud_configured !== 'true') return { state: 'not_configured', uploaded: 0, rejected: 0, downloaded: 0 };
  const nodeId = db.prepare('SELECT id FROM node_identity').pluck().get() as string;
  const credential = `${nodeId}.${st.node_secret}`;
  const result: SyncResult = { state: 'online', uploaded: 0, rejected: 0, downloaded: 0 };
  setState(db, { last_attempt_at: nowIso() });
  try {
    // 1. Upload pending events in order.
    for (;;) {
      const rows = db.prepare(`SELECT * FROM outbox_events WHERE status IN ('pending','sent') ORDER BY seq LIMIT ?`).all(MAX_UPLOAD_BATCH) as Record<string, unknown>[];
      if (!rows.length) break;
      const events: WireEvent[] = rows.map((r) => ({
        id: String(r.id), org_id: String(r.org_id), branch_id: String(r.branch_id), node_id: String(r.node_id), seq: Number(r.seq),
        entity_type: String(r.entity_type), entity_id: String(r.entity_id), op: String(r.op),
        entity_version: (r.entity_version as number | null) ?? null, base_version: (r.base_version as number | null) ?? null,
        actor_user_id: (r.actor_user_id as string | null) ?? null, payload: JSON.parse(String(r.payload_json)),
        schema_version: Number(r.schema_version), app_version: String(r.app_version), created_at: String(r.created_at),
      }));
      db.prepare(`UPDATE outbox_events SET attempts = attempts + 1 WHERE seq IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.seq));
      const { results } = await call<{ results: EventResult[] }>(`${st.cloud_url}/sync/v1/events`, { method: 'POST', body: { events }, auth: credential }, o);
      // The acknowledgement is recorded durably; if this is lost, the resend is reported as a duplicate.
      tx(db, () => {
        const ack = db.prepare(`UPDATE outbox_events SET status = 'acked', acked_at = ?, last_error = NULL WHERE id = ?`);
        const fail = db.prepare(`UPDATE outbox_events SET status = 'failed', last_error = ? WHERE id = ?`);
        for (const r of results) {
          if (r.status === 'rejected') { fail.run(r.reason, r.id); result.rejected++; }
          else { ack.run(nowIso(), r.id); result.uploaded++; }
        }
      });
      setState(db, { last_upload_at: nowIso() });
      if (results.length < rows.length) throw new Error('Cloud acknowledged fewer events than sent');
    }

    // 2. Download changes, one transaction per page (changes + cursor together).
    for (let page = 0; page < 50; page++) {
      const cursor = getState(db).download_cursor ?? '0';
      const r = await call<ChangesResponse>(`${st.cloud_url}/sync/v1/changes?after=${encodeURIComponent(cursor)}`, { method: 'GET', auth: credential }, o);
      tx(db, () => {
        let n = 0;
        for (const c of r.changes) {
          applyChange(db, c);
          if (o.failAfterApplying !== undefined && ++n >= o.failAfterApplying) throw new Error('Simulated crash during download');
        }
        setState(db, { download_cursor: r.next_cursor });
        const up = db.prepare(`INSERT INTO remote_branch_status (branch_id, org_id, last_event_at, last_seen_at, app_version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(branch_id) DO UPDATE SET last_event_at = excluded.last_event_at, last_seen_at = excluded.last_seen_at, app_version = excluded.app_version, updated_at = excluded.updated_at`);
        for (const b of r.branches) up.run(b.branch_id, st.org_id, b.last_event_at, b.last_seen_at, b.app_version, nowIso());
      });
      result.downloaded += r.changes.length;
      setState(db, { last_download_at: nowIso() });
      if (!r.has_more) break;
    }
    setState(db, { cloud_state: 'online', last_success_at: nowIso(), last_error: null, offline_since: null });
    return result;
  } catch (e) {
    let state: CloudState = 'error';
    if (e instanceof CloudUnreachable) state = 'offline';
    else if (e instanceof CloudHttpError && e.status === 426) state = 'update_required';
    else if (e instanceof CloudHttpError && e.status === 401) state = 'revoked';
    const prev = getState(db);
    setState(db, { cloud_state: state, last_error: (e as Error).message.slice(0, 300), offline_since: prev.offline_since ?? nowIso() });
    return { ...result, state, error: (e as Error).message };
  }
}

/** Background loop with exponential backoff while the cloud is unavailable. */
export function startSyncLoop(db: DB, log: (m: string) => void, intervalSeconds = 15): { stop: () => void } {
  let stopped = false;
  let failures = 0;
  let timer: NodeJS.Timeout | null = null;
  const run = async () => {
    if (stopped) return;
    const r = await syncOnce(db).catch((e) => ({ state: 'error' as CloudState, error: (e as Error).message, uploaded: 0, rejected: 0, downloaded: 0 }));
    if (r.state === 'online') {
      if (failures) log('Cloud sync restored');
      failures = 0;
      if (r.uploaded || r.downloaded) log(`Sync: sent ${r.uploaded}, received ${r.downloaded}${r.rejected ? `, rejected ${r.rejected}` : ''}`);
    } else if (r.state !== 'not_configured') {
      failures++;
      if (failures === 1) log(`Cloud sync ${r.state}: ${r.error ?? ''}. Local work continues; changes are queued.`);
    }
    const delay = Math.min(intervalSeconds * 1000 * 2 ** Math.min(failures, 5), 5 * 60_000);
    if (!stopped) timer = setTimeout(run, delay);
  };
  timer = setTimeout(run, 1000);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
