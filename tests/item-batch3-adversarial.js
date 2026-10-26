// Batch 3 adversarial — fresh boxes (opNote/prefix/queue/procRules), simulated save-echo,
// null-controls, neighbors. Restores boxes + lastApplied + tab.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B3a]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const BOXES = ['autoModRules', 'beatsBox', 'procRules', 'opNoteInput', 'prefixInput', 'imageQueueInput'];
const beforeVals = {}; BOXES.forEach(id => { beforeVals[id] = byId(id).value; });
const beforeApplied = Object.assign({}, (typeof lastApplied !== 'undefined') ? lastApplied : {});
const tabBefore = document.querySelector('.tab.active') ? document.querySelector('.tab.active').id : null;
const STRIP = ['runDot','runTxt','sb_run_dot','sb_run'];
const beforeStrip = {}; STRIP.forEach(id => { const el = byId(id); beforeStrip[id] = el ? { t: el.textContent, c: el.className } : null; });
function restore() {
  BOXES.forEach(id => { byId(id).value = beforeVals[id]; });
  STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b) { el.textContent = b.t; el.className = b.c; } });
  try { if (typeof lastApplied !== 'undefined') { Object.keys(lastApplied).forEach(k => { delete lastApplied[k]; }); Object.assign(lastApplied, beforeApplied); } } catch (e) {}
  try { if (tabBefore && byId(tabBefore)) byId(tabBefore).click(); } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
try {
  // ADV1 — opNote present-empty clears a clean box (engine cleared the note)
  byId('opNoteInput').value = 'old note';
  try { delete lastApplied.opNote; } catch (e) {}
  try { applyStatus({ running: false, operatorNote: '' }); ck('ADV1-note-clear', byId('opNoteInput').value === '', 'present-empty clears clean box'); } catch (e) { ck('ADV1-note-clear', false, 'threw'); }
  // ADV2 — opNote dirty draft survives present-different (user retyping while note set)
  byId('opNoteInput').value = 'user retyping…';
  try { applyStatus({ running: false, operatorNote: 'server note' }); ck('ADV2-note-dirty', byId('opNoteInput').value === 'user retyping…', 'dirty draft kept'); } catch (e) { ck('ADV2-note-dirty', false, 'threw'); }
  // ADV3 — simulated save-echo: box set + recorded (as save handlers do), next status converges
  byId('prefixInput').value = '!c, chloe,';
  lastApplied.prefixes = byId('prefixInput').value;
  try { applyStatus({ running: false, commandPrefixes: ['!c', 'zzz'] }); ck('ADV3-echo-converge', byId('prefixInput').value === '!c, zzz' && lastApplied.prefixes === '!c, zzz', 'echo recorded → server update applied'); } catch (e) { ck('ADV3-echo-converge', false, 'threw'); }
  // ADV4 — key explicitly unseeded (simulates pre-Batch-3 code with no baseline):
  // first touch writes. With the load seed in place this path no longer occurs live.
  byId('prefixInput').value = '!c, mine';
  try { delete lastApplied.prefixes; } catch (e) {}
  try { applyStatus({ running: false, commandPrefixes: ['!c', 'srv'] }); ck('ADV4-first-touch', byId('prefixInput').value === '!c, srv', 'unseeded first touch writes (seed prevents this live)'); } catch (e) { ck('ADV4-first-touch', false, 'threw'); }
  // ADV5 — imageQueue string/number coercion: recorded as string, numeric incoming converges
  byId('imageQueueInput').value = '8';
  lastApplied.imageQueue = '8';
  try { applyStatus({ running: false, imageQueueMax: 8 }); ck('ADV5-coerce', byId('imageQueueInput').value === '8', 'number 8 ↔ "8" stable'); } catch (e) { ck('ADV5-coerce', false, 'threw'); }
  // ADV6 — null-control: pre-first-status draft (differs from load seed) + same status
  // twice → stable, never drifts toward server.
  byId('procRules').value = 'WORKING DRAFT';
  const st = { running: false, procRules: [{ emoji: 'e', mode: 'm', durationMs: 60000 }] };
  try { applyStatus(st); const a = byId('procRules').value; applyStatus(st); const b = byId('procRules').value; ck('ADV6-stable', a === 'WORKING DRAFT' && b === 'WORKING DRAFT', 'dirty draft stable across repeats'); } catch (e) { ck('ADV6-stable', false, 'threw'); }
  // ADV7 — giant draft (50k) preserved + neighbors intact
  const giant = new Array(50001).join('g');
  byId('beatsBox').value = giant;
  try { applyStatus({ running: false, beats: [{ b: 1 }] }); ck('ADV7-giant', byId('beatsBox').value === giant && byId('runTxt').textContent === 'stopped', 'giant draft kept, badges intact'); } catch (e) { ck('ADV7-giant', false, 'threw'); }
} finally { restore(); }
let ok = true; BOXES.forEach(id => { if (byId(id).value !== beforeVals[id]) ok = false; });
ck('ADV0-restored', ok, ok ? 'restored' : 'DRIFT');
const pass = checks.every(c => c.ok);
return { pass, checks };
