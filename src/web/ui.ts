// Page shell and small UI components (server-rendered, accessible, no external assets).
import { APP_VERSION } from '../config.js';
import { can, type Ctx } from '../domain/context.js';
import { syncStatus, type SyncStatus } from '../domain/outbox.js';
import { fmtDateTime } from '../lib/time.js';
import { formatMoney, html, type SafeHtml } from '../lib/core.js';
import { ROLE_LABELS } from '../auth/permissions.js';

export interface PageOpts {
  title: string;
  ctx?: Ctx | null;
  csrf?: string;
  active?: string;
  flash?: { kind: 'ok' | 'error' | 'warn'; text: string } | null;
  body: SafeHtml;
}

let demoBanner = false;
/** Called once at startup from the app config. */
export const setDemoBanner = (on: boolean) => { demoBanner = on; };

const NAV: { key: string; label: string; href: string; perm: Parameters<typeof can>[1] }[] = [
  { key: 'today', label: 'Today', href: '/', perm: 'appointment.view' },
  { key: 'patients', label: 'Patients', href: '/patients', perm: 'patient.view' },
  { key: 'appointments', label: 'Calendar', href: '/appointments', perm: 'appointment.view' },
  { key: 'billing', label: 'Billing', href: '/invoices', perm: 'billing.view' },
  { key: 'reports', label: 'Collections', href: '/reports/collections', perm: 'report.collections.view' },
  { key: 'organization', label: 'Organization', href: '/reports/organization', perm: 'report.org.view' },
  { key: 'admin', label: 'Admin', href: '/admin', perm: 'backup.view' },
];

export function page(o: PageOpts): string {
  const ctx = o.ctx;
  const sync = ctx ? syncStatus(ctx.db) : null;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} · DentalSys</title>
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div id="conn-banner" class="conn-banner" role="alert" hidden></div>
${demoBanner ? html`<div class="demo-banner" role="note"><strong>TEST SYSTEM</strong> — synthetic demo data only. Do not enter real patient information.</div>` : ''}
${ctx
  ? html`<header class="topbar">
  <div class="brand"><span class="logo" aria-hidden="true">◆</span> DentalSys</div>
  <nav aria-label="Main">
    ${NAV.filter((n) => can(ctx, n.perm)).map((n) => html`<a href="${n.href}" ${n.key === o.active ? html`aria-current="page"` : ''}>${n.label}</a>`)}
  </nav>
  <div class="status" aria-label="Connection status">
    <span class="pill ok" id="st-local" title="Connection from this computer to the clinic server">● Clinic server</span>
    ${(() => { const c = cloudPill(sync!, ctx.branch.timezone); return html`<span class="pill ${c.cls}" id="st-cloud" title="${c.title}">${c.text}</span>`; })()}
    <span class="pill ${sync!.failed ? 'error' : 'muted'}" id="st-sync" title="Changes waiting to be sent to the cloud. Last successful sync: ${sync!.lastSuccessAt ? fmtDateTime(sync!.lastSuccessAt, ctx.branch.timezone) : 'never'}">⇅ ${sync!.pending} pending${sync!.failed ? html` · ${sync!.failed} failed` : ''}</span>
    ${sync!.conflicts && can(ctx, 'patient.edit') ? html`<a class="pill warn" id="st-conflicts" href="/sync/conflicts">⚠ ${sync!.conflicts} to review</a>` : ''}
  </div>
  <div class="who">
    <a href="/switch-branch" title="Switch branch">${ctx.org.name} · <strong>${ctx.branch.name}</strong></a>
    <span class="muted">${ctx.user.display_name} (${ROLE_LABELS[ctx.membership.role]})</span>
    <form method="post" action="/logout" class="inline"><input type="hidden" name="_csrf" value="${o.csrf ?? ''}"><button class="link">Sign out</button></form>
  </div>
</header>`
  : ''}
<main id="main" tabindex="-1">
${o.flash ? html`<div class="flash ${o.flash.kind}" role="${o.flash.kind === 'error' ? 'alert' : 'status'}">${o.flash.text}</div>` : ''}
${o.body}
</main>
<footer class="foot">v${APP_VERSION} · Synthetic demo data only · Not for production use without review</footer>
</body>
</html>`.value;
}

export const money = (ctx: Ctx, minor: number) => formatMoney(minor, ctx.org.currency);

export function field(
  label: string,
  name: string,
  value: string | number | undefined,
  opts: { type?: string; required?: boolean; errors?: Record<string, string>; hint?: string; attrs?: SafeHtml; autofocus?: boolean } = {},
): SafeHtml {
  const err = opts.errors?.[name];
  const id = `f-${name}`;
  return html`<div class="field ${err ? 'has-error' : ''}">
    <label for="${id}">${label}${opts.required ? html` <span class="req" aria-hidden="true">*</span>` : ''}</label>
    <input id="${id}" name="${name}" type="${opts.type ?? 'text'}" value="${value ?? ''}" ${opts.required ? html`required` : ''}
      ${opts.autofocus ? html`autofocus` : ''} ${err ? html`aria-invalid="true" aria-describedby="${id}-err"` : opts.hint ? html`aria-describedby="${id}-hint"` : ''} ${opts.attrs ?? ''}>
    ${opts.hint && !err ? html`<small id="${id}-hint" class="hint">${opts.hint}</small>` : ''}
    ${err ? html`<small id="${id}-err" class="error-text">${err}</small>` : ''}
  </div>`;
}

export function textarea(label: string, name: string, value: string, errors?: Record<string, string>, rows = 3): SafeHtml {
  const err = errors?.[name];
  return html`<div class="field ${err ? 'has-error' : ''}"><label for="f-${name}">${label}</label>
    <textarea id="f-${name}" name="${name}" rows="${rows}" ${err ? html`aria-invalid="true"` : ''}>${value}</textarea>
    ${err ? html`<small class="error-text">${err}</small>` : ''}</div>`;
}

export function select(
  label: string,
  name: string,
  options: { value: string; label: string; attrs?: SafeHtml }[],
  selected: string,
  opts: { required?: boolean; errors?: Record<string, string>; placeholder?: string } = {},
): SafeHtml {
  const err = opts.errors?.[name];
  return html`<div class="field ${err ? 'has-error' : ''}"><label for="f-${name}">${label}${opts.required ? html` <span class="req" aria-hidden="true">*</span>` : ''}</label>
    <select id="f-${name}" name="${name}" ${opts.required ? html`required` : ''} ${err ? html`aria-invalid="true"` : ''}>
      ${opts.placeholder !== undefined ? html`<option value="">${opts.placeholder}</option>` : ''}
      ${options.map((o) => html`<option value="${o.value}" ${o.value === selected ? html`selected` : ''} ${o.attrs ?? ''}>${o.label}</option>`)}
    </select>${err ? html`<small class="error-text">${err}</small>` : ''}</div>`;
}

export const csrfInput = (csrf: string) => html`<input type="hidden" name="_csrf" value="${csrf}">`;

export function emptyState(title: string, text: string, action?: SafeHtml): SafeHtml {
  return html`<div class="empty"><p class="empty-title">${title}</p><p>${text}</p>${action ?? ''}</div>`;
}

export function statusBadge(status: string, label: string): SafeHtml {
  return html`<span class="badge st-${status}">${label}</span>`;
}

/** Header label for the internet/cloud connection (also used by /api/status for live updates). */
export function cloudPill(s: SyncStatus, tz: string): { cls: string; text: string; title: string } {
  const since = s.offlineSince ? fmtDateTime(s.offlineSince, tz) : '';
  switch (s.cloudState) {
    case 'not_configured': return { cls: 'muted', text: '○ Cloud: not set up', title: 'This clinic server is not connected to the DentalSys cloud. Everything works locally.' };
    case 'online': return { cls: 'ok', text: '● Cloud', title: `Connected. Last sync ${s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt, tz) : 'never'}.` };
    case 'offline': return { cls: 'warn', text: '● Cloud offline', title: `No internet or cloud unavailable since ${since}. Local work continues; changes are queued.` };
    case 'update_required': return { cls: 'error', text: '● Update required', title: 'The cloud needs a newer DentalSys version. Local work continues; changes are queued.' };
    case 'revoked': return { cls: 'error', text: '● Cloud access revoked', title: 'This server is no longer authorized to sync. Contact support. Local work continues.' };
    default: return { cls: 'error', text: '● Sync error', title: `Sync problem since ${since}: ${s.lastError ?? ''}. Local work continues; changes are queued.` };
  }
}
