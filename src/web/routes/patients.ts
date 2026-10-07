// Patient search, registration (with duplicate suggestions), profile and edit.
import type { FastifyInstance } from 'fastify';
import { can, requirePerm, type Ctx } from '../../domain/context.js';
import { DuplicateSuspected, getPatient, registerPatient, searchPatients, updatePatient, type PatientSummary, type PatientView } from '../../domain/patients.js';
import { patientAppointments, STATUS_LABELS } from '../../domain/appointments.js';
import { patientAccount } from '../../domain/billing.js';
import { patientBalanceElsewhere } from '../../domain/org-report.js';
import { AppError, html, type SafeHtml } from '../../lib/core.js';
import { fmtDate, fmtDateTime } from '../../lib/time.js';
import { csrfInput, emptyState, field, money, page, select, statusBadge, textarea } from '../ui.js';
import { flashFromQuery, formOf, queryOf, requireAuth, sendPage, type Deps, type Form } from '../app.js';

function patientForm(ctx: Ctx, csrf: string, action: string, v: Form, errors: Record<string, string>, opts: { version?: number; duplicates?: PatientSummary[]; medicalVisible: boolean }): SafeHtml {
  const medicalEditable = can(ctx, 'patient.medical.edit');
  return html`<form method="post" action="${action}" class="stack" novalidate>
    ${csrfInput(csrf)}
    ${opts.version !== undefined ? html`<input type="hidden" name="version" value="${opts.version}">` : ''}
    ${opts.duplicates?.length
      ? html`<div class="flash warn" role="alert"><strong>Possible existing patient.</strong> Check these records before registering a new one:
          <table class="table compact"><thead><tr><th>Patient no.</th><th>Name</th><th>Date of birth</th><th>Phone</th><th>Branch</th><th></th></tr></thead>
          <tbody>${opts.duplicates.map((d) => html`<tr><td>${d.patient_no}</td><td>${d.name}</td><td>${fmtDate(d.date_of_birth)}</td><td>${d.phone_hint}</td><td>${d.branch_code}</td>
            <td><a href="/patients/${d.id}">Open this record</a></td></tr>`)}</tbody></table>
          <label class="check"><input type="checkbox" name="confirm_not_duplicate" value="1"> I checked these records; this is a different person</label></div>`
      : ''}
    <fieldset><legend>Identity</legend><div class="grid3">
      ${field('First name', 'first_name', v.first_name, { required: true, errors, autofocus: !opts.version })}
      ${field('Middle name', 'middle_name', v.middle_name, { errors })}
      ${field('Last name', 'last_name', v.last_name, { required: true, errors })}
      ${field('Date of birth', 'date_of_birth', v.date_of_birth, { type: 'date', required: true, errors })}
      ${select('Sex', 'sex', [{ value: 'female', label: 'Female' }, { value: 'male', label: 'Male' }, { value: 'other', label: 'Other' }], v.sex ?? '', { placeholder: 'Not recorded', errors })}
    </div></fieldset>
    <fieldset><legend>Contact</legend><div class="grid3">
      ${field('Mobile / phone', 'phone', v.phone, { type: 'tel', errors })}
      ${field('Email', 'email', v.email, { type: 'email', errors })}
      ${field('Address', 'address', v.address, { errors })}
      ${field('Emergency contact name', 'emergency_contact_name', v.emergency_contact_name, { errors })}
      ${field('Emergency contact phone', 'emergency_contact_phone', v.emergency_contact_phone, { type: 'tel', errors })}
    </div></fieldset>
    <fieldset><legend>Parent / guardian <span class="muted">(for minors or patients needing assistance)</span></legend><div class="grid3">
      ${field('Guardian name', 'guardian_name', v.guardian_name, { errors })}
      ${field('Relationship', 'guardian_relationship', v.guardian_relationship, { errors })}
      ${field('Guardian phone', 'guardian_phone', v.guardian_phone, { type: 'tel', errors })}
    </div></fieldset>
    ${medicalEditable
      ? html`<fieldset><legend>Medical information <span class="muted">(visible only to authorized clinical staff)</span></legend>
          ${textarea('Allergies', 'allergies', v.allergies ?? '', errors, 2)}
          ${textarea('Current medications', 'medications', v.medications ?? '', errors, 2)}
          ${textarea('Medical history', 'medical_history', v.medical_history ?? '', errors, 3)}</fieldset>`
      : html`<p class="hint">Medical history, allergies and medications are recorded by a dentist.</p>`}
    <div class="actions"><button class="primary" type="submit">${opts.version !== undefined ? 'Save changes' : 'Register patient'}</button>
      <a href="${opts.version !== undefined ? action.replace('/edit', '') : '/patients'}">Cancel</a></div>
  </form>`;
}

const formFromPatient = (p: PatientView): Form => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v == null ? '' : String(v)]));

export function registerPatientRoutes(app: FastifyInstance, _deps: Deps): void {
  app.get('/patients', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const q = (queryOf(req).q ?? '').slice(0, 100);
    const results = q ? searchPatients(a.ctx, q) : [];
    return sendPage(reply, page({
      title: 'Patients', ctx: a.ctx, csrf: a.csrf, active: 'patients',
      body: html`<div class="page-head"><h1>Patients</h1>${can(a.ctx, 'patient.create') ? html`<a class="button primary" href="/patients/new">Register patient</a>` : ''}</div>
        <form class="search-bar" method="get" action="/patients" role="search">
          <label for="q" class="sr-only">Search patients</label>
          <input id="q" name="q" type="search" value="${q}" placeholder="Name, patient no. (e.g. MKT-000012) or phone" autofocus data-hotkey="/">
          <button>Search</button></form>
        ${!q ? html`<p class="muted">Type at least 2 characters. Results show only what you need to identify the patient.</p>`
          : results.length
            ? html`<table class="table"><thead><tr><th>Patient no.</th><th>Name</th><th>Date of birth</th><th>Phone</th><th>Registered at</th></tr></thead>
              <tbody>${results.map((r) => html`<tr><td><a href="/patients/${r.id}">${r.patient_no}</a></td><td><a href="/patients/${r.id}">${r.name}</a></td>
                <td>${fmtDate(r.date_of_birth)}</td><td>${r.phone_hint}</td><td>${r.branch_code}</td></tr>`)}</tbody></table>`
            : emptyState(`No patients match “${q}”`, 'Check the spelling, try the phone number, or register a new patient.', can(a.ctx, 'patient.create') ? html`<a class="button" href="/patients/new">Register patient</a>` : undefined)}`,
    }));
  });

  app.get('/patients/new', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    requirePerm(a.ctx, 'patient.create');
    return sendPage(reply, page({ title: 'Register patient', ctx: a.ctx, csrf: a.csrf, active: 'patients',
      body: html`<h1>Register patient</h1>${patientForm(a.ctx, a.csrf, '/patients/new', {}, {}, { medicalVisible: can(a.ctx, 'patient.medical.view') })}` }));
  });

  app.post('/patients/new', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const f = formOf(req);
    try {
      const p = registerPatient(a.ctx, f, { confirmedNotDuplicate: f.confirm_not_duplicate === '1' });
      return reply.redirect(`/patients/${p.id}?msg=patient_created`);
    } catch (e) {
      if (!(e instanceof AppError) || (e.status !== 422 && !(e instanceof DuplicateSuspected))) throw e;
      return sendPage(reply, page({ title: 'Register patient', ctx: a.ctx, csrf: a.csrf, active: 'patients', flash: { kind: e instanceof DuplicateSuspected ? 'warn' : 'error', text: e.message },
        body: html`<h1>Register patient</h1>${patientForm(a.ctx, a.csrf, '/patients/new', f, e.fields, { duplicates: e instanceof DuplicateSuspected ? e.candidates : [], medicalVisible: true })}` }), e instanceof DuplicateSuspected ? 409 : 422);
    }
  });

  app.get('/patients/:id', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const { ctx } = a;
    const p = getPatient(ctx, (req.params as { id: string }).id);
    const appts = can(ctx, 'appointment.view') ? patientAppointments(ctx, p.id) : [];
    const account = can(ctx, 'billing.view') ? patientAccount(ctx, p.id) : null;
    const elsewhere = account ? patientBalanceElsewhere(ctx, p.id) : null;
    const tz = ctx.branch.timezone;
    const row = (label: string, value: unknown) => (value ? html`<dt>${label}</dt><dd>${value}</dd>` : '');
    return sendPage(reply, page({
      title: p.full_name, ctx, csrf: a.csrf, active: 'patients', flash: flashFromQuery(req),
      body: html`<div class="page-head"><div><h1>${p.full_name}</h1><p class="muted">${p.patient_no} · Registered at ${p.registered_branch}</p></div>
        <div class="actions">
          ${can(ctx, 'patient.edit') ? html`<a class="button" href="/patients/${p.id}/edit">Edit details</a>` : ''}
          ${can(ctx, 'appointment.manage') ? html`<a class="button" href="/appointments/new?patient_id=${p.id}">Book appointment</a>` : ''}
          ${can(ctx, 'invoice.draft') ? html`<form method="post" action="/invoices/new" class="inline">${csrfInput(a.csrf)}<input type="hidden" name="patient_id" value="${p.id}"><button class="primary">New invoice</button></form>` : ''}
        </div></div>
      ${p.has_medical_alerts ? html`<div class="flash warn medical" role="note"><strong>Medical alerts recorded.</strong> ${p.medical_visible ? '' : 'Ask the dentist to review before treatment.'}</div>` : ''}
      ${account ? html`<div class="kpis">
          <div class="kpi"><span>Charges (issued invoices)</span><strong>${money(ctx, account.charges_minor)}</strong></div>
          <div class="kpi"><span>Collected (net of reversals)</span><strong>${money(ctx, account.collected_minor)}</strong></div>
          <div class="kpi ${account.outstanding_minor > 0 ? 'due' : ''}"><span>Outstanding balance</span><strong>${money(ctx, account.outstanding_minor)}</strong></div>
        </div>${elsewhere && elsewhere.branches.length
          ? html`<div class="flash warn">Also outstanding at other branches: <strong>${money(ctx, elsewhere.outstanding_minor)}</strong> —
              ${elsewhere.branches.map((b, i) => html`${i ? '; ' : ''}${b.name} ${money(ctx, b.outstanding_minor)} (${b.freshness === 'stale' || b.freshness === 'no_data' ? 'may be out of date, ' : ''}as of ${b.asOf ? fmtDateTime(b.asOf, ctx.branch.timezone) : 'unknown'})`)}.
              Payments for those invoices are taken at the branch that issued them.</div>`
          : html`<p class="hint">Amounts above are for ${ctx.branch.name}.</p>`}` : ''}
      <div class="cols">
        <section><h2>Details</h2><dl class="dl">
          ${row('Date of birth', fmtDate(p.date_of_birth))}${row('Sex', p.sex)}${row('Phone', p.phone)}${row('Email', p.email)}${row('Address', p.address)}
          ${row('Emergency contact', [p.emergency_contact_name, p.emergency_contact_phone].filter(Boolean).join(' · '))}
          ${row('Guardian', [p.guardian_name, p.guardian_relationship, p.guardian_phone].filter(Boolean).join(' · '))}
        </dl>
        ${p.medical_visible ? html`<h2>Medical information</h2><dl class="dl">
          <dt>Allergies</dt><dd>${p.allergies || 'None recorded'}</dd><dt>Medications</dt><dd>${p.medications || 'None recorded'}</dd>
          <dt>Medical history</dt><dd class="pre">${p.medical_history || 'None recorded'}</dd></dl>` : ''}
        </section>
        <section>
          ${account ? html`<h2>Invoices</h2>${account.invoices.length
            ? html`<table class="table compact"><thead><tr><th>Invoice</th><th>Status</th><th class="num">Total</th><th class="num">Balance</th></tr></thead>
              <tbody>${account.invoices.map((i) => html`<tr><td><a href="/invoices/${i.id}">${i.invoice_no ?? 'Draft'}</a></td><td>${statusBadge(i.status, i.status)}</td>
                <td class="num">${money(ctx, i.total_minor)}</td><td class="num">${i.status === 'issued' ? money(ctx, i.balance_minor) : '—'}</td></tr>`)}</tbody></table>`
            : html`<p class="muted">No invoices yet.</p>`}` : ''}
          ${can(ctx, 'appointment.view') ? html`<h2>Visits & appointments</h2>${appts.length
            ? html`<table class="table compact"><thead><tr><th>When</th><th>Dentist</th><th>Procedure</th><th>Status</th></tr></thead>
              <tbody>${appts.map((x) => html`<tr><td><a href="/appointments/${x.id}">${fmtDateTime(x.start_at, tz)}</a></td><td>${x.dentist_name}</td><td>${x.service_name ?? '—'}</td>
                <td>${statusBadge(x.status, STATUS_LABELS[x.status])}</td></tr>`)}</tbody></table>`
            : html`<p class="muted">No appointments yet.</p>`}` : ''}
        </section></div>`,
    }));
  });

  app.get('/patients/:id/edit', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    requirePerm(a.ctx, 'patient.edit');
    const p = getPatient(a.ctx, (req.params as { id: string }).id, { audit: false });
    return sendPage(reply, page({ title: `Edit ${p.full_name}`, ctx: a.ctx, csrf: a.csrf, active: 'patients',
      body: html`<h1>Edit ${p.full_name}</h1><p class="muted">${p.patient_no}</p>${patientForm(a.ctx, a.csrf, `/patients/${p.id}/edit`, formFromPatient(p), {}, { version: p.version, medicalVisible: p.medical_visible })}` }));
  });

  app.post('/patients/:id/edit', async (req, reply) => {
    const a = requireAuth(req, reply);
    if (!a) return;
    const id = (req.params as { id: string }).id;
    const f = formOf(req);
    try {
      updatePatient(a.ctx, id, f, Number(f.version));
      return reply.redirect(`/patients/${id}?msg=patient_saved`);
    } catch (e) {
      if (!(e instanceof AppError) || (e.status !== 422 && e.status !== 409)) throw e;
      return sendPage(reply, page({ title: 'Edit patient', ctx: a.ctx, csrf: a.csrf, active: 'patients', flash: { kind: 'error', text: e.message },
        body: html`<h1>Edit patient</h1>${patientForm(a.ctx, a.csrf, `/patients/${id}/edit`, f, e.fields, { version: Number(f.version), medicalVisible: can(a.ctx, 'patient.medical.view') })}` }), e.status);
    }
  });
}
