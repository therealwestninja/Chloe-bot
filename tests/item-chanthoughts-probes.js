// Thoughts self opt-in — one .chanthoughts checkbox per channel card, self
// target only ("Use this channel for Thoughts?"). Checked = this channel's
// fresh summaries post here; off / legacy cross-channel / stale ids all render
// unchecked, and no list of channels ever grows inside a card. Old engine (no
// thoughtsFeeds): the row hides.
// Run: page_eval {path:"src/tests/item-chanthoughts-probes.js"}. Returns {pass, checks}.
// Restores rows, lastThoughtsFeeds, chanDirty. Run serially.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:CHANTHOUGHTS]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function thoughtBoxes(id) { const r = document.querySelector('#chanList .chanrow[data-id="' + id + '"]'); return r ? [...r.querySelectorAll('.chanthoughts input[type=checkbox]')] : []; }
function thoughtRow(id) { const r = document.querySelector('#chanList .chanrow[data-id="' + id + '"]'); return r ? r.querySelector('.chanthoughts') : null; }
const snapPub = CHANSTATE.pub.slice(), snapDms = CHANSTATE.dms.slice();
const snapThoughts = lastThoughtsFeeds ? Object.assign({}, lastThoughtsFeeds) : null;
const snapLangs = lastChanLangs ? Object.assign({}, lastChanLangs) : null;
const snapGates = lastChanGates ? JSON.parse(JSON.stringify(lastChanGates)) : null;
const snapDirty = chanDirty;
function restore() {
  CHANSTATE.pub = snapPub.slice(); CHANSTATE.dms = snapDms.slice();
  lastThoughtsFeeds = snapThoughts ? Object.assign({}, snapThoughts) : null;
  lastChanLangs = snapLangs ? Object.assign({}, snapLangs) : null;
  lastChanGates = snapGates ? JSON.parse(JSON.stringify(snapGates)) : null;
  chanDirty = snapDirty; renderChanList();
  const note = byId('chanEngineNote'); if (note) note.hidden = !!(lastChanLangs && lastChanGates && lastThoughtsFeeds);
  try { byId('chanAddInput').value = ''; } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
try {
  // T0 — one self box per channel card, values are the card's own id (no list)
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'T1', publicChannels: ['T1', 'T2'], dmChannels: [], channelLangs: {}, chanGates: {}, thoughtsFeeds: { T1: 'T1' } }); } catch (e) { ck('T0-render', false, 'threw'); }
  const b1 = thoughtBoxes('T1'), b2 = thoughtBoxes('T2');
  ck('T0-render', b1.length === 1 && b2.length === 1 && b1[0].value === 'T1' && b2[0].value === 'T2', 'T1=' + b1.length + ':' + (b1[0] && b1[0].value) + ' T2=' + b2.length + ':' + (b2[0] && b2[0].value));
  // T1 — the acked map applies: self-mapped T1 checked, unmapped T2 off
  ck('T1-apply', b1[0].checked === true && b2[0].checked === false, 'T1checked=' + b1[0].checked + ' T2checked=' + b2[0].checked);
  // T1b — legacy cross-channel mapping shows unchecked, grows no list
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'T1', publicChannels: ['T1', 'T2'], dmChannels: [], channelLangs: {}, chanGates: {}, thoughtsFeeds: { T1: 'T2' } }); } catch (e) { ck('T1-foreign', false, 'threw'); }
  const f1 = thoughtBoxes('T1'), f2 = thoughtBoxes('T2');
  ck('T1-foreign', f1.length === 1 && f2.length === 1 && !f1[0].checked && !f2[0].checked, 'T1=' + f1.length + (f1[0] && f1[0].checked ? '*' : '') + ' T2=' + f2.length + (f2[0] && f2[0].checked ? '*' : ''));
  // T1c — caption wording
  var cap1 = thoughtRow('T1') && thoughtRow('T1').querySelector('.cap');
  ck('T1-cap', !!(cap1 && cap1.textContent.indexOf('Use this channel for Thoughts?') >= 0), cap1 ? cap1.textContent : 'no cap');
  // T2 — old engine (no thoughtsFeeds): rows hide, note shows, no crash
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'T1', publicChannels: ['T1', 'T2'], dmChannels: [], channelLangs: {}, chanGates: {} }); } catch (e) { ck('T2-degrade', false, 'threw'); }
  ck('T2-degrade', thoughtRow('T1') && thoughtRow('T1').hidden === true && thoughtRow('T2') && thoughtRow('T2').hidden === true && byId('chanEngineNote') && byId('chanEngineNote').hidden === false, 'hidden=' + (thoughtRow('T1') && thoughtRow('T1').hidden) + ' note=' + (byId('chanEngineNote') && byId('chanEngineNote').hidden));
  // T3 — stale target id renders no extra box (the list never grows)
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'T1', publicChannels: ['T1'], dmChannels: [], channelLangs: {}, chanGates: {}, thoughtsFeeds: { T1: 'ZZZ' } }); } catch (e) { ck('T3-stale', false, 'threw'); }
  const b3 = thoughtBoxes('T1');
  ck('T3-stale', b3.length === 1 && b3[0].value === 'T1' && !b3[0].checked, 'boxes=' + b3.map(b => b.value + (b.checked ? '*' : '')).join(','));
  // T4 — touching a box never dirties the ID save
  chanDirty = false;
  const t4 = thoughtBoxes('T1')[0]; t4.checked = !t4.checked;
  ck('T4-clean', chanDirty === false, 'dirty=' + chanDirty);
  restore();
  // T5 — LIVE wire, version-aware, semantically a no-op: write the channel's own
  // current target back. v23+: ok + echo; older: {ok:false, unknown command}.
  let st = null;
  try { st = await call('status'); } catch (e) { st = null; }
  if (st && st.ok && st.value) {
    const ids = (st.value.publicChannels && st.value.publicChannels.length) ? st.value.publicChannels : (st.value.channelId ? [st.value.channelId] : []);
    const hasNew = !!(st.value.thoughtsFeeds);
    if (ids.length) {
      const rid = String(ids[0]);
      const cur = (hasNew && st.value.thoughtsFeeds[rid]) || null;
      let res = null;
      try { res = await call('config.setThoughtsFeed', { channelId: rid, target: cur }, 15000); } catch (e) { res = null; }
      if (hasNew) ck('T5-live-echo', !!(res && res.ok && res.value && res.value.channelId === rid && (res.value.target || null) === cur), JSON.stringify(res && res.value));
      else ck('T5-live-echo', !!(res && !res.ok && /unknown command/.test(res.reason || '')), (res && res.reason) || 'no response');
    } else ck('T5-live-echo', false, 'no channels on the bridge');
  } else ck('T5-live-echo', false, 'link down — status failed');
} catch (e) { ck('T0-no-throw', false, String((e && e.message) || e)); }
finally { restore(); try { refresh(); } catch (e) {} }
let ok = CHANSTATE.pub.join(',') === snapPub.join(',') && CHANSTATE.dms.join(',') === snapDms.join(',') && chanDirty === snapDirty;
try { ok = ok && JSON.stringify(lastThoughtsFeeds) === JSON.stringify(snapThoughts); } catch (e) {}
return { ok, pass: ok, checks };
