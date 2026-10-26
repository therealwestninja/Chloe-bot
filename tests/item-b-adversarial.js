// Item B adversarial — reviewer hat. Ugly inputs, guard trips, null-controls, neighbors.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B-adv]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const boxIds = ['rosterList','modListBox','bannedList'];
const beforeHTML = {}; boxIds.forEach(id => { const el = byId(id); beforeHTML[id] = el ? el.innerHTML : null; });
const beforeModSet = Object.assign({}, window.__modSet || {});
const beforeRoster = (window.__roster || []).slice();
const beforeFilter = byId('rosterFilter') ? byId('rosterFilter').value : '';
const beforeRun = byId('runTxt') ? byId('runTxt').textContent : null;
const beforeSb = byId('sb_run') ? byId('sb_run').textContent : null;
function restore() {
  // Batch 12: state first, raw HTML LAST. The renders rebuild in-memory/view state from the
  // saved data, but time-relative strings re-render differently across seconds — only the raw
  // HTML assignment restores the boxes byte-identically (a live 5s refresh mid-suite made the
  // old order flaky with the link up).
  window.__modSet = beforeModSet; window.__roster = beforeRoster;
  if (byId('rosterFilter')) byId('rosterFilter').value = beforeFilter;
  try { renderRoster(window.__roster || []); syncBatchBar(); } catch (e) {}
  try { renderMods([]); } catch (e) {}
  try { renderBanned([]); } catch (e) {}
  boxIds.forEach(id => { const el = byId(id); if (el && beforeHTML[id] !== null) el.innerHTML = beforeHTML[id]; });
}
try {
  // ADV1 — XSS name must be text, never HTML
  window.__modSet = {};
  try { renderRoster([{ id: 'x1', name: '<img src=x onerror=alert(1)>', state: 'active', lastSeen: 0, recent: [] }]); } catch (e) { ck('ADV1-xss-no-throw', false, String((e && e.message) || e)); }
  const img = byId('rosterList').querySelector('img');
  ck('ADV1-xss-escaped', !img && byId('rosterList').textContent.indexOf('<img') >= 0, img ? 'HTML INJECTED (img element exists)' : 'name rendered as text');
  // ADV2 — numeric id + missing optionals
  try { renderRoster([{ id: 12345 }]); ck('ADV2-numeric-id', byId('rosterList').querySelectorAll('.urow').length === 1, 'numeric id row renders'); } catch (e) { ck('ADV2-numeric-id', false, 'threw: ' + ((e && e.message) || e)); }
  // ADV3 — duplicate ids: both rows render (documents no-dedupe)
  try { renderRoster([{ id: 'd', name: 'A', lastSeen: 0 }, { id: 'd', name: 'B', lastSeen: 0 }]); ck('ADV3-dupes', byId('rosterList').querySelectorAll('.urow').length === 2, 'dupes render=' + byId('rosterList').querySelectorAll('.urow').length); } catch (e) { ck('ADV3-dupes', false, 'threw'); }
  // ADV4 — giant roster 300 rows renders (perf smoke; cap time implicitly by timeout)
  const big = []; for (let i = 0; i < 300; i++) big.push({ id: 'g' + i, name: 'User' + i, state: 'active', lastSeen: 0, recent: [] });
  const t0 = Date.now();
  try { renderRoster(big); ck('ADV4-giant', byId('rosterList').querySelectorAll('.urow').length === 300, 'rows=300 in ' + (Date.now() - t0) + 'ms'); } catch (e) { ck('ADV4-giant', false, 'threw'); }
  // ADV5 — guard trip: rosterAll checks all → batch shows N
  const boxes = byId('rosterList').querySelectorAll('.usel');
  Array.prototype.forEach.call(boxes, c => { c.checked = true; });
  try { syncBatchBar(); ck('ADV5-batch-all', byId('batchCount').textContent === '300 selected' && byId('rosterAll').checked, 'batch=' + byId('batchCount').textContent); } catch (e) { ck('ADV5-batch-all', false, 'threw'); }
  // ADV6 — null-control: renderRoster([]) twice identical
  try { renderRoster([]); const a = byId('rosterList').innerHTML; renderRoster([]); const b = byId('rosterList').innerHTML; ck('ADV6-idempotent', a === b && byId('rosterCount').textContent === '0 people', 'empty idempotent'); } catch (e) { ck('ADV6-idempotent', false, 'threw'); }
  // ADV7 — state variants: amber per CSS (.ignored/.soft-ban/.timeout); 'soft ban' normalizes to soft-ban (Batch 5)
  const variants = ['active','ignored','soft-ban','softban','soft ban','timeout','banned','unknown-state'];
  try { renderRoster(variants.map((s, i) => ({ id: 'v' + i, name: s, state: s, lastSeen: 0, recent: [] }))); } catch (e) {}
  const got = Array.prototype.map.call(byId('rosterList').querySelectorAll('.ustate'), s => s.className);
  const amber = got.filter(c => c === 'ustate ignored' || c === 'ustate soft-ban' || c === 'ustate timeout').length;
  ck('ADV7-amber-coverage', amber === 4, 'amber=' + amber + '/8 classes=' + JSON.stringify(got).slice(0, 220));
  // ADV8 — neighbors: status strip untouched by roster writes (live-state-proof: compare to suite-start values)
  ck('ADV8-neighbors', byId('runTxt').textContent === beforeRun && byId('sb_run').textContent === beforeSb, 'runTxt=' + byId('runTxt').textContent + ' sb=' + byId('sb_run').textContent);
} finally { restore(); }
ck('ADV0-restored', byId('rosterList').innerHTML === beforeHTML.rosterList, 'roster box restored');
const pass = checks.every(c => c.ok);
return { pass, checks };
