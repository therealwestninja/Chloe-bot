// Batch 21 probes — uselBoxes accessor, setSelectIfClean selects, tokState pair.
// Offline except applyStatus-driven select follows (DOM-only, restored after).
// Run: page_eval {path:"src/tests/item-batch21-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B21]', id, detail); } catch (e) {} } }
try {
  // B21-1 — uselBoxes matches the roster checkboxes rosterSelected reads
  const boxes = uselBoxes();
  const direct = document.querySelectorAll('#rosterList .usel');
  ck('B21-1-usel', boxes.length === direct.length && [...boxes].every(b => b.classList.contains('usel')), 'boxes=' + boxes.length);
  // B21-2 — engageModeSel unfocused follows the server value through the helper
  const em = document.getElementById('engageModeSel');
  const opts = [...em.options].map(o => o.value);
  const other = opts.find(v => v !== em.value);
  const snap = { mode: document.getElementById('modeSel').value, engage: em.value, chk: {}, chan: { pub: CHANSTATE.pub.slice(), dms: CHANSTATE.dms.slice(), labels: Object.assign({}, chanLabels), dirty: chanDirty }, dirty: {} };
  ['ackChk','timeChk','goalChk','sleepChk','paceChk','workChk','delibChk','epiGraphChk','deviceTimeChk'].forEach(id => { const el = document.getElementById(id); snap.chk[id] = el ? el.checked : null; });
  Object.keys(boxDirty).forEach(k => { snap.dirty[k] = boxDirty[k]; });
  if (other !== undefined) {
    try { applyStatus({ running: false, engageMode: other }); } catch (e) {}
    ck('B21-2-engage-follows', em.value === other, 'engage→' + em.value);
  } else { ck('B21-2-engage-follows', true, 'SKIPPED: single-option select'); }
  // B21-3 — modeSel unfocused still follows (helper preserves the guard)
  const mm = document.getElementById('modeSel');
  const mopts = [...mm.options].map(o => o.value);
  const mother = mopts.find(v => v !== mm.value);
  if (mother !== undefined) {
    try { applyStatus({ running: false, addressMode: mother }); } catch (e) {}
    ck('B21-3-mode-follows', mm.value === mother, 'mode→' + mm.value);
  } else { ck('B21-3-mode-follows', true, 'SKIPPED: single-option select'); }
  // restore everything applyStatus touched
  mm.value = snap.mode; em.value = snap.engage;
  Object.keys(snap.chk).forEach(id => { const el = document.getElementById(id); if (el && snap.chk[id] !== null) el.checked = snap.chk[id]; });
  CHANSTATE.pub = snap.chan.pub.slice(); CHANSTATE.dms = snap.chan.dms.slice();
  chanLabels = Object.assign({}, snap.chan.labels); saveChanLabels();
  chanDirty = snap.chan.dirty; renderChanList();
  Object.keys(boxDirty).forEach(k => { delete boxDirty[k]; });
  Object.keys(snap.dirty).forEach(k => { boxDirty[k] = snap.dirty[k]; });
  try { syncBatchBar(); } catch (e) {}
  // B21-4 — tokState pair shares one guarded write (live-source shape)
  const liveSrc = [...document.querySelectorAll('script')].filter(s => { const t = (s.type || '').toLowerCase(); return t === '' || t.indexOf('javascript') >= 0 || t === 'module'; }).map(s => s.textContent || '').join('\n');
  ck('B21-4-tokpair', liveSrc.indexOf("[['exactTokChk', 'exactTokens'], ['cleanChk', 'cleanOutput']]") >= 0, 'tok pair table');
} catch (e) { ck('B21-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
