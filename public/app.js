// Progressive enhancement only. Every page works without this file.
(() => {
  'use strict';
  const banner = document.getElementById('conn-banner');
  const pills = { local: document.getElementById('st-local'), cloud: document.getElementById('st-cloud'), sync: document.getElementById('st-sync') };

  function show(kind, text) {
    if (!banner) return;
    banner.hidden = !text;
    banner.className = 'conn-banner ' + (kind || '');
    banner.textContent = text || '';
  }
  function setPill(el, cls, text, title) {
    if (!el) return;
    el.className = 'pill ' + cls;
    el.textContent = text;
    if (title) el.title = title;
  }

  // Three distinct failure situations, described plainly (see docs/02-architecture.md):
  //  - this workstation has no network       -> navigator.onLine === false
  //  - clinic server unreachable             -> request to our own server fails while online
  //  - internet/cloud unavailable            -> reported BY the server in /api/status
  async function poll() {
    if (!pills.local) return; // not signed in
    if (!navigator.onLine) {
      setPill(pills.local, 'error', '● No network');
      show('error', 'This computer is not connected to the clinic network. Changes cannot be saved. Check the network cable or Wi-Fi.');
      return;
    }
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch('/api/status', { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
      clearTimeout(t);
      if (res.status === 401) { show('warn', 'Your session has ended. Reload the page to sign in again.'); return; }
      if (!res.ok) throw new Error('status ' + res.status);
      const s = await res.json();
      setPill(pills.local, 'ok', '● Clinic server');
      setPill(pills.cloud, s.cloud.configured ? (s.cloud.state === 'online' ? 'ok' : 'warn') : 'muted',
        s.cloud.configured ? (s.cloud.state === 'online' ? '● Cloud' : '● Cloud offline') : '○ Cloud: not set up');
      setPill(pills.sync, s.sync.failed ? 'error' : 'muted', '⇅ ' + s.sync.pending + ' pending' + (s.sync.failed ? ' · ' + s.sync.failed + ' failed' : ''),
        'Changes waiting to be sent to the cloud. Last successful sync: ' + (s.sync.last_success_at || 'never'));
      show('', '');
    } catch (e) {
      setPill(pills.local, 'error', '● Server unreachable');
      show('error', 'Cannot reach the clinic server. Changes cannot be saved right now. Check that the server computer is on and connected; your screen will update when it is back.');
    }
  }
  window.addEventListener('online', poll);
  window.addEventListener('offline', poll);
  setInterval(poll, 10000);
  poll();

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-confirm],[data-print],[data-back]');
    if (!t) return;
    if (t.hasAttribute('data-print')) { e.preventDefault(); window.print(); }
    else if (t.hasAttribute('data-back') && history.length > 1) { e.preventDefault(); history.back(); }
    else if (t.hasAttribute('data-confirm') && !window.confirm(t.getAttribute('data-confirm'))) { e.preventDefault(); }
  });

  // Prevent accidental double submission (the server is idempotent for payments anyway).
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.method && f.method.toLowerCase() === 'post') {
      if (f.dataset.submitting) { e.preventDefault(); return; }
      f.dataset.submitting = '1';
      setTimeout(() => { delete f.dataset.submitting; }, 8000);
    }
  });

  document.querySelectorAll('select[data-autosubmit]').forEach((s) => s.addEventListener('change', () => s.form.submit()));

  // Procedure choice fills the default duration until the user edits it.
  const svc = document.getElementById('f-service_id');
  const dur = document.getElementById('f-duration_min');
  if (svc && dur) {
    let touched = false;
    dur.addEventListener('input', () => { touched = true; });
    svc.addEventListener('change', () => {
      const d = svc.selectedOptions[0] && svc.selectedOptions[0].dataset.duration;
      if (d && !touched) dur.value = d;
    });
  }

  // "/" focuses the patient search box.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    const box = document.querySelector('[data-hotkey="/"]');
    if (box) { e.preventDefault(); box.focus(); }
  });
})();
