// Batch 16 probes — toggle table, chan merge, saveJsonList, chainEach.
// Offline except B16-14 (value-identical beats save, taken only when the box provably
// tracks the server: clean + non-empty; else honestly skipped). Link-up safe.
// Run: page_eval {path:"src/tests/item-batch16-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B16]', id, detail); } catch (e) {} } }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
const EXTRA = ['ackChk','timeChk','goalChk','sleepChk','paceChk','workChk','delibChk','epiGraphChk','deviceTimeChk'];
const chk0 = {}; EXTRA.forEach(id => { const el = document.getElementById(id); chk0[id] = el ? el.checked : null; });
try {
  // B16-1 — toggle table defaults with missing fields (mirrors E2 for the 9 table boxes)
  try { applyStatus({ running: false }); } catch (e) {}
  const onNow = EXTRA.filter(id => { const el = document.getElementById(id); return el && el.checked; }).sort().join(',');
  ck('B16-1-defaults', onNow === 'ackChk,epiGraphChk,goalChk,paceChk,sleepChk', 'on-with-missing=' + onNow);
  // B16-2 — all truthy → all nine on
  try { applyStatus({ running: false, ackReactions: true, timeAware: true, goalObjects: true, idleConsolidation: true, adaptivePace: true, workingMemory: true, idleDeliberation: true, episodeGraph: true, deviceTime: true }); } catch (e) {}
  const allOn = EXTRA.every(id => { const el = document.getElementById(id); return el && el.checked; });
  ck('B16-2-all-true', allOn, 'all nine checked');
  // B16-3 — mixed: explicit false beats default-on; explicit true beats default-off
  try { applyStatus({ running: false, ackReactions: false, timeAware: true, goalObjects: false }); } catch (e) {}
  const g = id => { const el = document.getElementById(id); return el && el.checked; };
  ck('B16-3-mixed', !g('ackChk') && g('timeChk') && !g('goalChk') && g('sleepChk') && g('paceChk') && g('epiGraphChk') && !g('workChk') && !g('delibChk') && !g('deviceTimeChk'), 'ack/goal off, time on, sleep/pace/epi default-on, work/delib/device off');
  // B16-4 — merge keeps the panel-side label on a stored-ID row
  chanDirty = false;
  chanLabels.srv1 = 'main'; saveChanLabels(); renderChanList();
  try { applyStatus({ running: false, channelId: 'srv1' }); const l = document.querySelector('#chanList .chanrow[data-id="srv1"] .chanlab'); ck('B16-4-label-kept', !!l && l.value === 'main', l ? JSON.stringify(l.value) : 'row missing'); } catch (e) { ck('B16-4-label-kept', false, 'threw'); }
  delete chanLabels.srv1; saveChanLabels();
  // B16-5 — merge drops removed channels, appends new IDs bare
  CHANSTATE.pub = ['old-id']; CHANSTATE.dms = []; chanDirty = false; renderChanList();
  try { applyStatus({ running: false, channelId: 'new-id' }); ck('B16-5-drop-append', JSON.stringify(CHANSTATE.pub) === '["new-id"]', JSON.stringify(CHANSTATE.pub)); } catch (e) { ck('B16-5-drop-append', false, 'threw'); }
  // B16-6 — dm merge shares the helper; absent dmChannels leaves DMs alone
  CHANSTATE.pub = []; CHANSTATE.dms = ['keep']; chanDirty = false; renderChanList();
  try { applyStatus({ running: false, channelId: 'x' }); ck('B16-6-dm-absent', JSON.stringify(CHANSTATE.dms) === '["keep"]', JSON.stringify(CHANSTATE.dms)); } catch (e) { ck('B16-6-dm-absent', false, 'threw'); }
  try { applyStatus({ running: false, dmChannels: ['d1'] }); ck('B16-6b-dm-present', JSON.stringify(CHANSTATE.dms) === '["d1"]', JSON.stringify(CHANSTATE.dms)); } catch (e) { ck('B16-6b-dm-present', false, 'threw'); }
  // B16-7/8 — beats offline paths: invalid JSON + non-array (no transport, byte-identical logs)
  const bb = document.getElementById('beatsBox'), am = document.getElementById('autoModRules');
  const bb0 = bb.value, am0 = am.value;
  bb.value = 'NOT JSON {{{';
  document.getElementById('saveBeatsBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('B16-7-beats-badjson', feedTail(3).join(' / ').includes('beats: invalid JSON'), feedTail(3).join(' / ').slice(0, 120));
  bb.value = '123';
  document.getElementById('saveBeatsBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('B16-8-beats-nonarray', feedTail(3).join(' / ').includes('beats: expected a JSON array'), feedTail(3).join(' / ').slice(0, 120));
  // B16-9/10 — auto-mod offline paths
  am.value = 'NOT JSON {{{';
  document.getElementById('saveAutoModBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('B16-9-automod-badjson', feedTail(3).join(' / ').includes('auto-mod rules: invalid JSON'), feedTail(3).join(' / ').slice(0, 120));
  am.value = '{}';
  document.getElementById('saveAutoModBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('B16-10-automod-nonarray', feedTail(3).join(' / ').includes('auto-mod rules: expected a JSON array'), feedTail(3).join(' / ').slice(0, 120));
  bb.value = bb0; am.value = am0;
  // B16-11 — chainEach counts genuine oks (pure headless, injected transport)
  const n11 = await chainEach(['a', 'b', 'c'], id => Promise.resolve(id === 'a' ? { ok: true } : (id === 'b' ? { ok: false, reason: 'x' } : null)));
  ck('B16-11-chain-count', n11 === 1, 'done=' + n11);
  // B16-12 — chainEach runs sequentially in order
  const order = [];
  await chainEach(['a', 'b'], id => { order.push(id); return Promise.resolve({ ok: true }); });
  ck('B16-12-chain-order', order.join(',') === 'a,b', order.join(','));
  // B16-13 — batchAct with no selection logs without touching prompt/transport
  const boxes = [...document.querySelectorAll('#rosterList .usel')];
  const sel0 = boxes.filter(b => b.checked);
  boxes.forEach(b => { b.checked = false; });
  try { syncBatchBar(); } catch (e) {}
  batchAct('timeout');
  await new Promise(r => setTimeout(r, 300));
  ck('B16-13-empty-selection', feedTail(3).join(' / ').includes('select some users first'), feedTail(3).join(' / ').slice(0, 120));
  sel0.forEach(b => { b.checked = true; });
  try { syncBatchBar(); } catch (e) {}
  // B16-14 — beats success branch, value-identical live save ONLY if the box provably
  // tracks the server (clean flag + parses to a non-empty array); else honestly skipped.
  let parsed = null;
  try { parsed = JSON.parse(bb.value); } catch (e) { parsed = null; }
  if (!boxDirty.beats && Array.isArray(parsed) && parsed.length) {
    document.getElementById('saveBeatsBtn').click();
    let seen = '';
    for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); const t = feedTail(3).join(' / '); if (t.includes('beats saved:')) { seen = t; break; } }
    ck('B16-14-live-save', seen.includes('beats saved: ' + parsed.length + ' beat'), seen.slice(0, 140) || 'no save log within 10s');
  } else {
    ck('B16-14-live-save', true, 'SKIPPED: box ' + (boxDirty.beats ? 'dirty' : 'clean') + '/' + (Array.isArray(parsed) ? parsed.length + ' rows' : 'unparsed') + ' — success branch unproven');
  }
  // restore the nine checkboxes + the channel list to their pre-suite states
  EXTRA.forEach(id => { const el = document.getElementById(id); if (el && chk0[id] !== null) el.checked = chk0[id]; });
  CHANSTATE.pub = []; CHANSTATE.dms = []; chanDirty = false; renderChanList();
} catch (e) { ck('B16-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
