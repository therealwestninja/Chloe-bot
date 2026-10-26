// Item A adversarial — reviewer hat (Rule C §2). Inputs NOT used in builder probes.
// Verifies: ugly inputs, guard trips, null-controls as hard assertions,
// neighboring systems untouched. Restores before-copy. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:A-adv]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function snap(ids) { const o = {}; ids.forEach(id => { const el = byId(id); o[id] = el ? { t: el.textContent, c: el.className, d: el.style ? el.style.display : '', v: ('value' in el) ? String(el.value).slice(0, 80) : undefined, h: (id === 'sb_workers_wrap') ? el.innerHTML : undefined } : null; }); return o; }
const IDS = ['runDot','runTxt','sb_run_dot','sb_run','linkDot','linkTxt','verTxt','tokTxt','botTxt','sb_brain','pollTxt','bridgeRole','sb_workers_wrap'];
const NEIGHBOR = ['rosterCount','feed','modCount','tokState'];
const before = snap(IDS.concat(NEIGHBOR));
function restore() { IDS.concat(NEIGHBOR).forEach(id => { const el = byId(id); const b = before[id]; if (!el || !b) return; if (b.t !== undefined && el.textContent !== undefined && id !== 'feed') { if (id === 'sb_workers_wrap' && b.h !== undefined) el.innerHTML = b.h; else el.textContent = b.t; } el.className = b.c; try { el.style.display = b.d; } catch (e) {} }); }
function txt(id) { return byId(id) ? byId(id).textContent : '<missing>'; }
function cls(id) { return byId(id) ? byId(id).className : '<missing>'; }
try {
  // ADV1 — truthy/falsy coercion: running="yes" must light on (code uses ternary, not ===true)
  try { applyStatus({ running: 'yes' }); ck('ADV1-truthy-string', cls('runDot') === 'dot on' && txt('runTxt') === 'running', 'running="yes" → ' + cls('runDot') + '/' + txt('runTxt')); } catch (e) { ck('ADV1-truthy-string', false, 'threw: ' + ((e && e.message) || e)); }
  // ADV2 — running undefined/null → off (falsy), must not throw
  try { applyStatus({ running: undefined }); ck('ADV2-undefined-off', cls('runDot') === 'dot off', 'undefined → ' + cls('runDot')); } catch (e) { ck('ADV2-undefined-off', false, 'threw'); }
  // ADV3 — brain null / respond null → warming when running (else-branch), no throw
  try { applyStatus({ running: true, brain: null }); ck('ADV3-brain-null', txt('sb_brain') === 'warming', 'brain null → ' + txt('sb_brain')); } catch (e) { ck('ADV3-brain-null', false, 'threw'); }
  try { applyStatus({ running: true, brain: { respond: null } }); ck('ADV3b-respond-null', txt('sb_brain') === 'warming', 'respond null → ' + txt('sb_brain')); } catch (e) { ck('ADV3b-respond-null', false, 'threw'); }
  // ADV4 — srtt 0 (falsy but != null check uses != null, so 0ms must show "0ms", not warming)
  try { applyStatus({ running: true, brain: { respond: { srtt: 0, state: 'closed' } } }); ck('ADV4-srtt-zero', txt('sb_brain') === '0ms', 'srtt 0 → ' + txt('sb_brain')); } catch (e) { ck('ADV4-srtt-zero', false, 'threw'); }
  // ADV5 — giant version string (5000 chars) must render, not throw/truncate (documents DoS surface)
  const giant = new Array(5001).join('v');
  try { applyStatus({ running: false, version: giant }); ck('ADV5-giant', txt('verTxt').length === 5000, 'len=' + txt('verTxt').length); } catch (e) { ck('ADV5-giant', false, 'threw'); }
  // ADV6 — lastPoll zeros must write "0 new of 0" (not skipped: object exists)
  try { applyStatus({ running: true, lastPoll: { ingested: 0, fetched: 0 } }); ck('ADV6-zero-poll', txt('pollTxt') === '0 new of 0', 'poll=' + txt('pollTxt')); } catch (e) { ck('ADV6-zero-poll', false, 'threw'); }
  // ADV7 — lastPoll half-shape {ingested:5} → "5 new of –" (F4: per-field guard, no undefined leak)
  try { applyStatus({ running: true, lastPoll: { ingested: 5 } }); ck('ADV7-half-poll', txt('pollTxt') === '5 new of \u2013', 'poll=' + txt('pollTxt')); } catch (e) { ck('ADV7-half-poll', false, 'threw'); }
  // ADV8 — guard trip: stale linkBanner must be removed by setLink
  const host = byId('app'); const fake = document.createElement('div'); fake.id = 'linkBanner'; host.appendChild(fake);
  try { setLink(false); ck('ADV8-banner-guard', !byId('linkBanner'), byId('linkBanner') ? 'banner SURVIVED (guard failed)' : 'stale banner removed (guard tripped)'); } catch (e) { ck('ADV8-banner-guard', false, 'threw'); }
  // ADV9 — setLink coercion: undefined/null → idle/waiting (falsy), 1 → on
  try { setLink(undefined); const a = cls('linkDot') === 'dot idle'; setLink(1); const b = cls('linkDot') === 'dot on'; setLink(false); ck('ADV9-coercion', a && b, 'undefined→idle:' + a + ' 1→on:' + b); } catch (e) { ck('ADV9-coercion', false, 'threw'); }
  // ADV10 — NULL-CONTROL: neutral input twice → byte-identical (idempotent)
  try { applyStatus({ running: false, version: 'x', hasToken: false }); const s1 = snap(IDS); applyStatus({ running: false, version: 'x', hasToken: false }); const s2 = snap(IDS); ck('ADV10-idempotent', JSON.stringify(s1) === JSON.stringify(s2), 'repeat neutral input identical'); } catch (e) { ck('ADV10-idempotent', false, 'threw'); }
  // ADV11 — neighboring systems untouched by status writes
  const nbAfter = snap(NEIGHBOR);
  let nbOk = true; NEIGHBOR.forEach(id => { if (id === 'feed') return; if (JSON.stringify(nbAfter[id]) !== JSON.stringify(before[id])) nbOk = false; });
  ck('ADV11-neighbors', nbOk, nbOk ? 'roster/mod/tok untouched' : 'NEIGHBOR DRIFT: ' + JSON.stringify(NEIGHBOR.map(id => ({ id, b: before[id], a: nbAfter[id] }))).slice(0, 400));
} finally { restore(); }
const after = snap(IDS.concat(NEIGHBOR));
let resOk = true; const drift = [];
const norm = o => (o ? { t: o.t, c: o.c, d: o.d } : o);
IDS.forEach(id => { if (JSON.stringify(norm(before[id])) !== JSON.stringify(norm(after[id]))) { resOk = false; drift.push(id); } });
ck('ADV0-restored', resOk, resOk ? 'restored' : 'DRIFT: ' + JSON.stringify(drift).slice(0, 500));
const pass = checks.every(c => c.ok);
return { pass, checks };
