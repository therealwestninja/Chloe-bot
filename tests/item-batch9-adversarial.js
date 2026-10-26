// Batch 9 adversarial — dirty stability, absent-field behavior, empty edges, neighbors.
// Restores boxes + boxDirty + strip. Run serially.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B9a]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const BOXES = ['noticeInput', 'tzOffset'];
const beforeVals = {}; BOXES.forEach(id => { beforeVals[id] = byId(id).value; });
const beforeDirty = (typeof boxDirty !== 'undefined') ? Object.assign({}, boxDirty) : null;
const snapPub = CHANSTATE.pub.slice(), snapDms = CHANSTATE.dms.slice();
const snapLabels = Object.assign({}, chanLabels);
const snapDirty = chanDirty;
function chanIds() { return [...document.querySelectorAll('#chanList .chanrow')].map(r => r.getAttribute('data-id')); }
const STRIP = ['runDot','runTxt','sb_run_dot','sb_run'];
const beforeStrip = {}; STRIP.forEach(id => { const el = byId(id); beforeStrip[id] = el ? { t: el.textContent, c: el.className } : null; });
function markDirty(id) { byId(id).dispatchEvent(new Event('input', { bubbles: true })); }
function restore() {
  CHANSTATE.pub = snapPub.slice(); CHANSTATE.dms = snapDms.slice();
  chanLabels = Object.assign({}, snapLabels); saveChanLabels();
  chanDirty = snapDirty; renderChanList();
  try { byId('chanAddInput').value = ''; } catch (e) {}
  BOXES.forEach(id => { byId(id).value = beforeVals[id]; });
  try { if (typeof boxDirty !== 'undefined') { Object.keys(boxDirty).forEach(k => { delete boxDirty[k]; }); if (beforeDirty) Object.assign(boxDirty, beforeDirty); } } catch (e) {}
  STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b) { el.textContent = b.t; el.className = b.c; } });
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
try {
  // ADV1 — dirty draft stable across repeated statuses (never drifts toward server)
  byId('chanAddInput').value = '99999999999999991'; byId('chanAddType').value = 'pub';
  byId('chanAddBtn').click();
  const st = { running: false, channelId: 'srv1', publicChannels: ['srv1'], dmChannels: [] };
  try { applyStatus(st); const a = chanIds().join(','); applyStatus(st); const b = chanIds().join(','); ck('ADV1-stable', a.indexOf('99999999999999991') >= 0 && b === a, 'pending stable across repeats'); } catch (e) { ck('ADV1-stable', false, 'threw'); }
  // ADV2 — absent channel fields: dirty box untouched AND clean box untouched (no server list → no merge)
  const before2 = chanIds().join(',');
  try { applyStatus({ running: false }); ck('ADV2-absent', chanIds().join(',') === before2, 'absent fields → untouched: ' + before2); } catch (e) { ck('ADV2-absent', false, 'threw'); }
  // ADV3 — noticeText absent: notice box untouched either way
  byId('noticeInput').value = 'keep me';
  try { applyStatus({ running: false }); ck('ADV3-notice-absent', byId('noticeInput').value === 'keep me', 'no noticeText → untouched'); } catch (e) { ck('ADV3-notice-absent', false, 'threw'); }
  // ADV4 — tz null: untouched
  byId('tzOffset').value = '123';
  try { applyStatus({ running: false }); ck('ADV4-tz-absent', byId('tzOffset').value === '123', 'null offset → untouched'); } catch (e) { ck('ADV4-tz-absent', false, 'threw'); }
  // ADV5 — giant label (5000 chars) capped at 80 + preserved, neighbors intact
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'srv1', publicChannels: ['srv1'], dmChannels: [] }); } catch (e) {}
  const lab5 = document.querySelector('#chanList .chanrow[data-id="srv1"] .chanlab');
  lab5.value = new Array(5001).join('g');
  lab5.dispatchEvent(new Event('input', { bubbles: true }));
  try { applyStatus({ running: false, channelId: 'srv1' }); ck('ADV5-giant', chanLabels.srv1 === new Array(81).join('g') && chanDirty === true, 'label capped at 80 + kept, len=' + (chanLabels.srv1 || '').length); } catch (e) { ck('ADV5-giant', false, 'threw'); }
  // ADV6 — neighbors: strip untouched by box writes (sync drive then assert)
  try { applyStatus({ running: false, channelId: 'srv1' }); } catch (e) {}
  ck('ADV6-neighbors', byId('runTxt').textContent === 'stopped', 'runTxt=' + byId('runTxt').textContent + ' after sync drive');
} finally { restore(); }
let ok = true; BOXES.forEach(id => { if (byId(id).value !== beforeVals[id]) ok = false; });
if (CHANSTATE.pub.join(',') !== snapPub.join(',') || CHANSTATE.dms.join(',') !== snapDms.join(',') || chanDirty !== snapDirty) ok = false;
try { if (JSON.stringify(chanLabels) !== JSON.stringify(snapLabels)) ok = false; } catch (e) {}
ck('ADV0-restored', ok, ok ? 'boxes + boxDirty restored' : 'DRIFT');
const pass = checks.every(c => c.ok);
return { pass, checks };
