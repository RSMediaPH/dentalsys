// Review and resolution of synchronization conflicts detected by the cloud.
// A conflict means the same patient field was changed differently at two branches. Nothing was
// silently overwritten: the earlier value was kept and the other is shown here for a person to decide.
import { tx } from '../db/db.js';
import { conflict, forbidden, invalid, notFound, nowIso } from '../lib/core.js';
import { PATIENT_MEDICAL_FIELDS } from '../sync/protocol.js';
import { audit, can, requirePerm, type Ctx } from './context.js';
import { recordEvent } from './outbox.js';
import { getPatient, updatePatient } from './patients.js';

export interface ConflictView {
  id: string; entity_id: string; field: string; kept_value: string | null; incoming_value: string | null;
  incoming_branch: string | null; incoming_actor: string | null; detected_at: string; status: string;
  patient_name: string; patient_no: string; medical: boolean; values_hidden: boolean;
}

const isMedical = (f: string) => (PATIENT_MEDICAL_FIELDS as readonly string[]).includes(f);

export function listConflicts(ctx: Ctx, status: 'open' | 'resolved' = 'open'): ConflictView[] {
  requirePerm(ctx, 'patient.edit');
  const rows = ctx.db
    .prepare(`SELECT c.*, trim(p.first_name || ' ' || p.last_name) AS patient_name, p.patient_no, b.name AS incoming_branch, u.display_name AS incoming_actor
              FROM sync_conflicts c JOIN patients p ON p.id = c.entity_id
              LEFT JOIN branches b ON b.id = c.incoming_branch LEFT JOIN users u ON u.id = c.incoming_actor
              WHERE c.org_id = ? AND c.status = ? ORDER BY c.detected_at DESC LIMIT 200`)
    .all(ctx.org.id, status) as ConflictView[];
  return rows.map((r) => {
    const medical = isMedical(r.field);
    const hidden = medical && !can(ctx, 'patient.medical.view');
    return { ...r, medical, values_hidden: hidden, kept_value: hidden ? null : r.kept_value, incoming_value: hidden ? null : r.incoming_value };
  });
}

/** Keep the current value, or apply the other branch's value. Either way the decision is synced and audited. */
export function resolveConflict(ctx: Ctx, id: string, choice: string): void {
  requirePerm(ctx, 'patient.edit');
  if (choice !== 'keep' && choice !== 'incoming') throw invalid('Choose which value to keep.');
  const c = ctx.db.prepare('SELECT * FROM sync_conflicts WHERE id = ? AND org_id = ?').get(id, ctx.org.id) as
    | { id: string; entity_id: string; field: string; incoming_value: string | null; kept_value: string | null; status: string }
    | undefined;
  if (!c) throw notFound('Conflict');
  if (c.status !== 'open') throw conflict('ALREADY_RESOLVED', 'This conflict has already been resolved.');
  if (isMedical(c.field) && !can(ctx, 'patient.medical.edit')) throw forbidden();
  tx(ctx.db, () => {
    if (choice === 'incoming') {
      const p = getPatient(ctx, c.entity_id, { audit: false });
      updatePatient(ctx, c.entity_id, { ...p, [c.field]: c.incoming_value ?? '' }, p.version);
    }
    const resolution = choice === 'keep' ? `kept "${c.field}" as is` : `applied the other branch's "${c.field}"`;
    ctx.db.prepare(`UPDATE sync_conflicts SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?`).run(nowIso(), ctx.user.id, resolution, id);
    recordEvent(ctx, { entityType: 'conflict', entityId: id, op: 'resolved', payload: { resolution } });
    audit(ctx, 'sync.conflict_resolved', 'patient', c.entity_id, { field: c.field, choice });
  });
}
