// Batch 9 probes — draft-clobber leftovers (channel CRUD merge, noticeInput,
// tzOffset) + dirty-flag mechanics. Offline synthetic, no transport. Saves + restores
// everything applyStatus touches (chan list + labels, boxes, boxDirty, checks, badges, strip, focus).
// Run serially (shares boxes + boxDirty + tabs with other suites).
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B9]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const BOXES = ['noticeInput', 'tzOffset'];
const beforeVals = {}; BOXES.forEach(id => { beforeVals[id] = byId(id).value; });
const beforeDirty = (typeof boxDirty !== 'undefined') ? Object.assign({}, boxDirty) : null;
const snapPub = CHANSTATE.pub.slice(), snapDms = CHANSTATE.dms.slice();
const snapLabels = Object.assign({}, chanLabels);
const snapDirty = chanDirty;
function chanIds() { return [...document.querySelectorAll('#chanList .chanrow')].map(r => r.getAttribute('data-id')); }
const CHKS = ['affectChk','deferredIntentsChk','contradictionChk','convMemChk','feedbackChk','semanticChk','userModelChk','attentionChk','autoModChk','backfillChk','chansumChk','checkinChk','dmChk','epiChk','factChk','greetChk','imageChk','imageEnhanceChk','imageMemoryChk','lullChk','memChk','moodChk','procChk','reflectChk','selfKnowChk','spChk','summonChk','trustChk','volChk','ackChk','goalChk','sleepChk','paceChk','epiGraphChk','timeChk','deviceTimeChk','workChk','delibChk','toolsChk','gate_emoji','gate_pings','gate_everyone','gate_links','gate_channelLinks'];
const beforeChk = {}; CHKS.forEach(id => { const el = byId(id); beforeChk[id] = el ? el.checked : null; });
const STRIP = ['runDot','runTxt','sb_run_dot','sb_run','verTxt','tokTxt','botTxt','sb_brain','pollTxt'];
const beforeStrip = {}; STRIP.forEach(id => { const el = byId(id); beforeStrip[id] = el ? { t: el.textContent, c: el.className } : null; });
const beforeMode = byId('modeSel') ? byId('modeSel').value : null;
const beforeEngage = byId('engageModeSel') ? byId('engageModeSel').value : null;
const beforeNotice = byId('noticeState') ? byId('noticeState').textContent : null;
const beforeChar = byId('charCurrent') ? byId('charCurrent').textContent : null;
const tabBefore = document.querySelector('.tab.active') ? document.querySelector('.tab.active').id : null;
function markDirty(id) { const el = byId(id); el.dispatchEvent(new Event('input', { bubbles: true })); }
function restore() {
  CHANSTATE.pub = snapPub.slice(); CHANSTATE.dms = snapDms.slice();
  chanLabels = Object.assign({}, snapLabels); saveChanLabels();
  chanDirty = snapDirty; renderChanList();
  try { byId('chanAddInput').value = ''; } catch (e) {}
  BOXES.forEach(id => { byId(id).value = beforeVals[id]; });
  try { if (typeof boxDirty !== 'undefined') { Object.keys(boxDirty).forEach(k => { delete boxDirty[k]; }); if (beforeDirty) Object.assign(boxDirty, beforeDirty); } } catch (e) {}
  CHKS.forEach(id => { const el = byId(id); if (el && beforeChk[id] !== null) el.checked = beforeChk[id]; });
  STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b) { el.textContent = b.t; el.className = b.c; } });
  if (beforeMode !== null) byId('modeSel').value = beforeMode;
  if (beforeEngage !== null) byId('engageModeSel').value = beforeEngage;
  if (beforeNotice !== null) byId('noticeState').textContent = beforeNotice;
  if (beforeChar !== null) byId('charCurrent').textContent = beforeChar;
  try { if (tabBefore && byId(tabBefore)) byId(tabBefore).click(); } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
try {
  // B9-1 — chan dirty: pending add survives the server merge (open Setup first so focus/add take)
  byId('tab_setup').click();
  chanDirty = false;
  byId('chanAddInput').value = '99999999999999991'; byId('chanAddType').value = 'pub';
  byId('chanAddBtn').click();
  try { applyStatus({ running: false, channelId: 'srv1' }); ck('B9-1-chan-dirty', chanIds().indexOf('99999999999999991') >= 0 && chanDirty === true, 'pending row kept: ' + chanIds().join(',')); } catch (e) { ck('B9-1-chan-dirty', false, 'threw'); }
  // B9-2 — chan clean: server list applied (pending gone)
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'srv1', publicChannels: ['srv1'], dmChannels: [] }); ck('B9-2-chan-clean', JSON.stringify(CHANSTATE.pub) === '["srv1"]' && JSON.stringify(CHANSTATE.dms) === '[]', 'pub=' + CHANSTATE.pub.join(',') + ' dms=' + CHANSTATE.dms.join(',')); } catch (e) { ck('B9-2-chan-clean', false, 'threw'); }
  // B9-3 — dm dirty skipped, then clean applied
  byId('chanAddInput').value = '88888888888888888'; byId('chanAddType').value = 'dm';
  byId('chanAddBtn').click();
  try { applyStatus({ running: false, dmChannels: ['d1'] }); ck('B9-3-dm-dirty', JSON.stringify(CHANSTATE.dms) === '["88888888888888888"]', 'dm draft kept: ' + CHANSTATE.dms.join(',')); } catch (e) { ck('B9-3-dm-dirty', false, 'threw'); }
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'srv1', dmChannels: ['d1'] }); ck('B9-3b-dm-clean', JSON.stringify(CHANSTATE.dms) === '["d1"]', 'dm merged: ' + CHANSTATE.dms.join(',')); } catch (e) { ck('B9-3b-dm-clean', false, 'threw'); }
  // B9-4 — noticeInput dirty skipped; converge-on-match clears the flag
  byId('noticeInput').value = 'MY NOTICE DRAFT';
  markDirty('noticeInput');
  try { applyStatus({ running: false, noticeText: 'server notice' }); ck('B9-4-notice-dirty', byId('noticeInput').value === 'MY NOTICE DRAFT', 'notice draft kept'); } catch (e) { ck('B9-4-notice-dirty', false, 'threw'); }
  byId('noticeInput').value = 'server notice';
  try { applyStatus({ running: false, noticeText: 'server notice' }); ck('B9-4b-notice-converge', byId('noticeInput').value === 'server notice' && !boxDirty.noticeInput, 'converged, flag cleared'); } catch (e) { ck('B9-4b-notice-converge', false, 'threw'); }
  // B9-5 — tzOffset dirty skipped (typed-then-blurred), clean applied
  byId('tzOffset').value = '999';
  markDirty('tzOffset');
  try { applyStatus({ running: false, timezoneOffsetMins: -480 }); ck('B9-5-tz-dirty', byId('tzOffset').value === '999', 'tz draft kept: ' + byId('tzOffset').value); } catch (e) { ck('B9-5-tz-dirty', false, 'threw'); }
  byId('tzOffset').value = '0';
  try { delete boxDirty.tzOffset; } catch (e) {}
  try { applyStatus({ running: false, timezoneOffsetMins: -480 }); ck('B9-5b-tz-clean', String(byId('tzOffset').value) === '-480', 'tz applied: ' + byId('tzOffset').value); } catch (e) { ck('B9-5b-tz-clean', false, 'threw'); }
  // B9-6 — save-clear mechanics: dirty skips; cleared flag (as save success sets) applies
  byId('chanAddInput').value = '77777777777777777'; byId('chanAddType').value = 'pub';
  byId('chanAddBtn').click();
  try { applyStatus({ running: false, channelId: 'srv1' }); } catch (e) {}
  const skipped = chanIds().indexOf('77777777777777777') >= 0;
  chanDirty = false;   // save success clears the flag; the next merge applies
  try { applyStatus({ running: false, channelId: 'srv1', publicChannels: ['srv1'], dmChannels: [] }); ck('B9-6-save-clears', skipped && JSON.stringify(CHANSTATE.pub) === '["srv1"]', skipped ? 'skip-then-apply' : 'NOT SKIPPED while dirty'); } catch (e) { ck('B9-6-save-clears', false, 'threw'); }
  // B9-7 — focused label skipped even when clean (Setup already open so focus takes)
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'srv1', publicChannels: ['srv1'], dmChannels: [] }); } catch (e) {}
  const lab7 = document.querySelector('#chanList .chanrow[data-id="srv1"] .chanlab');
  if (lab7) lab7.focus();
  const focusTook = lab7 && document.activeElement === lab7;
  try { applyStatus({ running: false, channelId: 'zz', publicChannels: ['zz'] }); ck('B9-7-focused-skip', focusTook && chanIds().indexOf('srv1') >= 0 && document.activeElement === lab7, focusTook ? 'focused list untouched' : 'PROBE INVALID: focus did not take'); } catch (e) { ck('B9-7-focused-skip', false, 'threw'); }
  try { if (lab7) lab7.blur(); } catch (e) {}
} finally { restore(); }
let ok = true; BOXES.forEach(id => { if (byId(id).value !== beforeVals[id]) ok = false; });
if (CHANSTATE.pub.join(',') !== snapPub.join(',') || CHANSTATE.dms.join(',') !== snapDms.join(',') || chanDirty !== snapDirty) ok = false;
try { if (JSON.stringify(chanLabels) !== JSON.stringify(snapLabels)) ok = false; } catch (e) {}
try { if (typeof boxDirty !== 'undefined' && beforeDirty && JSON.stringify(boxDirty) !== JSON.stringify(beforeDirty)) ok = false; } catch (e) {}
ck('B9-0-restored', ok, ok ? 'boxes + boxDirty restored' : 'DRIFT');
const pass = checks.every(c => c.ok);
return { pass, checks };
