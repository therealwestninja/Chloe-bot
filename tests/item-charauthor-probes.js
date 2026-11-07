// Author-box mirrors the live personality (reload fix) — synthetic statuses.
// Restores boxes + lastApplied (lived-in panel).
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:CHARAUTHOR]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const nmEl = byId('charAuthorName'), inEl = byId('charAuthorInstr');
const beforeNm = nmEl ? nmEl.value : null, beforeIn = inEl ? inEl.value : null;
const beforeApplied = (typeof lastApplied !== 'undefined') ? Object.assign({}, lastApplied) : null;
function restore() {
  try {
    if (nmEl && beforeNm !== null) nmEl.value = beforeNm;
    if (inEl && beforeIn !== null) inEl.value = beforeIn;
    if (typeof lastApplied !== 'undefined' && beforeApplied) { Object.keys(lastApplied).forEach(k => { delete lastApplied[k]; }); Object.assign(lastApplied, beforeApplied); }
  } catch (e) {}
}
try {
  // D1 — reload with a custom character installed: empty box fills from status.
  nmEl.value = ''; inEl.value = '';
  lastApplied.charName = ''; lastApplied.charInstr = '';
  try { applyStatus({ running: false, character: { name: 'Zed', instruction: 'Zed is a laconic cartographer.' } }); } catch (e) { ck('D1-no-throw', false, String((e && e.message) || e)); }
  ck('D1-installed-fills', nmEl.value === 'Zed' && inEl.value === 'Zed is a laconic cartographer.' && byId('charCurrent').textContent === 'Zed', 'name/instr/label mirror installed');
  // D2 — a user-typed draft is never clobbered by a refresh.
  nmEl.value = 'MyNew'; inEl.value = 'my draft text';
  try { applyStatus({ running: false, character: { name: 'Zed', instruction: 'Zed is a laconic cartographer.' } }); } catch (e) { ck('D2-no-throw', false, String((e && e.message) || e)); }
  ck('D2-draft-preserved', nmEl.value === 'MyNew' && inEl.value === 'my draft text', 'draft kept across refresh');
  // D3 — default Chloe live (null, key present): clean box returns to the default example.
  lastApplied.charName = 'Zed'; lastApplied.charInstr = 'Zed is a laconic cartographer.';
  nmEl.value = 'Zed'; inEl.value = 'Zed is a laconic cartographer.';
  try { applyStatus({ running: false, character: null }); } catch (e) { ck('D3-no-throw', false, String((e && e.message) || e)); }
  ck('D3-default-restores', nmEl.value === '' && inEl.value === CHLOE_PERSONA && byId('charCurrent').textContent === 'default Chloe', 'box back to default example');
  // D4 — old engine (key absent): box untouched.
  nmEl.value = 'KeepMe'; inEl.value = 'keep me too';
  try { applyStatus({ running: false }); } catch (e) { ck('D4-no-throw', false, String((e && e.message) || e)); }
  ck('D4-absent-untouched', nmEl.value === 'KeepMe' && inEl.value === 'keep me too', 'absent key leaves box alone');
  // D5 — name-only status (no instruction yet): name fills, instruction untouched.
  nmEl.value = ''; inEl.value = ''; lastApplied.charName = ''; lastApplied.charInstr = '';
  try { applyStatus({ running: false, character: { name: 'Aria' } }); } catch (e) { ck('D5-no-throw', false, String((e && e.message) || e)); }
  ck('D5-name-only', nmEl.value === 'Aria' && inEl.value === '' && byId('charCurrent').textContent === 'Aria', 'name fills, instr left alone');
} finally { restore(); }
ck('D0-restored', nmEl.value === beforeNm && inEl.value === beforeIn, 'boxes restored');
const pass = checks.every(c => c.ok);
return { pass, checks };
