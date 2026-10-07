// Apply changes downloaded from the cloud to this branch's database.
// Called inside ONE transaction per downloaded page, together with the cursor update,
// so an interrupted download leaves nothing half-applied and is simply re-fetched.
// Every operation is idempotent (re-applying a change has no further effect).
import type { DB } from '../db/db.js';
import { normalizePhone, normalizeText, nowIso } from '../lib/core.js';
import { applyOrgEntity, isOrgEntityType } from './org-entities.js';
import { PATIENT_FIELDS, type WireChange } from './protocol.js';

type P = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

export class UnknownChangeError extends Error {}

function applyPatientState(db: DB, payload: P): void {
  const p = payload.patient as P;
  const cloudVersion = Number(payload.cloud_version);
  // Local edits not yet accepted by the cloud: leave the record alone; the cloud will send
  // a newer state after processing them (and report any conflict).
  const pending = db.prepare(`SELECT 1 FROM outbox_events WHERE entity_type = 'patient' AND entity_id = ? AND status IN ('pending','sent') LIMIT 1`).get(p.id);
  if (pending) return;
  const cur = db.prepare('SELECT cloud_version FROM patients WHERE id = ?').get(p.id) as { cloud_version: number } | undefined;
  if (cur && cur.cloud_version >= cloudVersion) return; // already have this or newer
  const fields = Object.fromEntries(PATIENT_FIELDS.map((f) => [f, String(p[f] ?? '')]));
  const name = [fields.first_name, fields.middle_name, fields.last_name].filter(Boolean).join(' ');
  const row = { ...fields, id: p.id, org_id: p.org_id, patient_no: p.patient_no, registered_branch_id: p.registered_branch_id,
    search_name: normalizeText(name), search_phone: normalizePhone(fields.phone ?? ''), cloud_version: cloudVersion,
    created_by: p.created_by, created_at: p.created_at, now: nowIso() };
  if (cur) {
    db.prepare(`UPDATE patients SET ${PATIENT_FIELDS.map((f) => `${f} = @${f}`).join(', ')}, search_name = @search_name, search_phone = @search_phone,
                  cloud_version = @cloud_version, version = version + 1, updated_at = @now, updated_by = COALESCE(updated_by, @created_by) WHERE id = @id`).run(row);
  } else {
    db.prepare(`INSERT INTO patients (id, org_id, patient_no, registered_branch_id, ${PATIENT_FIELDS.join(', ')}, search_name, search_phone, cloud_version,
                  created_at, created_by, updated_at, updated_by)
                VALUES (@id, @org_id, @patient_no, @registered_branch_id, ${PATIENT_FIELDS.map((f) => '@' + f).join(', ')}, @search_name, @search_phone, @cloud_version,
                  @created_at, @created_by, @now, @created_by)`).run(row);
  }
}

/** Read-only copies of another branch's appointments, invoices and payments. */
function applyBranchFact(db: DB, c: WireChange): void {
  const { op, data, actor_user_id: actor, entity_version: ver, created_at: at } = c.payload as { op: string; data: P; actor_user_id: string; entity_version: number; created_at: string };
  const id = c.entity_id;
  const branch = c.origin_branch_id;
  switch (`${c.entity_type}.${op}`) {
    case 'appointment.created':
      db.prepare(`INSERT OR IGNORE INTO appointments (id, org_id, branch_id, patient_id, dentist_membership_id, operatory_id, service_id, start_at, end_at, status, version, created_at, created_by, updated_at, updated_by)
                  SELECT ?, org_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM branches WHERE id = ?`)
        .run(id, branch, data.patient_id, data.dentist_id, data.operatory_id, s(data.service_id), data.start_at, data.end_at, data.status ?? 'scheduled', ver ?? 1, at, actor, at, actor, branch);
      return;
    case 'appointment.status_changed':
      db.prepare('UPDATE appointments SET status = ?, version = MAX(version, ?), updated_at = ?, updated_by = ? WHERE id = ? AND branch_id = ?').run(data.to, ver ?? 0, at, actor, id, branch);
      return;
    case 'appointment.rescheduled': {
      const to = data.to as P;
      db.prepare('UPDATE appointments SET start_at = ?, end_at = ?, dentist_membership_id = ?, operatory_id = ?, version = MAX(version, ?), updated_at = ?, updated_by = ? WHERE id = ? AND branch_id = ?')
        .run(to.start_at, to.end_at, to.dentist_id, to.operatory_id, ver ?? 0, at, actor, id, branch);
      return;
    }
    case 'invoice.issued': {
      if (db.prepare('SELECT 1 FROM invoices WHERE id = ?').get(id)) return;
      const org = db.prepare('SELECT org_id FROM branches WHERE id = ?').pluck().get(branch);
      db.prepare(`INSERT INTO invoices (id, org_id, branch_id, patient_id, dentist_membership_id, appointment_id, status, subtotal_minor, discount_minor, total_minor, created_at, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
        .run(id, org, branch, data.patient_id, s(data.dentist_membership_id), s(data.appointment_id), data.subtotal_minor, data.discount_minor, data.total_minor, at, actor);
      const ins = db.prepare(`INSERT INTO invoice_lines (id, invoice_id, service_id, description, quantity, unit_price_minor, discount_minor, line_total_minor, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      ((data.lines as P[]) ?? []).forEach((l, i) => ins.run(l.id, id, s(l.service_id), l.description, l.quantity, l.unit_price_minor, l.discount_minor, l.line_total_minor, i + 1));
      db.prepare(`UPDATE invoices SET status = 'issued', invoice_no = ?, issued_at = ?, issued_by = ? WHERE id = ?`).run(data.invoice_no, data.issued_at, actor, id);
      return;
    }
    case 'invoice.voided':
      db.prepare(`UPDATE invoices SET status = 'void', voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND status = 'issued'`).run(data.voided_at, actor, data.reason, id);
      return;
    case 'payment.recorded':
      db.prepare(`INSERT OR IGNORE INTO payments (id, org_id, branch_id, payment_no, invoice_id, patient_id, amount_minor, method, reference, received_at, received_by)
                  SELECT ?, org_id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM branches WHERE id = ?`)
        .run(id, branch, data.payment_no, data.invoice_id, data.patient_id, data.amount_minor, data.method, data.reference ?? '', data.received_at, actor, branch);
      return;
    case 'payment.reversed':
      db.prepare(`INSERT OR IGNORE INTO payment_reversals (id, org_id, branch_id, payment_id, reason, reversed_at, reversed_by)
                  SELECT ?, org_id, ?, ?, ?, ?, ? FROM branches WHERE id = ?`)
        .run(data.reversal_id, branch, id, data.reason, data.reversed_at, actor, branch);
      return;
    default:
      throw new UnknownChangeError(`Unknown change ${c.entity_type}.${op}`);
  }
}

export function applyChange(db: DB, c: WireChange): void {
  switch (c.kind) {
    case 'org.entity':
      if (!isOrgEntityType(c.entity_type)) throw new UnknownChangeError(`Unknown org record type ${c.entity_type}`);
      applyOrgEntity(db, c.entity_type, c.payload);
      return;
    case 'patient.state':
      applyPatientState(db, c.payload);
      return;
    case 'branch.fact':
      applyBranchFact(db, c);
      return;
    case 'conflict.opened': {
      const p = c.payload;
      const org = db.prepare('SELECT org_id FROM patients WHERE id = ?').pluck().get(c.entity_id) as string | undefined;
      db.prepare(`INSERT OR IGNORE INTO sync_conflicts (id, org_id, entity_type, entity_id, field, kept_value, incoming_value, incoming_branch, incoming_actor, detected_at, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
        .run(p.id, org ?? '', c.entity_type, c.entity_id, p.field, s(p.kept_value), s(p.incoming_value), s(p.incoming_branch_id), s(p.incoming_actor), p.detected_at);
      return;
    }
    case 'conflict.resolved':
      db.prepare(`UPDATE sync_conflicts SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?`)
        .run(c.payload.resolved_at, s(c.payload.resolved_by), s(c.payload.resolution), c.entity_id);
      return;
    default:
      // A newer cloud may send kinds this version does not understand: stop rather than skip data.
      throw new UnknownChangeError(`Unknown change kind ${(c as WireChange).kind}`);
  }
}
