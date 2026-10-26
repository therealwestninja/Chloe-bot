// Phase 1 channel CRUD probes — render/merge/add/remove/make-primary/labels +
// dirty + focus guards + absent-field skip. Offline except C12 (value-identical
// live save: sends the server's own IDs back, net zero). Restores CHANSTATE,
// labels, chanDirty, strip. Run serially (shares chan list + feed with others).
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:CHAN]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
function chanIds() { return [...document.querySelectorAll('#chanList .chanrow')].map(r => r.getAttribute('data-id')); }
function chanBadge(id) { const r = document.querySelector('#chanList .chanrow[data-id="' + id + '"]'); const b = r ? r.querySelector('.chantype') : null; return b ? b.textContent : null; }
function chanRowBtn(id, label) { const r = document.querySelector('#chanList .chanrow[data-id="' + id + '"]'); if (!r) return null; const bs = [...r.querySelectorAll('button')]; return bs.find(b => b.textContent === label) || null; }
const snapPub = CHANSTATE.pub.slice(), snapDms = CHANSTATE.dms.slice();
const snapLabels = Object.assign({}, chanLabels);
const snapDirty = chanDirty;
const STRIP = ['runDot','runTxt','sb_run_dot','sb_run','verTxt','tokTxt','botTxt','sb_brain','pollTxt'];
const beforeTabProbe = document.querySelector('.tab.active') ? document.querySelector('.tab.active').id : null;
const beforeStrip = {}; STRIP.forEach(id => { const el = byId(id); beforeStrip[id] = el ? { t: el.textContent, c: el.className } : null; });
function restore() {
  CHANSTATE.pub = snapPub.slice(); CHANSTATE.dms = snapDms.slice();
  chanLabels = Object.assign({}, snapLabels); saveChanLabels();
  chanDirty = snapDirty; renderChanList();
  STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b) { el.textContent = b.t; el.className = b.c; } });
  try { byId('chanAddInput').value = ''; } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
  try { if (beforeTabProbe && byId(beforeTabProbe)) byId(beforeTabProbe).click(); } catch (e) {}
}
try {
  // C0 — old textareas gone, CRUD nodes present (setup pane must be visible for focus legs)
  byId('tab_setup').click();
  ck('C0-crud-nodes', !byId('channelsBox') && !byId('dmChannelsBox') && !!byId('chanList') && !!byId('chanAddBtn') && !!byId('setChannelsBtn'), 'boxes gone, list+add+save present');
  // C1 — render from synthetic status: primary badge, extra, DM badge
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'srv1', publicChannels: ['srv1', 'srv2'], dmChannels: ['d1'] }); } catch (e) { ck('C1-render', false, 'threw'); }
  ck('C1-render', JSON.stringify(chanIds()) === JSON.stringify(['srv1', 'srv2', 'd1']) && chanBadge('srv1') === 'primary' && chanBadge('srv2') === 'extra' && chanBadge('d1') === 'DM', 'rows=' + chanIds().join(','));
  // C2 — label edit lands in the map + dirties, no transport
  const lab1 = document.querySelector('#chanList .chanrow[data-id="srv1"] .chanlab');
  lab1.value = 'HQ'; lab1.dispatchEvent(new Event('input', { bubbles: true }));
  ck('C2-label', chanLabels.srv1 === 'HQ' && chanDirty === true, 'label=HQ, dirty');
  // C3 — dirty skips the server merge (pending edits kept)
  try { applyStatus({ running: false, channelId: 'other', publicChannels: ['other'], dmChannels: [] }); } catch (e) {}
  ck('C3-dirty-skip', chanIds().indexOf('srv1') >= 0 && chanIds().indexOf('srv2') >= 0, 'pending rows kept: ' + chanIds().join(','));
  // C4 — clean applies: server wins, absent dmChannels leaves DMs alone
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'new1' }); } catch (e) {}
  ck('C4-clean-apply', JSON.stringify(CHANSTATE.pub) === '["new1"]' && JSON.stringify(CHANSTATE.dms) === '["d1"]', 'pub=' + CHANSTATE.pub.join(',') + ' dms=' + CHANSTATE.dms.join(','));
  // C5 — chan-less status proves nothing: clean list untouched
  const before5 = chanIds().join(',');
  try { applyStatus({ running: false }); } catch (e) {}
  ck('C5-absent-skip', chanIds().join(',') === before5, 'untouched: ' + chanIds().join(','));
  // C6 — focused label skips the rebuild (no clobber mid-typing)
  const lab6 = document.querySelector('#chanList .chanrow[data-id="new1"] .chanlab');
  lab6.focus();
  const focusTook = document.activeElement === lab6;
  try { applyStatus({ running: false, channelId: 'zz', publicChannels: ['zz'] }); } catch (e) {}
  ck('C6-focus-skip', focusTook && chanIds().indexOf('new1') >= 0 && document.activeElement === lab6, focusTook ? 'focused row kept + focus retained' : 'PROBE INVALID: focus did not take');
  try { lab6.blur(); } catch (e) {}
  // C7 — add-row: valid public + DM ids land with the right badges
  chanDirty = false;
  byId('chanAddInput').value = '99999999999999991'; byId('chanAddType').value = 'pub'; byId('chanAddBtn').click();
  byId('chanAddInput').value = '99999999999999992'; byId('chanAddType').value = 'dm'; byId('chanAddBtn').click();
  ck('C7-add', chanIds().indexOf('99999999999999991') >= 0 && chanBadge('99999999999999992') === 'DM' && chanDirty === true && feedTail(4).join(' / ').includes('added'), 'added pub+dm: ' + chanIds().join(','));
  // C8 — add-row refuses a non-snowflake (S-002, no row, loud log)
  byId('chanAddInput').value = 'abc'; byId('chanAddType').value = 'pub'; byId('chanAddBtn').click();
  ck('C8-add-bad', chanIds().indexOf('abc') < 0 && feedTail(3).join(' / ').includes('not a valid channel ID'), 'refused abc');
  // C9 — add-row refuses a duplicate (add a valid id, then add it again)
  byId('chanAddInput').value = '99999999999999993'; byId('chanAddType').value = 'pub'; byId('chanAddBtn').click();
  byId('chanAddInput').value = '99999999999999993'; byId('chanAddBtn').click();
  ck('C9-add-dup', chanIds().filter(id => id === '99999999999999993').length === 1 && feedTail(3).join(' / ').includes('already listed'), 'dup refused');
  // C10 — remove drops the row + dirties
  const rm = chanRowBtn('99999999999999992', 'remove');
  if (rm) rm.click();
  ck('C10-remove', !!rm && chanIds().indexOf('99999999999999992') < 0 && feedTail(3).join(' / ').includes('removed'), 'dm row removed');
  // C11 — make primary reorders (pub[0] moves, badge follows)
  const mp = chanRowBtn('99999999999999991', 'make primary');
  if (mp) mp.click();
  ck('C11-make-primary', !!mp && CHANSTATE.pub[0] === '99999999999999991' && chanBadge('99999999999999991') === 'primary', 'pub=' + CHANSTATE.pub.join(','));
  // C12 — LIVE value-identical save: re-sync to the server, save its own IDs back
  restore(); chanDirty = false;
  let st = null;
  try { st = await call('status'); } catch (e) { st = null; }
  if (st && st.ok) {
    try { applyStatus(st.value); } catch (e) {}
    chanDirty = false;
    byId('setChannelsBtn').click();
    let seen = '';
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); const t = feedTail(3).join(' / '); if (t.includes('channels saved')) { seen = t; break; } }
    ck('C12-live-save', seen.includes('channels saved'), seen.slice(0, 140) || 'no save log within 10s');
  } else { ck('C12-live-save', false, 'link down — status failed, live save unproven'); }
} catch (e) { ck('C0-no-throw', false, String((e && e.message) || e)); }
finally { restore(); try { refresh(); } catch (e) {} }
let ok = CHANSTATE.pub.join(',') === snapPub.join(',') && CHANSTATE.dms.join(',') === snapDms.join(',') && chanDirty === snapDirty;
try { ok = ok && JSON.stringify(chanLabels) === JSON.stringify(snapLabels); } catch (e) {}
STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b && (el.textContent !== b.t || el.className !== b.c)) ok = false; });
ck('C0-restored', ok, ok ? 'chan state + strip restored' : 'DRIFT');
const pass = checks.every(c => c.ok);
return { pass, checks };
