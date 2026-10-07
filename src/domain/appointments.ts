// Branch-controlled appointment scheduling.
// Overlaps are prevented inside an IMMEDIATE transaction on the branch server, with a database trigger as a
// safety net. Each branch owns its own calendar; there is no cross-branch availability guarantee while offline.
import { DateTime } from 'luxon';
import { z } from 'zod';
import { tx } from '../db/db.js';
import { AppError, conflict, invalid, isUuid, newId, notFound, nowIso } from '../lib/core.js';
import { dayRangeUtc, localToUtcIso, minutesToHHMM, toLocal } from '../lib/time.js';
import { audit, mapDbError, requirePerm, type Ctx } from './context.js';
import { branchHours } from './orgs.js';
import { recordEvent } from './outbox.js';
import { getPatientSummary, isPatientConnected } from './patients.js';

export const STATUSES = ['scheduled', 'confirmed', 'arrived', 'in_progress', 'completed', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = (typeof STATUSES)[number];
export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  scheduled: 'Scheduled', confirmed: 'Confirmed', arrived: 'Arrived', in_progress: 'In progress',
  completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};
const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['arrived', 'cancelled', 'no_show'],
  arrived: ['in_progress', 'completed', 'cancelled'],
  in_progress: ['completed'],
  completed: [],
  cancelled: [],
  no_show: [],
};
export const allowedTransitions = (s: AppointmentStatus) => TRANSITIONS[s];
const RESCHEDULABLE: AppointmentStatus[] = ['scheduled', 'confirmed'];

export interface AppointmentRow {
  id: string; org_id: string; branch_id: string; patient_id: string; dentist_membership_id: string;
  operatory_id: string; service_id: string | null; start_at: string; end_at: string; status: AppointmentStatus;
  notes: string; version: number; created_at: string; updated_at: string;
}
export interface AppointmentView extends AppointmentRow {
  patient_name: string; patient_no: string; dentist_name: string; operatory_name: string; service_name: string | null;
}

export const bookingSchema = z.object({
  patient_id: z.string().refine(isUuid, 'Choose a patient'),
  dentist_id: z.string().refine(isUuid, 'Choose a dentist'),
  operatory_id: z.string().refine(isUuid, 'Choose a chair'),
  service_id: z.string().default('').refine((s) => s === '' || isUuid(s), 'Invalid procedure'),
  date: z.string(),
  time: z.string(),
  duration_min: z.coerce.number().int().min(5, 'At least 5 minutes').max(480, 'At most 8 hours'),
  notes: z.string().trim().max(500).default(''),
});
export type BookingInput = z.infer<typeof bookingSchema>;

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[String(i.path[0])] ??= i.message;
    throw invalid('Please correct the highlighted fields.', fields);
  }
  return r.data;
}

const VIEW_SQL = `
  SELECT a.*, trim(p.first_name || ' ' || p.last_name) AS patient_name, p.patient_no,
         u.display_name AS dentist_name, o.name AS operatory_name, s.name AS service_name
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
  JOIN memberships m ON m.id = a.dentist_membership_id JOIN users u ON u.id = m.user_id
  JOIN operatories o ON o.id = a.operatory_id
  LEFT JOIN services s ON s.id = a.service_id`;

export function listAppointments(ctx: Ctx, fromDate: string, days: number, filter: { dentistId?: string } = {}): AppointmentView[] {
  requirePerm(ctx, 'appointment.view');
  const [start] = dayRangeUtc(fromDate, ctx.branch.timezone);
  const end = DateTime.fromISO(start).plus({ days }).toUTC().toISO()!;
  const dentist = filter.dentistId && isUuid(filter.dentistId) ? filter.dentistId : null;
  return ctx.db
    .prepare(`${VIEW_SQL} WHERE a.branch_id = ? AND a.org_id = ? AND a.start_at < ? AND a.end_at > ?
              AND (? IS NULL OR a.dentist_membership_id = ?) ORDER BY a.start_at, o.name`)
    .all(ctx.branch.id, ctx.org.id, end, start, dentist, dentist) as AppointmentView[];
}

export function getAppointment(ctx: Ctx, id: string): AppointmentView {
  requirePerm(ctx, 'appointment.view');
  if (!isUuid(id)) throw notFound('Appointment');
  const a = ctx.db.prepare(`${VIEW_SQL} WHERE a.id = ? AND a.org_id = ? AND a.branch_id = ?`).get(id, ctx.org.id, ctx.branch.id) as AppointmentView | undefined;
  if (!a) throw notFound('Appointment');
  return a;
}

export function appointmentHistory(ctx: Ctx, id: string) {
  getAppointment(ctx, id);
  return ctx.db
    .prepare(`SELECT e.*, u.display_name AS actor FROM appointment_events e JOIN users u ON u.id = e.actor_user_id
              WHERE e.appointment_id = ? ORDER BY e.at`)
    .all(id) as { at: string; actor: string; kind: string; details_json: string; reason: string }[];
}

export function patientAppointments(ctx: Ctx, patientId: string): AppointmentView[] {
  requirePerm(ctx, 'appointment.view');
  return ctx.db
    .prepare(`${VIEW_SQL} WHERE a.patient_id = ? AND a.org_id = ? AND a.branch_id IN (${ctx.assignedBranchIds.map(() => '?').join(',')})
              ORDER BY a.start_at DESC LIMIT 100`)
    .all(patientId, ctx.org.id, ...ctx.assignedBranchIds) as AppointmentView[];
}

interface Slot { dentistId: string; operatoryId: string; startAt: string; endAt: string }

/** All business rules for a time slot, checked inside the write transaction. */
function assertSlotBookable(ctx: Ctx, slot: Slot, ignoreId: string | null): void {
  const dentist = ctx.db
    .prepare(`SELECT m.id FROM memberships m JOIN membership_branches mb ON mb.membership_id = m.id
              WHERE m.id = ? AND m.org_id = ? AND mb.branch_id = ? AND m.role = 'dentist' AND m.is_active = 1`)
    .get(slot.dentistId, ctx.org.id, ctx.branch.id);
  if (!dentist) throw invalid('Please correct the highlighted fields.', { dentist_id: 'This dentist does not work at this branch' });
  const chair = ctx.db.prepare('SELECT id FROM operatories WHERE id = ? AND branch_id = ? AND org_id = ? AND is_active = 1').get(slot.operatoryId, ctx.branch.id, ctx.org.id);
  if (!chair) throw invalid('Please correct the highlighted fields.', { operatory_id: 'This chair is not available at this branch' });

  const tz = ctx.branch.timezone;
  const s = toLocal(slot.startAt, tz);
  const e = toLocal(slot.endAt, tz);
  if (s.toISODate() !== e.minus({ milliseconds: 1 }).toISODate()) throw invalid('Appointments cannot run past midnight.', { duration_min: 'Too long' });
  const startMin = s.hour * 60 + s.minute;
  const endMin = startMin + Math.round(e.diff(s, 'minutes').minutes);

  const hours = branchHours(ctx.db, ctx.branch.id).get(s.weekday);
  if (!hours) throw invalid(`The branch is closed on ${s.toFormat('cccc')}.`, { date: 'Branch closed' });
  if (startMin < hours.open || endMin > hours.close) {
    throw invalid(`Outside branch hours (${minutesToHHMM(hours.open)}–${minutesToHHMM(hours.close)}).`, { time: 'Outside opening hours' });
  }
  const blocks = ctx.db
    .prepare('SELECT start_min, end_min FROM dentist_schedules WHERE branch_id = ? AND membership_id = ? AND weekday = ?')
    .all(ctx.branch.id, slot.dentistId, s.weekday) as { start_min: number; end_min: number }[];
  if (!blocks.some((b) => startMin >= b.start_min && endMin <= b.end_min)) {
    const desc = blocks.length ? blocks.map((b) => `${minutesToHHMM(b.start_min)}–${minutesToHHMM(b.end_min)}`).join(', ') : 'not scheduled this day';
    throw invalid(`The dentist is not working at that time (${s.toFormat('cccc')}: ${desc}).`, { time: 'Outside dentist working hours' });
  }

  const clash = ctx.db
    .prepare(
      `${VIEW_SQL} WHERE a.branch_id = ? AND a.status NOT IN ('cancelled','no_show') AND a.id <> ?
         AND (a.dentist_membership_id = ? OR a.operatory_id = ?) AND a.start_at < ? AND a.end_at > ? LIMIT 1`,
    )
    .get(ctx.branch.id, ignoreId ?? '', slot.dentistId, slot.operatoryId, slot.endAt, slot.startAt) as AppointmentView | undefined;
  if (clash) {
    const who = clash.dentist_membership_id === slot.dentistId ? `${clash.dentist_name} is` : `${clash.operatory_name} is`;
    throw conflict('APPOINTMENT_OVERLAP', `${who} already booked ${toLocal(clash.start_at, tz).toFormat('h:mm a')}–${toLocal(clash.end_at, tz).toFormat('h:mm a')}.`);
  }
}

export function bookAppointment(ctx: Ctx, raw: unknown): AppointmentRow {
  requirePerm(ctx, 'appointment.manage');
  const input = parse(bookingSchema, raw);
  getPatientSummary(ctx, input.patient_id); // any patient of this organization (404 for other orgs)
  const newlyLinked = !isPatientConnected(ctx, input.patient_id);
  if (input.service_id) {
    const svc = ctx.db.prepare('SELECT 1 FROM services WHERE id = ? AND org_id = ? AND is_active = 1').get(input.service_id, ctx.org.id);
    if (!svc) throw invalid('Please correct the highlighted fields.', { service_id: 'Unknown procedure' });
  }
  const startAt = localToUtcIso(input.date, input.time, ctx.branch.timezone);
  const endAt = DateTime.fromISO(startAt).plus({ minutes: input.duration_min }).toUTC().toISO()!;
  const id = newId();
  const now = nowIso();
  try {
    tx(ctx.db, () => {
      assertSlotBookable(ctx, { dentistId: input.dentist_id, operatoryId: input.operatory_id, startAt, endAt }, null);
      ctx.db
        .prepare(
          `INSERT INTO appointments (id, org_id, branch_id, patient_id, dentist_membership_id, operatory_id, service_id,
             start_at, end_at, status, notes, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?)`,
        )
        .run(id, ctx.org.id, ctx.branch.id, input.patient_id, input.dentist_id, input.operatory_id, input.service_id || null,
          startAt, endAt, input.notes, now, ctx.user.id, now, ctx.user.id);
      const details = { start_at: startAt, end_at: endAt, dentist_id: input.dentist_id, operatory_id: input.operatory_id };
      addEvent(ctx, id, 'created', details);
      recordEvent(ctx, { entityType: 'appointment', entityId: id, op: 'created', entityVersion: 1, payload: { ...details, patient_id: input.patient_id, service_id: input.service_id || null, status: 'scheduled' } });
      audit(ctx, 'appointment.create', 'appointment', id);
      if (newlyLinked) audit(ctx, 'patient.linked_to_branch', 'patient', input.patient_id, { via: 'appointment' });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapDbError(e);
  }
  return ctx.db.prepare('SELECT * FROM appointments WHERE id = ?').get(id) as AppointmentRow;
}

function addEvent(ctx: Ctx, appointmentId: string, kind: string, details: Record<string, unknown>, reason = ''): void {
  ctx.db
    .prepare('INSERT INTO appointment_events (id, appointment_id, org_id, at, actor_user_id, kind, details_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newId(), appointmentId, ctx.org.id, nowIso(), ctx.user.id, kind, JSON.stringify(details), reason);
}

export function changeStatus(ctx: Ctx, id: string, to: string, reason: string, baseVersion: number): void {
  requirePerm(ctx, 'appointment.manage');
  const a = getAppointment(ctx, id);
  if (!STATUSES.includes(to as AppointmentStatus)) throw invalid('Unknown status.');
  const target = to as AppointmentStatus;
  if (!TRANSITIONS[a.status].includes(target)) {
    throw conflict('INVALID_TRANSITION', `Cannot change from ${STATUS_LABELS[a.status]} to ${STATUS_LABELS[target]}.`);
  }
  if (target === 'cancelled' && reason.trim().length < 3) throw invalid('Please give a reason for cancelling.', { reason: 'Required' });
  try {
    tx(ctx.db, () => {
      const r = ctx.db
        .prepare('UPDATE appointments SET status = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
        .run(target, nowIso(), ctx.user.id, id, baseVersion);
      if (r.changes !== 1) throw conflict('STALE_EDIT', 'This appointment was changed by someone else. Reload and try again.');
      addEvent(ctx, id, 'status_changed', { from: a.status, to: target }, reason.trim());
      recordEvent(ctx, { entityType: 'appointment', entityId: id, op: 'status_changed', entityVersion: baseVersion + 1, baseVersion, payload: { from: a.status, to: target } });
      audit(ctx, 'appointment.status', 'appointment', id, { from: a.status, to: target });
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapDbError(e);
  }
}

export const rescheduleSchema = bookingSchema.pick({ dentist_id: true, operatory_id: true, date: true, time: true, duration_min: true }).extend({
  reason: z.string().trim().min(3, 'Please give a reason').max(300),
});

export function rescheduleAppointment(ctx: Ctx, id: string, raw: unknown, baseVersion: number): void {
  requirePerm(ctx, 'appointment.manage');
  const a = getAppointment(ctx, id);
  if (!RESCHEDULABLE.includes(a.status)) throw conflict('INVALID_TRANSITION', `A ${STATUS_LABELS[a.status].toLowerCase()} appointment cannot be rescheduled.`);
  const input = parse(rescheduleSchema, raw);
  const startAt = localToUtcIso(input.date, input.time, ctx.branch.timezone);
  const endAt = DateTime.fromISO(startAt).plus({ minutes: input.duration_min }).toUTC().toISO()!;
  try {
    tx(ctx.db, () => {
      assertSlotBookable(ctx, { dentistId: input.dentist_id, operatoryId: input.operatory_id, startAt, endAt }, id);
      const r = ctx.db
        .prepare(`UPDATE appointments SET start_at = ?, end_at = ?, dentist_membership_id = ?, operatory_id = ?,
                    version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`)
        .run(startAt, endAt, input.dentist_id, input.operatory_id, nowIso(), ctx.user.id, id, baseVersion);
      if (r.changes !== 1) throw conflict('STALE_EDIT', 'This appointment was changed by someone else. Reload and try again.');
      const details = {
        from: { start_at: a.start_at, end_at: a.end_at, dentist_id: a.dentist_membership_id, operatory_id: a.operatory_id },
        to: { start_at: startAt, end_at: endAt, dentist_id: input.dentist_id, operatory_id: input.operatory_id },
      };
      addEvent(ctx, id, 'rescheduled', details, input.reason);
      recordEvent(ctx, { entityType: 'appointment', entityId: id, op: 'rescheduled', entityVersion: baseVersion + 1, baseVersion, payload: details });
      audit(ctx, 'appointment.reschedule', 'appointment', id);
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapDbError(e);
  }
}
