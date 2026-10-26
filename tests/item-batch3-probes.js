// Batch 3 matrix — F6 dirty-tracking: clean/dirty/focused/absent × present-field/absent-field.
// Saves + restores box values and lastApplied. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B3]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const BOXES = ['autoModRules', 'beatsBox', 'procRules', 'opNoteInput', 'prefixInput', 'imageQueueInput'];
const beforeVals = {}; BOXES.forEach(id => { beforeVals[id] = byId(id).value; });
const beforeApplied = Object.assign({}, (typeof lastApplied !== 'undefined') ? lastApplied : {});
const STRIP = ['runDot','runTxt','sb_run_dot','sb_run'];
const beforeStrip = {}; STRIP.forEach(id => { const el = byId(id); beforeStrip[id] = el ? { t: el.textContent, c: el.className } : null; });
function restore() {
  BOXES.forEach(id => { byId(id).value = beforeVals[id]; });
  STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b) { el.textContent = b.t; el.className = b.c; } });
  try { if (typeof lastApplied !== 'undefined') { Object.keys(lastApplied).forEach(k => { delete lastApplied[k]; }); Object.assign(lastApplied, beforeApplied); } } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
try {
  // B3-1 — clean box + present field → overwritten + recorded
  byId('autoModRules').value = '[]';
  try { delete lastApplied.autoMod; } catch (e) {}
  try { applyStatus({ running: false, autoModRules: [{ a: 1 }] }); ck('B3-1-clean-write', byId('autoModRules').value.indexOf('"a": 1') >= 0 && lastApplied.autoMod === byId('autoModRules').value, 'server value applied + recorded'); } catch (e) { ck('B3-1-clean-write', false, 'threw: ' + ((e && e.message) || e)); }
  // B3-2 — dirty draft + present field → preserved
  byId('autoModRules').value = 'MY DRAFT {{{';
  try { applyStatus({ running: false, autoModRules: [{ a: 2 }] }); ck('B3-2-dirty-kept', byId('autoModRules').value === 'MY DRAFT {{{', 'draft kept, server value refused'); } catch (e) { ck('B3-2-dirty-kept', false, 'threw'); }
  // B3-3 — draft matching incoming → converges (records without visible change)
  const incoming = JSON.stringify([{ a: 3 }], null, 2);
  byId('autoModRules').value = incoming;
  try { applyStatus({ running: false, autoModRules: [{ a: 3 }] }); ck('B3-3-converge', byId('autoModRules').value === incoming && lastApplied.autoMod === incoming, 'converged + recorded'); } catch (e) { ck('B3-3-converge', false, 'threw'); }
  // B3-4 — focused box skipped even when it differs from everything (open its tab first:
  // focus() is a no-op inside a display:none pane, same as for a real user).
  const tabBefore = document.querySelector('.tab.active') ? document.querySelector('.tab.active').id : null;
  byId('tab_behavior').click();
  byId('beatsBox').value = 'FOCUSED DRAFT';
  try { delete lastApplied.beats; } catch (e) {}
  byId('beatsBox').focus();
  const focusTook = document.activeElement === byId('beatsBox');
  try { applyStatus({ running: false, beats: [{ b: 9 }] }); ck('B3-4-focused-skip', focusTook && byId('beatsBox').value === 'FOCUSED DRAFT', focusTook ? 'focused box untouched' : 'PROBE INVALID: focus did not take'); } catch (e) { ck('B3-4-focused-skip', false, 'threw'); }
  try { byId('beatsBox').blur(); } catch (e) {}
  try { if (tabBefore && byId(tabBefore)) byId(tabBefore).click(); } catch (e) {}
  // B3-5 — absent field leaves box alone (even invalid content)
  byId('beatsBox').value = 'STALE DRAFT';
  try { applyStatus({ running: false }); ck('B3-5-absent-alone', byId('beatsBox').value === 'STALE DRAFT', 'absent field → untouched'); } catch (e) { ck('B3-5-absent-alone', false, 'threw'); }
  // B3-6 — per-key isolation: dirty autoMod does not block clean beats
  byId('autoModRules').value = 'DIRTY';
  try { delete lastApplied.beats; } catch (e) {}
  byId('beatsBox').value = '[]';
  try { applyStatus({ running: false, autoModRules: [{ a: 1 }], beats: [{ b: 1 }] }); ck('B3-6-isolation', byId('autoModRules').value === 'DIRTY' && byId('beatsBox').value.indexOf('"b": 1') >= 0, 'dirty kept, clean written'); } catch (e) { ck('B3-6-isolation', false, 'threw'); }
  // B3-7 — force fail: setIfClean on missing element must not throw
  let threw = null;
  try { setIfClean('noSuchBox', 'nope', 'x'); } catch (e) { threw = e; }
  ck('B3-7-missing-el', !threw, threw ? 'threw: ' + ((threw && threw.message) || threw) : 'tolerated');
  // B3-8 — neighbors: badges follow the drive synchronously and textarea content doesn't move them
  // (sync drive+assert: no await between, so the 5s auto-refresh cannot interleave)
  try { applyStatus({ running: false }); } catch (e) {}
  ck('B3-8-neighbors', byId('runTxt').textContent === 'stopped', 'runTxt=' + byId('runTxt').textContent + ' after sync drive');
} finally { restore(); }
let ok = true; BOXES.forEach(id => { if (byId(id).value !== beforeVals[id]) ok = false; });
ck('B3-0-restored', ok, ok ? 'boxes + lastApplied restored' : 'DRIFT in box restore');
const pass = checks.every(c => c.ok);
return { pass, checks };
