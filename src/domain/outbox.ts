// Transactional outbox: every business change writes a sync event in the SAME transaction.
// Delivery to the cloud is Milestone 2; this guarantees nothing is lost or invented meanwhile.
import { APP_VERSION, EVENT_SCHEMA_VERSION } from '../config.js';
import type { DB } from '../db/db.js';
import { newId, nowIso } from '../lib/core.js';
import type { Ctx } from './context.js';

const nodeIds = new WeakMap<DB, string>();
export function nodeId(db: DB): string {
  let id = nodeIds.get(db);
  if (!id) {
    id = db.prepare('SELECT id FROM node_identity').pluck().get() as string;
    nodeIds.set(db, id);
  }
  return id;
}

export interface OutboxEventInput {
  entityType: string;
  entityId: string;
  op: string;
  entityVersion?: number | null;
  baseVersion?: number | null;
  payload: Record<string, unknown>;
}

/** Must be called inside the business transaction (asserted). */
export function recordEvent(ctx: Ctx, e: OutboxEventInput): string {
  if (!ctx.db.inTransaction) throw new Error('recordEvent must run inside the business transaction');
  const id = newId();
  ctx.db
    .prepare(
      `INSERT INTO outbox_events (id, org_id, branch_id, node_id, entity_type, entity_id, op, entity_version, base_version,
                                  payload_json, schema_version, app_version, created_at, actor_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, ctx.org.id, ctx.branch.id, nodeId(ctx.db), e.entityType, e.entityId, e.op,
      e.entityVersion ?? null, e.baseVersion ?? null, JSON.stringify(e.payload), EVENT_SCHEMA_VERSION, APP_VERSION, nowIso(), ctx.user.id,
    );
  return id;
}

export type CloudState = 'not_configured' | 'online' | 'offline' | 'error' | 'update_required' | 'revoked';

export interface SyncStatus {
  cloudConfigured: boolean;
  cloudState: CloudState;
  pending: number;
  failed: number;
  conflicts: number;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  offlineSince: string | null;
  lastError: string | null;
  cloudUrl: string | null;
}

export function syncStatus(db: DB): SyncStatus {
  const state = Object.fromEntries(
    (db.prepare('SELECT key, value FROM sync_state').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
  );
  const counts = db
    .prepare(`SELECT SUM(status IN ('pending','sent')) AS pending, SUM(status = 'failed') AS failed FROM outbox_events`)
    .get() as { pending: number | null; failed: number | null };
  const configured = state.cloud_configured === 'true';
  return {
    cloudConfigured: configured,
    cloudState: configured ? ((state.cloud_state as CloudState) ?? 'offline') : 'not_configured',
    pending: counts.pending ?? 0,
    failed: counts.failed ?? 0,
    conflicts: db.prepare(`SELECT COUNT(*) FROM sync_conflicts WHERE status = 'open'`).pluck().get() as number,
    lastSuccessAt: state.last_success_at ?? null,
    lastAttemptAt: state.last_attempt_at ?? null,
    offlineSince: state.offline_since ?? null,
    lastError: state.last_error ?? null,
    cloudUrl: state.cloud_url ?? null,
  };
}

/** Allocate the next number in a per-branch sequence (call inside a transaction). */
export function nextSequence(db: DB, branchId: string, kind: string): number {
  return db
    .prepare(
      `INSERT INTO sequences (branch_id, kind, next_value) VALUES (?, ?, 2)
       ON CONFLICT (branch_id, kind) DO UPDATE SET next_value = next_value + 1
       RETURNING next_value - 1`,
    )
    .pluck()
    .get(branchId, kind) as number;
}
