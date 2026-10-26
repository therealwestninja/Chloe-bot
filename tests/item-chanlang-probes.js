// Phase 2 channel-language probes (§2.9 panel legs) — per-row selects render/hide,
// channelLangs apply, null-map degrade, dirty-neutrality, live wire (version-aware:
// .20 bridge answers unknown-command → revert path; .21+ proves the success echo).
// Restores rows, lastChanLangs, chanDirty. Run serially.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:CHANLANG]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
function langSel(id) { const r = document.querySelector('#chanList .chanrow[data-id="' + id + '"]'); return r ? r.querySelector('select.chanlang') : null; }
const snapPub = CHANSTATE.pub.slice(), snapDms = CHANSTATE.dms.slice();
const snapLangs = lastChanLangs ? Object.assign({}, lastChanLangs) : null;
const snapGates = lastChanGates ? JSON.parse(JSON.stringify(lastChanGates)) : null;
const snapDirty = chanDirty;
function restore() {
  CHANSTATE.pub = snapPub.slice(); CHANSTATE.dms = snapDms.slice();
  lastChanLangs = snapLangs ? Object.assign({}, snapLangs) : null;
  lastChanGates = snapGates ? JSON.parse(JSON.stringify(snapGates)) : null;
  chanDirty = snapDirty; renderChanList();
  const note = byId('chanEngineNote'); if (note) note.hidden = !!(lastChanLangs && lastChanGates);
  try { byId('chanAddInput').value = ''; } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
try {
  // L0 — one select per row, 25 options (default + 24 codes), code values present
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'L1', publicChannels: ['L1', 'L2'], dmChannels: [], channelLangs: { L1: 'fr', L2: null }, chanGates: { L1: { speak: true, read: true, remember: true }, L2: { speak: true, read: true, remember: true } } }); } catch (e) { ck('L0-render', false, 'threw'); }
  const sels = [...document.querySelectorAll('#chanList select.chanlang')];
  const opts = sels.length ? [...sels[0].options].map(o => o.value) : [];
  ck('L0-render', sels.length === 2 && opts.length === 25 && opts[0] === '' && opts.includes('fr') && opts.includes('ja') && opts.includes('fi'), 'selects=' + sels.length + ' opts=' + opts.length);
  // L1 — new-engine map applies per-row values; note hides
  ck('L1-apply', langSel('L1') && langSel('L1').value === 'fr' && langSel('L2') && langSel('L2').value === '' && byId('chanEngineNote') && byId('chanEngineNote').hidden === true, 'L1=' + (langSel('L1') && langSel('L1').value) + ' note.hidden=' + (byId('chanEngineNote') && byId('chanEngineNote').hidden));
  // L2 — old engine (no channelLangs): selects hide, note shows, no crash
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'L1', publicChannels: ['L1', 'L2'], dmChannels: [] }); } catch (e) { ck('L2-degrade', false, 'threw'); }
  const sels2 = [...document.querySelectorAll('#chanList select.chanlang')];
  ck('L2-degrade', sels2.length === 2 && sels2.every(s => s.hidden === true) && byId('chanEngineNote') && byId('chanEngineNote').hidden === false, 'hidden=' + sels2.map(s => s.hidden).join(',') + ' note=' + (byId('chanEngineNote') && byId('chanEngineNote').hidden));
  // L3 — map with an unknown id: known rows still apply, nothing crashes
  chanDirty = false;
  try { applyStatus({ running: false, channelId: 'L1', publicChannels: ['L1'], dmChannels: [], channelLangs: { L1: 'ja', nope: 'fr' } }); } catch (e) { ck('L3-unknown', false, 'threw'); }
  ck('L3-unknown', langSel('L1') && langSel('L1').value === 'ja', 'L1=' + (langSel('L1') && langSel('L1').value));
  // L4 — touching a select never dirties the ID save
  chanDirty = false;
  const s4 = langSel('L1'); s4.value = 'de';
  ck('L4-clean', chanDirty === false, 'dirty=' + chanDirty);
  restore();
  // L5 — LIVE wire, version-aware, semantically a no-op: write the channel's own
  // current value back. .21+: ok + echo; .20: {ok:false, unknown command}.
  let st = null;
  try { st = await call('status'); } catch (e) { st = null; }
  if (st && st.ok && st.value) {
    const ids = (st.value.publicChannels && st.value.publicChannels.length) ? st.value.publicChannels : (st.value.channelId ? [st.value.channelId] : []);
    const hasNew = !!(st.value.channelLangs);
    if (ids.length) {
      const rid = String(ids[0]);
      const cur = (hasNew && st.value.channelLangs[rid]) || null;
      let res = null;
      try { res = await call('config.setChannelLang', { channelId: rid, lang: cur }, 15000); } catch (e) { res = null; }
      if (hasNew) ck('L5-live-echo', !!(res && res.ok && res.value && res.value.channelId === rid && (res.value.lang || null) === cur), JSON.stringify(res && res.value));
      else ck('L5-live-echo', !!(res && !res.ok && /unknown command/.test(res.reason || '')), (res && res.reason) || 'no response');
    } else ck('L5-live-echo', false, 'no channels on the bridge');
  } else ck('L5-live-echo', false, 'link down — status failed');
} catch (e) { ck('L0-no-throw', false, String((e && e.message) || e)); }
finally { restore(); try { refresh(); } catch (e) {} }
let ok = CHANSTATE.pub.join(',') === snapPub.join(',') && CHANSTATE.dms.join(',') === snapDms.join(',') && chanDirty === snapDirty;
try { ok = ok && JSON.stringify(lastChanLangs) === JSON.stringify(snapLangs) && JSON.stringify(lastChanGates) === JSON.stringify(snapGates); } catch (e) {}
return { ok, checks };
