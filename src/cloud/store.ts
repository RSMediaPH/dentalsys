// Cloud coordination logic: enrollment, idempotent event ingestion with ownership checks,
// shared patient record with per-field conflict detection, and the per-organization change feed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import {
  isOrgEntityType, MAX_DOWNLOAD_PAGE, PATIENT_FIELDS, type BranchFreshness, type ChangeKind, type ChangesResponse, type EnrollRequest,
  type EnrollResponse, type EventResult, type WireChange, type WireEvent,
} from '../sync/protocol.js';
import type { Sql } from './sql.js';

export class CloudError extends Error {
  constructor(public readonly status: number, public readonly code: string, message = code) {
    super(message);
  }
}
/** A permanent, deterministic rejection of one event (stored, reported back, not retried). */
class Reject extends Error {}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- Migrations ----------
export async function migrateCloud(sql: Sql): Promise<string[]> {
  await sql.exec('CREATE TABLE IF NOT EXISTS cloud_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = path.join(PROJECT_ROOT, 'src', 'cloud', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const done = new Set((await sql.query<{ name: string }>('SELECT name FROM cloud_migrations')).map((r) => r.name));
  const unknown = [...done].filter((n) => !files.includes(n));
  if (unknown.length) throw new Error(`Cloud database is newer than this application (${unknown.join(', ')}).`);
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    await sql.transaction(async (q) => {
      await q.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      await q.query('INSERT INTO cloud_migrations (name) VALUES ($1)', [f]);
    });
    applied.push(f);
  }
  return applied;
}

// ---------- Invites & enrollment ----------
function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `DS-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
const normalizeCode = (c: string) => c.trim().toUpperCase();

export async function createInvite(
  sql: Sql,
  spec: { kind: 'new_org' } | { kind: 'join_branch'; orgId: string; branchCode: string; branchName: string; timezone?: string },
  validHours = 72,
): Promise<{ code: string; branchId?: string }> {
  const code = inviteCode();
  return sql.transaction(async (q) => {
    let orgId: string | null = null;
    let branchId: string | null = null;
    if (spec.kind === 'join_branch') {
      if (!(await q.query('SELECT 1 FROM organizations WHERE id = $1', [spec.orgId])).length) throw new CloudError(404, 'unknown_organization');
      if (!/^[A-Z][A-Z0-9]{1,5}$/.test(spec.branchCode)) throw new CloudError(422, 'invalid_branch_code', 'Branch code: 2–6 capital letters/digits, starting with a letter.');
      if ((await q.query('SELECT 1 FROM branches WHERE org_id = $1 AND code = $2', [spec.orgId, spec.branchCode])).length) throw new CloudError(409, 'branch_code_taken');
      orgId = spec.orgId;
      branchId = crypto.randomUUID();
      await q.query('INSERT INTO branches (id, org_id, code, name, timezone) VALUES ($1, $2, $3, $4, $5)', [branchId, orgId, spec.branchCode, spec.branchName, spec.timezone ?? 'Asia/Manila']);
      await q.query('INSERT INTO branch_status (branch_id, org_id) VALUES ($1, $2)', [branchId, orgId]);
    }
    await q.query(`INSERT INTO invites (code_hash, kind, org_id, branch_id, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))`,
      [sha256(normalizeCode(code)), spec.kind, orgId, branchId, validHours]);
    return { code, branchId: branchId ?? undefined };
  });
}

export async function enroll(sql: Sql, req: EnrollRequest): Promise<EnrollResponse> {
  if (!UUID.test(req.node_id ?? '')) throw new CloudError(422, 'invalid_node_id');
  return sql.transaction(async (q) => {
    const [inv] = await q.query<{ kind: 'new_org' | 'join_branch'; org_id: string | null; branch_id: string | null; used_at: string | null; expired: boolean }>(
      'SELECT kind, org_id, branch_id, used_at, expires_at < now() AS expired FROM invites WHERE code_hash = $1 FOR UPDATE', [sha256(normalizeCode(req.code ?? ''))]);
    if (!inv || inv.used_at || inv.expired) throw new CloudError(403, 'invalid_invite', 'This connection code is not valid, already used, or expired.');
    if ((await q.query('SELECT 1 FROM nodes WHERE id = $1', [req.node_id])).length) throw new CloudError(409, 'node_already_enrolled');

    let orgId: string;
    let branchId: string;
    let res: Partial<EnrollResponse> = {};
    if (inv.kind === 'new_org') {
      const o = req.organization;
      const b = req.branch;
      if (!o || !b || !UUID.test(o.id) || !UUID.test(b.id)) throw new CloudError(422, 'organization_required', 'This code connects an existing clinic server; it must already have its organization and branch.');
      if ((await q.query('SELECT 1 FROM organizations WHERE id = $1', [o.id])).length) throw new CloudError(409, 'organization_exists');
      await q.query('INSERT INTO organizations (id, name) VALUES ($1, $2)', [o.id, o.name]);
      await q.query('INSERT INTO branches (id, org_id, code, name, timezone) VALUES ($1, $2, $3, $4, $5)', [b.id, o.id, b.code, b.name, b.timezone]);
      await q.query('INSERT INTO branch_status (branch_id, org_id) VALUES ($1, $2)', [b.id, o.id]);
      orgId = o.id;
      branchId = b.id;
    } else {
      if (req.organization) throw new CloudError(409, 'server_has_data', 'This code adds a NEW branch and needs a fresh, empty clinic server.');
      orgId = inv.org_id!;
      branchId = inv.branch_id!;
      const [org] = await q.query<{ id: string; name: string; created_at: Date }>('SELECT id, name, created_at FROM organizations WHERE id = $1', [orgId]);
      const [ent] = await q.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM org_entities WHERE org_id = $1 AND entity_type = 'organization' AND entity_id = $1::text`, [orgId]);
      const [br] = await q.query<{ id: string; code: string; name: string; timezone: string }>('SELECT id, code, name, timezone FROM branches WHERE id = $1', [branchId]);
      res = {
        organization: ent?.payload ?? { id: org!.id, name: org!.name, currency: 'PHP', default_timezone: 'Asia/Manila', date_format: 'd MMM yyyy', tooth_numbering: 'FDI', created_at: new Date(org!.created_at).toISOString() },
        branch: br!,
      };
    }
    const secret = crypto.randomBytes(32).toString('base64url');
    await q.query('INSERT INTO nodes (id, org_id, branch_id, secret_hash, app_version) VALUES ($1, $2, $3, $4, $5)', [req.node_id, orgId, branchId, sha256(secret), req.app_version ?? '']);
    await q.query('UPDATE invites SET used_at = now(), used_by_node = $2 WHERE code_hash = $1', [sha256(normalizeCode(req.code)), req.node_id]);
    return { kind: inv.kind, node_secret: secret, org_id: orgId, branch_id: branchId, ...res };
  });
}

export interface NodeRow { id: string; org_id: string; branch_id: string }

/** Authorization: "Bearer <nodeId>.<secret>" */
export async function authenticateNode(sql: Sql, header: string | undefined, appVersion?: string): Promise<NodeRow> {
  const m = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]{20,})$/.exec(header ?? '');
  if (!m) throw new CloudError(401, 'unauthenticated');
  const [n] = await sql.query<NodeRow & { secret_hash: string; revoked_at: string | null }>('SELECT id, org_id, branch_id, secret_hash, revoked_at FROM nodes WHERE id = $1', [m[1]]);
  const given = Buffer.from(sha256(m[2]!));
  if (!n || n.revoked_at || !crypto.timingSafeEqual(given, Buffer.from(n.secret_hash))) throw new CloudError(401, 'unauthenticated', 'Unknown or revoked clinic server.');
  await sql.query('UPDATE nodes SET last_seen_at = now(), app_version = COALESCE($2, app_version) WHERE id = $1', [n.id, appVersion ?? null]);
  await sql.query('UPDATE branch_status SET last_seen_at = now(), app_version = COALESCE($2, app_version) WHERE branch_id = $1', [n.branch_id, appVersion ?? null]);
  return { id: n.id, org_id: n.org_id, branch_id: n.branch_id };
}

export async function revokeNode(sql: Sql, nodeId: string): Promise<boolean> {
  return (await sql.query('UPDATE nodes SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id', [nodeId])).length === 1;
}

// ---------- Ingestion ----------
async function addChange(q: Sql, orgId: string, originBranch: string | null, kind: ChangeKind, entityType: string, entityId: string, payload: unknown) {
  await q.query('INSERT INTO changes (org_id, origin_branch_id, kind, entity_type, entity_id, payload) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, originBranch, kind, entityType, entityId, JSON.stringify(payload)]);
}

async function claimOwner(q: Sql, node: NodeRow, type: string, id: string): Promise<void> {
  await q.query('INSERT INTO entity_owners (entity_type, entity_id, org_id, branch_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [type, id, node.org_id, node.branch_id]);
  await assertOwner(q, node, type, id);
}
async function assertOwner(q: Sql, node: NodeRow, type: string, id: string): Promise<void> {
  const [o] = await q.query<{ org_id: string; branch_id: string }>('SELECT org_id, branch_id FROM entity_owners WHERE entity_type = $1 AND entity_id = $2', [type, id]);
  if (!o) throw new Reject(`unknown ${type}`);
  if (o.org_id !== node.org_id || o.branch_id !== node.branch_id) throw new Reject(`${type} is owned by another branch`);
}
async function assertPatientInOrg(q: Sql, node: NodeRow, patientId: unknown) {
  if (typeof patientId !== 'string' || !(await q.query('SELECT 1 FROM patients WHERE id = $1 AND org_id = $2', [patientId, node.org_id])).length) {
    throw new Reject('unknown patient');
  }
}

const BRANCH_FACT_OPS: Record<string, { first: string; ops: string[]; patientOnFirst: boolean }> = {
  appointment: { first: 'created', ops: ['created', 'status_changed', 'rescheduled'], patientOnFirst: true },
  invoice: { first: 'issued', ops: ['issued', 'voided'], patientOnFirst: true },
  payment: { first: 'recorded', ops: ['recorded', 'reversed'], patientOnFirst: true },
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');

async function applyPatient(q: Sql, node: NodeRow, e: WireEvent): Promise<void> {
  const p = e.payload;
  if (e.op === 'created') {
    if ((await q.query('SELECT 1 FROM patients WHERE id = $1', [e.entity_id])).length) throw new Reject('patient already exists');
    if (p.registered_branch_id !== node.branch_id) throw new Reject('patient must be registered at the uploading branch');
    const fields = Object.fromEntries(PATIENT_FIELDS.map((f) => [f, String(p[f] ?? '')]));
    const versions = Object.fromEntries(PATIENT_FIELDS.map((f) => [f, 1]));
    const nodes = Object.fromEntries(PATIENT_FIELDS.map((f) => [f, node.id]));
    await q.query(`INSERT INTO patients (id, org_id, patient_no, registered_branch_id, fields, field_versions, field_nodes, version, created_by, created_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)`,
      [e.entity_id, node.org_id, String(p.patient_no), node.branch_id, JSON.stringify(fields), JSON.stringify(versions), JSON.stringify(nodes), e.actor_user_id, e.created_at]);
  } else if (e.op === 'updated') {
    const [row] = await q.query<{ fields: Record<string, string>; field_versions: Record<string, number>; field_nodes: Record<string, string>; version: number }>(
      'SELECT fields, field_versions, field_nodes, version FROM patients WHERE id = $1 AND org_id = $2 FOR UPDATE', [e.entity_id, node.org_id]);
    if (!row) throw new Reject('unknown patient');
    const base = Number(p.base_cloud_version ?? 0);
    const changes = (p.changes ?? {}) as Record<string, unknown>;
    const newVersion = row.version + 1;
    let applied = 0;
    for (const [f, incoming] of Object.entries(changes)) {
      if (!(PATIENT_FIELDS as readonly string[]).includes(f)) continue;
      const fv = row.field_versions[f] ?? 1;
      const changedElsewhere = fv > base && row.field_nodes[f] !== node.id;
      if (same(row.fields[f], incoming)) continue;
      if (changedElsewhere) {
        // Someone at another branch changed this field after this branch last synced: keep it, record a conflict.
        const id = crypto.randomUUID();
        await q.query(`INSERT INTO conflicts (id, org_id, entity_type, entity_id, field, kept_value, incoming_value, incoming_event_id, incoming_branch_id, incoming_actor, status)
                       VALUES ($1, $2, 'patient', $3, $4, $5, $6, $7, $8, $9, 'open')`,
          [id, node.org_id, e.entity_id, f, JSON.stringify(row.fields[f] ?? ''), JSON.stringify(incoming ?? ''), e.id, node.branch_id, e.actor_user_id]);
        await addChange(q, node.org_id, node.branch_id, 'conflict.opened', 'patient', e.entity_id, {
          id, field: f, kept_value: row.fields[f] ?? '', incoming_value: incoming ?? '', incoming_branch_id: node.branch_id, incoming_actor: e.actor_user_id, detected_at: new Date().toISOString(),
        });
        continue;
      }
      row.fields[f] = String(incoming ?? '');
      row.field_versions[f] = newVersion;
      row.field_nodes[f] = node.id;
      applied++;
    }
    if (applied) {
      await q.query('UPDATE patients SET fields = $2, field_versions = $3, field_nodes = $4, version = $5, updated_at = now() WHERE id = $1',
        [e.entity_id, JSON.stringify(row.fields), JSON.stringify(row.field_versions), JSON.stringify(row.field_nodes), newVersion]);
    }
  } else {
    throw new Reject(`unsupported patient operation ${e.op}`);
  }
  // Every patient event results in the authoritative state being distributed (including back to its origin).
  const [cur] = await q.query<{ fields: Record<string, string>; version: number; patient_no: string; registered_branch_id: string; created_by: string | null; created_at: Date }>(
    'SELECT fields, version, patient_no, registered_branch_id, created_by, created_at FROM patients WHERE id = $1', [e.entity_id]);
  await addChange(q, node.org_id, node.branch_id, 'patient.state', 'patient', e.entity_id, {
    patient: { ...cur!.fields, id: e.entity_id, org_id: node.org_id, patient_no: cur!.patient_no, registered_branch_id: cur!.registered_branch_id, created_by: cur!.created_by, created_at: new Date(cur!.created_at).toISOString() },
    cloud_version: cur!.version,
  });
}

async function applyEvent(q: Sql, node: NodeRow, e: WireEvent): Promise<void> {
  const p = e.payload;
  if (isOrgEntityType(e.entity_type)) {
    if (e.op !== 'upsert') throw new Reject('org records only support upsert');
    const t = e.entity_type;
    if (t === 'organization' && e.entity_id !== node.org_id) throw new Reject('organization mismatch');
    if (t !== 'organization' && t !== 'user' && p.org_id !== node.org_id) throw new Reject('organization mismatch');
    if (t === 'branch' && e.entity_id !== node.branch_id) throw new Reject('a branch can only update its own branch profile');
    if (t === 'operatory' || t === 'dentist_schedule') {
      if (p.branch_id !== node.branch_id) throw new Reject(`${t} belongs to another branch`);
      await claimOwner(q, node, t, e.entity_id);
    }
    if (t === 'membership') {
      // Branch assignments may only reference branches of this organization.
      const ids = (p.branch_ids as string[]) ?? [];
      if (ids.length) {
        const ok = await q.query('SELECT id FROM branches WHERE org_id = $1 AND id = ANY($2::uuid[])', [node.org_id, ids]);
        if (ok.length !== new Set(ids).size) throw new Reject('membership references unknown branches');
      }
    }
    if (t === 'branch') await q.query('UPDATE branches SET name = $2, timezone = $3 WHERE id = $1', [node.branch_id, String(p.name), String(p.timezone)]);
    if (t === 'organization') await q.query('UPDATE organizations SET name = $2 WHERE id = $1', [node.org_id, String(p.name)]);
    await q.query(`INSERT INTO org_entities (org_id, entity_type, entity_id, payload) VALUES ($1, $2, $3, $4)
                   ON CONFLICT (org_id, entity_type, entity_id) DO UPDATE SET payload = excluded.payload, updated_at = now()`, [node.org_id, t, e.entity_id, JSON.stringify(p)]);
    await addChange(q, node.org_id, node.branch_id, 'org.entity', t, e.entity_id, p);
    return;
  }
  if (e.entity_type === 'patient') return applyPatient(q, node, e);
  const spec = BRANCH_FACT_OPS[e.entity_type];
  if (spec) {
    if (!spec.ops.includes(e.op)) throw new Reject(`unsupported ${e.entity_type} operation ${e.op}`);
    if (e.op === spec.first) {
      if (spec.patientOnFirst) await assertPatientInOrg(q, node, p.patient_id);
      await claimOwner(q, node, e.entity_type, e.entity_id);
    } else {
      await assertOwner(q, node, e.entity_type, e.entity_id);
    }
    await addChange(q, node.org_id, node.branch_id, 'branch.fact', e.entity_type, e.entity_id, {
      op: e.op, data: p, actor_user_id: e.actor_user_id, entity_version: e.entity_version, created_at: e.created_at,
    });
    return;
  }
  if (e.entity_type === 'conflict' && e.op === 'resolved') {
    const [c] = await q.query<{ status: string }>('SELECT status FROM conflicts WHERE id = $1 AND org_id = $2 FOR UPDATE', [e.entity_id, node.org_id]);
    if (!c) throw new Reject('unknown conflict');
    if (c.status === 'open') {
      await q.query(`UPDATE conflicts SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution = $3 WHERE id = $1`, [e.entity_id, e.actor_user_id, String(p.resolution ?? '')]);
      await addChange(q, node.org_id, node.branch_id, 'conflict.resolved', 'conflict', e.entity_id, { resolved_by: e.actor_user_id, resolved_at: new Date().toISOString(), resolution: String(p.resolution ?? '') });
    }
    return;
  }
  throw new Reject(`unknown entity type ${e.entity_type}`);
}

function validateEnvelope(node: NodeRow, e: WireEvent): void {
  if (e.org_id !== node.org_id || e.branch_id !== node.branch_id || e.node_id !== node.id) throw new Reject('event does not belong to this clinic server');
  if (e.schema_version !== 1) throw new Reject(`unsupported schema version ${e.schema_version}`);
  if (typeof e.payload !== 'object' || e.payload === null) throw new Reject('invalid payload');
  if (typeof e.entity_id !== 'string' || !e.entity_id) throw new Reject('invalid entity id');
  if (e.actor_user_id !== null && !UUID.test(e.actor_user_id)) throw new Reject('invalid actor');
}

export async function ingestEvents(sql: Sql, node: NodeRow, events: WireEvent[]): Promise<EventResult[]> {
  const results: EventResult[] = [];
  for (const e of events) {
    if (!UUID.test(e?.id ?? '')) {
      results.push({ id: String(e?.id), status: 'rejected', reason: 'invalid event id' });
      continue;
    }
    try {
      results.push(await sql.transaction(async (q): Promise<EventResult> => {
        // Serialize writes per organization so change cursors become visible in order (no skipped changes).
        await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [node.org_id]);
        const [prev] = await q.query<{ org_id: string; status: string; reject_reason: string | null }>('SELECT org_id, status, reject_reason FROM events WHERE event_id = $1', [e.id]);
        if (prev) {
          if (prev.org_id !== node.org_id) return { id: e.id, status: 'rejected', reason: 'event id already used' };
          return prev.status === 'applied' ? { id: e.id, status: 'duplicate' } : { id: e.id, status: 'rejected', reason: prev.reject_reason ?? 'rejected' };
        }
        validateEnvelope(node, e);
        await applyEvent(q, node, e);
        await q.query(`INSERT INTO events (event_id, org_id, branch_id, node_id, seq, entity_type, entity_id, op, entity_version, base_version, actor_user_id, payload, schema_version, app_version, created_at_branch, status)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'applied')`,
          [e.id, node.org_id, node.branch_id, node.id, e.seq, e.entity_type, e.entity_id, e.op, e.entity_version, e.base_version, e.actor_user_id, JSON.stringify(e.payload), e.schema_version, e.app_version, e.created_at]);
        await q.query('UPDATE branch_status SET last_event_at = now(), last_seq = GREATEST(last_seq, $2) WHERE branch_id = $1', [node.branch_id, e.seq]);
        return { id: e.id, status: 'accepted' };
      }));
    } catch (err) {
      if (!(err instanceof Reject)) throw err;
      await sql.query(`INSERT INTO events (event_id, org_id, branch_id, node_id, seq, entity_type, entity_id, op, payload, schema_version, app_version, created_at_branch, status, reject_reason)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'rejected', $13) ON CONFLICT (event_id) DO NOTHING`,
        [e.id, node.org_id, node.branch_id, node.id, Number(e.seq) || 0, String(e.entity_type), String(e.entity_id), String(e.op), JSON.stringify(e.payload ?? {}), Number(e.schema_version) || 0, String(e.app_version ?? ''), e.created_at ?? new Date().toISOString(), err.message]);
      results.push({ id: e.id, status: 'rejected', reason: err.message });
    }
  }
  return results;
}

// ---------- Download ----------
const ALWAYS_SEND: ChangeKind[] = ['patient.state', 'conflict.opened', 'conflict.resolved'];

export async function getChanges(sql: Sql, node: NodeRow, after: string, limit = MAX_DOWNLOAD_PAGE): Promise<ChangesResponse> {
  const from = /^\d+$/.test(after) ? after : '0';
  const n = Math.min(Math.max(1, limit), MAX_DOWNLOAD_PAGE);
  const scanned = await sql.query<WireChange>(
    `SELECT cursor::text AS cursor, kind, entity_type, entity_id, origin_branch_id, payload FROM changes
     WHERE org_id = $1 AND changes.cursor > $2::bigint ORDER BY changes.cursor LIMIT $3 -- numeric order (not the text alias)`, [node.org_id, from, n]);
  const changes = scanned.filter((c) => c.origin_branch_id !== node.branch_id || ALWAYS_SEND.includes(c.kind));
  const branches = await sql.query<BranchFreshness>(
    `SELECT b.id AS branch_id, b.code, b.name, s.last_event_at, s.last_seen_at, s.app_version
     FROM branches b LEFT JOIN branch_status s ON s.branch_id = b.id WHERE b.org_id = $1 ORDER BY b.code`, [node.org_id]);
  await sql.query('UPDATE branch_status SET last_seen_at = now() WHERE branch_id = $1', [node.branch_id]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    changes,
    next_cursor: scanned.length ? scanned[scanned.length - 1]!.cursor : from,
    has_more: scanned.length === n,
    branches: branches.map((b) => ({ ...b, last_event_at: iso(b.last_event_at), last_seen_at: iso(b.last_seen_at) })),
    server_time: new Date().toISOString(),
  };
}

// ---------- Admin views ----------
export async function listOrganizations(sql: Sql) {
  return sql.query(`SELECT o.id, o.name, o.created_at,
      (SELECT json_agg(json_build_object('code', b.code, 'name', b.name, 'branch_id', b.id, 'last_event_at', s.last_event_at, 'last_seen_at', s.last_seen_at) ORDER BY b.code)
         FROM branches b LEFT JOIN branch_status s ON s.branch_id = b.id WHERE b.org_id = o.id) AS branches,
      (SELECT json_agg(json_build_object('node_id', n.id, 'branch_id', n.branch_id, 'last_seen_at', n.last_seen_at, 'revoked', n.revoked_at IS NOT NULL)) FROM nodes n WHERE n.org_id = o.id) AS nodes
    FROM organizations o ORDER BY o.created_at`);
}
