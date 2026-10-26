// Items E+G adversarial — malformed shapes, idempotence, neighbors.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:EG-adv]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const beforeVals = {};
['procRules','autoModRules','beatsBox','gate_emoji'].forEach(id => { const el = byId(id); beforeVals[id] = id === 'gate_emoji' ? el.checked : el.value; });
const beforeApplied = (typeof lastApplied !== 'undefined') ? Object.assign({}, lastApplied) : null;
const STRIP = ['runDot','runTxt','sb_run_dot','sb_run'];
const beforeStrip = {}; STRIP.forEach(id => { const el = byId(id); beforeStrip[id] = el ? { t: el.textContent, c: el.className } : null; });
function restore() {
  byId('procRules').value = beforeVals.procRules; byId('autoModRules').value = beforeVals.autoModRules; byId('beatsBox').value = beforeVals.beatsBox;
  byId('gate_emoji').checked = beforeVals.gate_emoji;
  STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b) { el.textContent = b.t; el.className = b.c; } });
  try { if (typeof lastApplied !== 'undefined' && beforeApplied) { Object.keys(lastApplied).forEach(k => { delete lastApplied[k]; }); Object.assign(lastApplied, beforeApplied); } } catch (e) {}
  // (dials tree-shook 2026-10-22: no dial state to restore)
}
try {
  // ADV1 — procRules entries missing fields: durationMs→60min default, emoji/mode undefined tolerated
  try { applyStatus({ running: false, procRules: [{}, { emoji: 'x' }] }); ck('ADV1-proc-tolerant', byId('procRules').value.indexOf('"minutes": 60') >= 0, byId('procRules').value.slice(0, 120)); } catch (e) { ck('ADV1-proc-tolerant', false, 'threw: ' + ((e && e.message) || e)); }
  // ADV2 — F8 Batch 1: gates null RESETS (explicit default, doctrine A).
  try { byId('gate_emoji').checked = true; applyStatus({ running: false, gates: null }); ck('ADV2-gates-reset', byId('gate_emoji').checked === false, 'null gates → unchecked (explicit default)'); } catch (e) { ck('ADV2-gates-reset', false, 'threw'); }
  // ADV3 — anchor card tolerates null/empty status (no throw, checkbox explicit)
  try { applyAnchorNote(null); applyAnchorNote({}); ck('ADV3-anchor-tolerant', byId('personaAnchorChk').checked === false, 'null/{} → unchecked, no throw'); } catch (e) { ck('ADV3-anchor-tolerant', false, 'threw'); }
  // ADV4 — null-control: same neutral status twice → identical textareas
  try { applyStatus({ running: false, gates: { emoji: true } }); const a = byId('autoModRules').value + byId('beatsBox').value; applyStatus({ running: false, gates: { emoji: true } }); const b = byId('autoModRules').value + byId('beatsBox').value; ck('ADV4-idempotent', a === b, 'repeat neutral identical'); } catch (e) { ck('ADV4-idempotent', false, 'threw'); }
  // ADV5 — XSS via noticeText/persona fields is textContent-safe
  try { applyStatus({ running: false, noticeText: '<img src=x onerror=alert(1)>', character: { name: '<b>evil</b>' } }); ck('ADV5-xss', !document.querySelector('#noticeInput img') && byId('charCurrent').textContent === '<b>evil</b>', 'rendered as text'); } catch (e) { ck('ADV5-xss', false, 'threw'); }
  // ADV6 — neighbors: sync drive then assert (no await between, auto-refresh cannot interleave)
  try { applyStatus({ running: false }); } catch (e) {}
  ck('ADV6-neighbors', byId('runTxt').textContent === 'stopped' && byId('rosterCount').textContent.indexOf('people') >= 0, 'run/roster intact');
} finally { restore(); }
ck('ADV0-restored', byId('procRules').value === beforeVals.procRules, 'restored procRules');
const pass = checks.every(c => c.ok);
return { pass, checks };
