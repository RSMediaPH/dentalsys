// Patient registration, search, duplicate suggestions and profile.
import { z } from 'zod';
import { tx } from '../db/db.js';
import { AppError, conflict, invalid, isUuid, newId, normalizePhone, normalizeText, notFound, nowIso } from '../lib/core.js';
import { isValidDate } from '../lib/time.js';
import { audit, can, requirePerm, type Ctx } from './context.js';
import { nextSequence, recordEvent } from './outbox.js';
import { PATIENT_DEMOGRAPHIC_FIELDS, PATIENT_MEDICAL_FIELDS } from '../sync/protocol.js';

const text = (max: number) => z.string().trim().max(max).default('');
export const patientSchema = z.object({
  first_name: z.string().trim().min(1, 'First name is required').max(80),
  middle_name: text(80),
  last_name: z.string().trim().min(1, 'Last name is required').max(80),
  sex: z.enum(['', 'female', 'male', 'other']).default(''),
  date_of_birth: z.string().trim().refine(isValidDate, 'Enter date of birth as YYYY-MM-DD'),
  phone: text(40),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email or leave blank').max(120)]).default(''),
  address: text(300),
  emergency_contact_name: text(120),
  emergency_contact_phone: text(40),
  guardian_name: text(120),
  guardian_relationship: text(40),
  guardian_phone: text(40),
  allergies: text(2000),
  medications: text(2000),
  medical_history: text(4000),
});
export type PatientInput = z.infer<typeof patientSchema>;
const MEDICAL_FIELDS = PATIENT_MEDICAL_FIELDS;
const DEMOGRAPHIC_FIELDS = PATIENT_DEMOGRAPHIC_FIELDS;

export interface PatientRow extends PatientInput {
  id: string;
  org_id: string;
  patient_no: string;
  registered_branch_id: string;
  version: number;
  cloud_version: number;
  created_at: string;
  updated_at: string;
  merged_into_id: string | null;
}

/** What a search result may show: enough to pick the right person, nothing sensitive. */
export interface PatientSummary {
  id: string;
  patient_no: string;
  name: string;
  date_of_birth: string;
  phone_hint: string;
  branch_code: string;
}

export function parsePatient(input: unknown): PatientInput {
  const r = patientSchema.safeParse(input);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const i of r.error.issues) fields[String(i.path[0])] ??= i.message;
    throw invalid('Please correct the highlighted fields.', fields);
  }
  if (r.data.date_of_birth > new Date().toISOString().slice(0, 10)) {
    throw invalid('Please correct the highlighted fields.', { date_of_birth: 'Date of birth cannot be in the future' });
  }
  return r.data;
}

const fullName = (p: { first_name: string; middle_name: string; last_name: string }) =>
  [p.first_name, p.middle_name, p.last_name].filter(Boolean).join(' ');
const phoneHint = (phone: string) => (normalizePhone(phone).length >= 4 ? `•••${normalizePhone(phone).slice(-4)}` : '');

function toSummary(r: PatientRow & { branch_code: string }): PatientSummary {
  return { id: r.id, patient_no: r.patient_no, name: fullName(r), date_of_birth: r.date_of_birth, phone_hint: phoneHint(r.phone), branch_code: r.branch_code };
}

/**
 * Possible duplicates: same date of birth + similar name, or same phone, or same email.
 * These are suggestions only. Nothing is ever merged automatically.
 */
export function findDuplicateCandidates(ctx: Ctx, p: Pick<PatientInput, 'first_name' | 'last_name' | 'date_of_birth' | 'phone' | 'email'>, excludeId?: string): PatientSummary[] {
  const last = normalizeText(p.last_name);
  const first = normalizeText(p.first_name).split(' ')[0] ?? '';
  const phone = normalizePhone(p.phone);
  const rows = ctx.db
    .prepare(
      `SELECT p.*, b.code AS branch_code FROM patients p JOIN branches b ON b.id = p.registered_branch_id
       WHERE p.org_id = @org AND p.merged_into_id IS NULL AND p.id <> @exclude AND (
         (p.date_of_birth = @dob AND (p.search_name LIKE @last OR p.search_name LIKE @first))
         OR (length(@phone) >= 7 AND p.search_phone = @phone)
         OR (@email <> '' AND lower(p.email) = lower(@email))
       ) LIMIT 10`,
    )
    .all({ org: ctx.org.id, exclude: excludeId ?? '', dob: p.date_of_birth, last: `%${last}%`, first: `${first}%`, phone, email: p.email }) as (PatientRow & { branch_code: string })[];
  return rows.map(toSummary);
}

export class DuplicateSuspected extends AppError {
  constructor(public readonly candidates: PatientSummary[]) {
    super(409, 'POSSIBLE_DUPLICATE', 'This person may already be registered. Check the matches below.');
  }
}

export function registerPatient(ctx: Ctx, rawInput: unknown, opts: { confirmedNotDuplicate?: boolean } = {}): PatientRow {
  requirePerm(ctx, 'patient.create');
  const input = parsePatient(rawInput);
  if (!can(ctx, 'patient.medical.edit')) for (const f of MEDICAL_FIELDS) input[f] = '';

  if (!opts.confirmedNotDuplicate) {
    const candidates = findDuplicateCandidates(ctx, input);
    if (candidates.length) throw new DuplicateSuspected(candidates);
  }

  const id = newId();
  const now = nowIso();
  tx(ctx.db, () => {
    const n = nextSequence(ctx.db, ctx.branch.id, 'patient');
    const patientNo = `${ctx.branch.code}-${String(n).padStart(6, '0')}`;
    ctx.db
      .prepare(
        `INSERT INTO patients (id, org_id, patient_no, registered_branch_id, ${[...DEMOGRAPHIC_FIELDS, ...MEDICAL_FIELDS].join(', ')},
           search_name, search_phone, created_at, created_by, updated_at, updated_by)
         VALUES (@id, @org_id, @patient_no, @branch_id, ${[...DEMOGRAPHIC_FIELDS, ...MEDICAL_FIELDS].map((f) => '@' + f).join(', ')},
           @search_name, @search_phone, @now, @user, @now, @user)`,
      )
      .run({
        ...input, id, org_id: ctx.org.id, patient_no: patientNo, branch_id: ctx.branch.id,
        search_name: normalizeText(fullName(input)), search_phone: normalizePhone(input.phone), now, user: ctx.user.id,
      });
    recordEvent(ctx, { entityType: 'patient', entityId: id, op: 'created', entityVersion: 1, payload: { ...input, patient_no: patientNo, registered_branch_id: ctx.branch.id } });
    audit(ctx, 'patient.create', 'patient', id, { duplicate_warning_overridden: Boolean(opts.confirmedNotDuplicate) });
  });
  return loadPatientRow(ctx, id)!;
}

export function searchPatients(ctx: Ctx, q: string): PatientSummary[] {
  requirePerm(ctx, 'patient.view');
  const query = q.trim();
  if (query.length < 2) return [];
  const digits = query.replace(/\D/g, '');
  const tokens = normalizeText(query).split(' ').filter(Boolean).slice(0, 5);
  const params: Record<string, string> = { org: ctx.org.id, pno: query.toUpperCase(), phone: digits.length >= 4 ? `%${digits.slice(-10)}%` : '' };
  const nameClause = tokens.length ? tokens.map((t, i) => ((params[`t${i}`] = `%${t}%`), `p.search_name LIKE @t${i}`)).join(' AND ') : '0';
  const rows = ctx.db
    .prepare(
      `SELECT p.*, b.code AS branch_code FROM patients p JOIN branches b ON b.id = p.registered_branch_id
       WHERE p.org_id = @org AND p.merged_into_id IS NULL
         AND (p.patient_no = @pno OR (${nameClause}) OR (@phone <> '' AND p.search_phone LIKE @phone))
       ORDER BY p.last_name, p.first_name LIMIT 25`,
    )
    .all(params) as (PatientRow & { branch_code: string })[];
  return rows.map(toSummary);
}

function loadPatientRow(ctx: Ctx, id: string): PatientRow | undefined {
  if (!isUuid(id)) return undefined;
  return ctx.db.prepare('SELECT * FROM patients WHERE id = ? AND org_id = ?').get(id, ctx.org.id) as PatientRow | undefined;
}

/** A patient is "connected" to a branch by registration, an appointment, or an invoice there. */
export function canViewPatient(ctx: Ctx, p: PatientRow): boolean {
  if (!can(ctx, 'patient.view')) return false;
  if (can(ctx, 'patient.view.all_branches')) return true;
  const branches = ctx.assignedBranchIds;
  if (branches.includes(p.registered_branch_id)) return true;
  const ph = branches.map(() => '?').join(',');
  return Boolean(
    ctx.db.prepare(`SELECT 1 FROM appointments WHERE patient_id = ? AND branch_id IN (${ph}) LIMIT 1`).get(p.id, ...branches) ||
      ctx.db.prepare(`SELECT 1 FROM invoices WHERE patient_id = ? AND branch_id IN (${ph}) LIMIT 1`).get(p.id, ...branches),
  );
}

export type PatientView = PatientRow & { has_medical_alerts: boolean; medical_visible: boolean; registered_branch: string; full_name: string };

/** Load a patient for display. Other-org IDs → 404. Medical fields stripped without permission. Access is audited. */
export function getPatient(ctx: Ctx, id: string, opts: { audit?: boolean } = { audit: true }): PatientView {
  requirePerm(ctx, 'patient.view');
  const p = loadPatientRow(ctx, id);
  if (!p) throw notFound('Patient');
  if (!canViewPatient(ctx, p)) throw notFound('Patient');
  const hasAlerts = MEDICAL_FIELDS.some((f) => p[f].trim() !== '');
  const medicalVisible = can(ctx, 'patient.medical.view');
  if (!medicalVisible) for (const f of MEDICAL_FIELDS) p[f] = '';
  const branch = ctx.db.prepare('SELECT name FROM branches WHERE id = ?').pluck().get(p.registered_branch_id) as string;
  if (opts.audit) audit(ctx, medicalVisible && hasAlerts ? 'patient.view_with_medical' : 'patient.view', 'patient', p.id);
  return { ...p, has_medical_alerts: hasAlerts, medical_visible: medicalVisible, registered_branch: branch, full_name: fullName(p) };
}

/**
 * Update with optimistic concurrency: the form carries the version it was loaded at.
 * If someone else saved in between, the user is told instead of silently overwriting.
 */
export function updatePatient(ctx: Ctx, id: string, rawInput: unknown, baseVersion: number): PatientRow {
  requirePerm(ctx, 'patient.edit');
  getPatient(ctx, id, { audit: false }); // access check (404 for other orgs / unconnected branches)
  const input = parsePatient(rawInput);
  const medicalEditable = can(ctx, 'patient.medical.edit');
  const existing = ctx.db.prepare('SELECT * FROM patients WHERE id = ?').get(id) as PatientRow;
  if (!medicalEditable) for (const f of MEDICAL_FIELDS) input[f] = existing[f];

  const changed = [...DEMOGRAPHIC_FIELDS, ...MEDICAL_FIELDS].filter((f) => input[f] !== existing[f]);
  if (!changed.length) return existing;

  tx(ctx.db, () => {
    const r = ctx.db
      .prepare(
        `UPDATE patients SET ${[...DEMOGRAPHIC_FIELDS, ...MEDICAL_FIELDS].map((f) => `${f} = @${f}`).join(', ')},
           search_name = @search_name, search_phone = @search_phone, version = version + 1, updated_at = @now, updated_by = @user
         WHERE id = @id AND org_id = @org AND version = @base`,
      )
      .run({ ...input, search_name: normalizeText(fullName(input)), search_phone: normalizePhone(input.phone), now: nowIso(), user: ctx.user.id, id, org: ctx.org.id, base: baseVersion });
    if (r.changes !== 1) {
      throw conflict('STALE_EDIT', 'Someone else updated this patient after you opened the form. Reload to see their changes, then re-apply yours.');
    }
    const changes = Object.fromEntries(changed.map((f) => [f, input[f]]));
    // base_cloud_version lets the cloud detect edits made elsewhere since this record was last synced.
    recordEvent(ctx, { entityType: 'patient', entityId: id, op: 'updated', entityVersion: baseVersion + 1, baseVersion, payload: { changes, base_cloud_version: existing.cloud_version } });
    // Audit field names only, never values.
    audit(ctx, 'patient.update', 'patient', id, { fields: changed });
  });
  return ctx.db.prepare('SELECT * FROM patients WHERE id = ?').get(id) as PatientRow;
}

/**
 * Minimal identification of any patient in the organization (as shown in search results), plus whether
 * medical alerts exist. Used to book a patient registered at another branch; booking then connects the
 * patient to this branch, which allows the full record to be opened here.
 */
export function getPatientSummary(ctx: Ctx, id: string): PatientSummary & { full_name: string; has_medical_alerts: boolean } {
  requirePerm(ctx, 'patient.view');
  const p = loadPatientRow(ctx, id);
  if (!p || p.merged_into_id) throw notFound('Patient');
  const branchCode = ctx.db.prepare('SELECT code FROM branches WHERE id = ?').pluck().get(p.registered_branch_id) as string;
  const s = toSummary({ ...p, branch_code: branchCode });
  return { ...s, full_name: s.name, has_medical_alerts: MEDICAL_FIELDS.some((f) => p[f].trim() !== '') };
}

/** Whether this user can already open the full record (registration/visit/invoice at an assigned branch). */
export function isPatientConnected(ctx: Ctx, id: string): boolean {
  const p = loadPatientRow(ctx, id);
  return Boolean(p && canViewPatient(ctx, p));
}
