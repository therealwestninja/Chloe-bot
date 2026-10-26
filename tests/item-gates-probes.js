// Channel speak/read/remember gates — panel + live engine legs.
// Run: page_eval {path:"src/tests/item-gates-probes.js"}. Returns {pass, checks}.
// Live legs flip gates on the PRIMARY channel and restore (tiny mute/blind windows).
// Restores: gate values, CHANSTATE/maps/list HTML, feed HTML, debugLines, __hamHold.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:GATES]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const feedEl = byId('chatLog');
const feedBk = feedEl ? feedEl.innerHTML : null;
const linesBk = (typeof debugLines !== 'undefined') ? debugLines.slice() : null;
const chanBk = { pub: CHANSTATE.pub.slice(), dms: CHANSTATE.dms.slice(), langs: lastChanLangs, gates: lastChanGates, labels: JSON.stringify(chanLabels) };
const listBk = byId('chanList') ? byId('chanList').innerHTML : null;
let gateBk = null;
function restore() {
  try { CHANSTATE.pub = chanBk.pub; CHANSTATE.dms = chanBk.dms; } catch (e) {}
  try { lastChanLangs = chanBk.langs; lastChanGates = chanBk.gates; } catch (e) {}
  try { chanLabels = JSON.parse(chanBk.labels); saveChanLabels(); } catch (e) {}
  try { if (byId('chanList') && listBk !== null) byId('chanList').innerHTML = listBk; } catch (e) {}
  try { if (feedEl && feedBk !== null) feedEl.innerHTML = feedBk; } catch (e) {}
  try { if (typeof debugLines !== 'undefined' && linesBk) { debugLines.length = 0; Array.prototype.push.apply(debugLines, linesBk); } } catch (e) {}
  try { window.__hamHold = false; } catch (e) {}
}
function gateBoxes(id) { const r = document.querySelector('#chanList .chanrow[data-id="' + id + '"]'); return r ? [...r.querySelectorAll('.changates input')] : []; }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  // G0 — baseline: live status carries a chanGates map, all on
  const st0 = await call('status', null, 15000);
  ck('G0-status', !!(st0 && st0.ok && st0.value && st0.value.chanGates), 'status carries chanGates');
  const ids = st0 && st0.ok ? Object.keys(st0.value.chanGates) : [];
  ck('G0-channels', ids.length > 0, ids.length + ' channel(s) in map');
  const primary = ids[0];
  const g0 = st0.value.chanGates[primary];
  gateBk = JSON.parse(JSON.stringify(st0.value.chanGates));
  ck('G0-default-on', g0.speak && g0.read && g0.remember, primary + ' all on');

  // G1 — panel: 3 checked boxes per row from the live map
  const boxes = gateBoxes(primary);
  ck('G1-three', boxes.length === 3, boxes.length + ' gate boxes on primary row');
  ck('G1-checked', boxes.every(b => b.checked && !b.hidden), boxes.map(b => b.checked + '/' + b.hidden).join(','));

  // G2 — old-engine degrade: status without chanGates hides boxes + shows note
  mergeChanList({ publicChannels: CHANSTATE.pub.slice(), dmChannels: CHANSTATE.dms.slice() });
  const boxesOld = gateBoxes(primary);
  ck('G2-hidden', boxesOld.length === 3 && boxesOld.every(b => b.hidden), 'boxes hidden without map');
  ck('G2-note', byId('chanEngineNote') && !byId('chanEngineNote').hidden, 'version note shown without map');
  mergeChanList(st0.value);   // restore live render (map present again)
  ck('G2-restore', gateBoxes(primary).every(b => !b.hidden) && byId('chanEngineNote').hidden, 'boxes back with map');

  // G3 — live flip+restore per gate on primary, status-verified both ways
  for (const gate of ['speak', 'remember', 'read']) {
    const off = await call('config.setChannelGate', { channelId: primary, gate, on: false });
    ck('G3-' + gate + '-off', !!(off && off.ok && off.value && off.value.gates && off.value.gates[gate] === false), gate + ' off acked');
    const stOff = await call('status', null, 15000);
    ck('G3-' + gate + '-status', !!(stOff && stOff.ok && stOff.value.chanGates[primary][gate] === false), 'status map shows ' + gate + ' off');
    const on = await call('config.setChannelGate', { channelId: primary, gate, on: true });
    ck('G3-' + gate + '-on', !!(on && on.ok && on.value && on.value.gates && on.value.gates[gate] === true), gate + ' restored');
  }

  // G4 — read-off BEHAVIORAL proof: the engine stops polling that channel and
  // the queen logs one transition line into the trace ring (per flip, not per poll).
  // Needs the bot running (stopped = no polls at all).
  const stRun = await call('status', null, 15000);
  if (!(stRun && stRun.ok && stRun.value && stRun.value.running)) {
    await call('start', null, 20000);
    await new Promise(r => setTimeout(r, 8000));
  }
  await call('config.setChannelGate', { channelId: primary, gate: 'read', on: false });
  let found = false, dump = '';
  for (let i = 0; i < 6 && !found; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const tr = await call('diag.trace', null, 15000);
      dump = JSON.stringify((tr && tr.ok && tr.value) || tr);
      found = dump.indexOf('read gate is off') >= 0 && dump.indexOf(primary) >= 0;
    } catch (e) { dump = 'trace err ' + ((e && e.message) || e); }
  }
  ck('G4-gated-poll', found, found ? 'read-gate transition in trace for primary' : 'no gate line in 30s; tail=' + dump.slice(-200));
  await call('config.setChannelGate', { channelId: primary, gate: 'read', on: true });

  // G7 — export firewall: a disabled gate ships in the snapshot; all-on restores
  // the START-of-run key set (lived-in panels may carry pre-existing gates).
  const preOff = {};
  Object.keys(gateBk).forEach(id => {
    const off = ['speak', 'read', 'remember'].filter(g => gateBk[id][g] === false).sort();
    if (off.length) preOff[id] = off;   // export omits all-on channels, so drop empties to match
  });
  await call('config.setChannelGate', { channelId: primary, gate: 'speak', on: false });
  const expOff = await call('export-state', null, 30000);
  const offKey = expOff && expOff.ok && expOff.value && expOff.value.cfg && expOff.value.cfg['chanGate:' + primary];
  ck('G7-export-off', !!(offKey && offKey.speak === false && Object.keys(offKey).length === 1), 'snapshot carries {speak:false}: ' + JSON.stringify(offKey));
  await call('config.setChannelGate', { channelId: primary, gate: 'speak', on: true });
  const expOn = await call('export-state', null, 30000);
  const seenOff = {};
  if (expOn && expOn.ok && expOn.value && expOn.value.cfg) Object.keys(expOn.value.cfg).forEach(k => {
    const m = k.match(/^chanGate:(\d{15,25})$/);
    if (m) seenOff[m[1]] = ['speak', 'read', 'remember'].filter(g => expOn.value.cfg[k][g] === false).sort();
  });
  ck('G7-export-on', JSON.stringify(seenOff) === JSON.stringify(preOff), 'export key set matches run start: ' + JSON.stringify(seenOff));

  // G8 — import firewall: only well-formed chanGate entries survive; junk is dropped.
  // Bounded blast radius: only chanGate keys for known channels; pre-test values restored after.
  const second = ids[1] || primary, third = ids[2] || primary;
  const impData = { cfg: {} };
  impData.cfg['chanGate:' + primary] = { speak: false, dance: true };
  impData.cfg['chanGate:12'] = { speak: false };
  impData.cfg['chanGate:' + second] = 'nope';
  impData.cfg['chanGate:' + third] = { remember: 0 };
  const imp = await call('import-state', { data: impData }, 30000);
  ck('G8-import-ok', !!(imp && imp.ok), 'import-state acked');
  ck('G8-import-dropped', !!(imp && imp.ok && imp.value && imp.value.dropped === 3), 'dropped 3 junk entries (saw ' + ((imp && imp.ok && imp.value && imp.value.dropped) || '?') + ')');
  const stImp = await call('status', null, 15000);
  const gImp = stImp && stImp.ok && stImp.value.chanGates[primary];
  ck('G8-import-applied', !!(gImp && gImp.speak === false && gImp.dance === undefined), 'speak off applied, dance stripped: ' + JSON.stringify(gImp));
  const gImp2 = stImp && stImp.ok && stImp.value.chanGates[second];
  ck('G8-import-others', !!((second === primary) || (JSON.stringify(gImp2) === JSON.stringify(gateBk[second]))), 'other channel matches run start: ' + JSON.stringify(gImp2));
  await call('config.setChannelGate', { channelId: primary, gate: 'speak', on: true });

  // G5 — bad gate rejected, unknown shapes rejected
  const bad = await call('config.setChannelGate', { channelId: primary, gate: 'dance', on: false });
  ck('G5-bad-gate', !!(bad && !bad.ok), 'unknown gate rejected: ' + ((bad && bad.reason) || 'ok?!'));

  // G6 — null control: everything back on, boxes checked
  const st1 = await call('status', null, 15000);
  const g1 = st1 && st1.ok && st1.value.chanGates[primary];
  ck('G6-restored', JSON.stringify(g1) === JSON.stringify(gateBk[primary]), 'primary matches run start: ' + JSON.stringify(g1));
  mergeChanList(st1.value);
  ck('G6-boxes', gateBoxes(primary).every(b => b.checked === (gateBk[primary][['speak','read','remember'][gateBoxes(primary).indexOf(b)]] !== false)), 'DOM boxes match run start');
} catch (e) { ck('G0-no-throw', false, String((e && e.message) || e)); }
// best-effort restore of pre-test gate values (all-on expected, but honor the snapshot)
try {
  if (gateBk) for (const id of Object.keys(gateBk)) for (const g of ['speak', 'read', 'remember'])
    await call('config.setChannelGate', { channelId: id, gate: g, on: gateBk[id][g] !== false });
} catch (e) {}
restore();
try { refresh(); } catch (e) {}
const pass = checks.every(c => c.ok);
return { pass, checks };
})()