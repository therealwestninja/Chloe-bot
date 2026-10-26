// About-tab probes — docs-vs-UI consistency (control names quoted in the help text
// must match the live control labels) + FAQ/Help presence + no stale references.
// Run: page_eval {path:"src/tests/item-about-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:ABOUT]', id, detail); } catch (e) {} } }
function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
try {
  const about = norm(document.getElementById('pane_about').textContent);
  const btnLabel = id => norm(document.getElementById(id).textContent);
  const chipLabel = id => { const el = document.getElementById(id); const l = el ? el.closest('label') : null; return norm(l ? l.textContent : ''); };
  // A1 — setup steps name the live buttons/controls
  ck('A1-save-channels', about.includes(btnLabel('setChannelsBtn')), 'label=' + btnLabel('setChannelsBtn'));
  ck('A1-backfill', about.includes(chipLabel('backfillChk')), 'chip=' + chipLabel('backfillChk'));
  ck('A1-validate', about.includes(btnLabel('validateBtn')), 'label=' + btnLabel('validateBtn'));
  ck('A1-start', about.includes(btnLabel('startBtn')), 'label=' + btnLabel('startBtn'));
  // A2 — behavior chips quoted in the feature cards match live labels (core words)
  [['volChk', 'volunteer into conversations'], ['greetChk', 'greet arrivals'], ['dmChk', 'reply in DMs'], ['factChk', 'remember durable facts'], ['timeChk', 'sense time of day']].forEach(([id, core]) => {
    ck('A2-' + id, about.includes(core) && chipLabel(id).includes(core), core);
  });
  // A3 — diagnostics + export mentions match live labels
  ck('A3-diag', about.includes(btnLabel('diagBtn')), 'label=' + btnLabel('diagBtn'));
  ck('A3-export', about.includes('Export') && btnLabel('exportBtn').includes('Export'), 'label=' + btnLabel('exportBtn'));
  // A4 — FAQ + Help cards exist with real content
  const h2s = [...document.querySelectorAll('#pane_about h2')].map(h => norm(h.textContent));
  ck('A4-faq', h2s.includes('FAQ'), h2s.join(' | ').slice(0, 200));
  ck('A4-help', h2s.some(h => h.indexOf('Help') === 0), h2s.join(' | ').slice(0, 200));
  // A5 — stale references gone (old button names the controls no longer have)
  const stale = ['click Set channel.', 'click Backfill history', 'Personality tabs', 'one per line', 'including Personality'];
  const found = stale.filter(s => about.includes(s));
  ck('A5-no-stale', found.length === 0, found.length ? ('stale: ' + found.join('; ')) : 'clean');
  // A6 — Setup docs describe the CRUD (add + make primary), matching the live controls
  ck('A6-crud', about.includes('make primary') && about.includes('Save channels'), 'crud verbs present');
} catch (e) { ck('A0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
