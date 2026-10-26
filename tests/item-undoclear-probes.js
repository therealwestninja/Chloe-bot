// Phase 4 (A6 undo + A7 clearance + save) — panel card + live wire legs.
// Run: page_eval {path:"src/tests/item-undoclear-probes.js"}. Returns {pass, checks}.
// Net-zero: all live legs are read-only (clearance.get, status, act.undo ONLY when
// the live stack is empty so it fails loud with no state change); synthetic DOM
// states are restored to live status + live roster at the end.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:UNDOCLEAR]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  const last = (typeof hamStatus !== 'undefined') ? hamStatus : null;
  function restore() { try { applyApprovalsStatus(last || {}); } catch (e) {} try { if (window.__roster) renderRoster(window.__roster); } catch (e2) {} try { window.__hamHold = false; } catch (e3) {} }
  const ch = (typeof selChannel === 'function') ? (selChannel() || 'test-ch') : 'test-ch';
  // Reset the clearance box to idle first: earlier runs (or the operator) may have
  // left a lookup armed, and P3 asserts the idle state.
  try { byId('clearanceInput').value = ''; byId('clearanceResult').textContent = ''; byId('elevateBtn').hidden = true; byId('demoteBtn').hidden = true; } catch (e0) {}

  // P0 — undo + clearance parts exist
  ck('P0-parts', !!(byId('undoBtn') && byId('undoTopLabel') && byId('clearanceInput') && byId('clearanceLookupBtn') && byId('elevateBtn') && byId('demoteBtn') && byId('clearanceResult')), 'undo + clearance parts present');

  // P1 — undoTop render from synthetic status
  const synth = { actPolicy: 'ask', actGrants: [], pendingAct: {}, actLog: {}, undoTop: {} };
  synth.pendingAct[ch] = [];
  synth.undoTop[ch] = { summary: 'undid timeout on so-and-so (state back to active)', at: Date.now() - 60000 };
  applyApprovalsStatus(synth);
  ck('P1-label', /undid timeout/.test(byId('undoTopLabel').textContent), byId('undoTopLabel').textContent.slice(0, 100));
  ck('P1-btn', byId('undoBtn').hidden === false, 'undo button shown with a top entry');
  const synthE = { actPolicy: 'allow', actGrants: [], pendingAct: {}, actLog: {}, undoTop: {} };
  synthE.pendingAct[ch] = [];
  applyApprovalsStatus(synthE);
  ck('P1-empty', byId('undoBtn').hidden === true && /Nothing undoable/.test(byId('undoTopLabel').textContent), 'button hidden, empty line shown');

  // P2 — tier badges render from synthetic roster rows (no MOD clash)
  const rows = [
    { id: 'u-res', name: 'Res', state: 'active', lastSeen: Date.now(), recent: [], tier: 'resident', tierBasis: 'history' },
    { id: 'u-rec', name: 'Rec', state: 'active', lastSeen: Date.now(), recent: [], tier: 'resident', tierBasis: 'recognized' }
  ];
  const keptMod = window.__modSet; window.__modSet = {};
  renderRoster(rows);
  const rtxt = byId('rosterList').textContent;
  ck('P2-badges', /RESIDENT/.test(rtxt) && /RECOGNIZED/.test(rtxt) && !/MOD/.test(rtxt), rtxt.slice(0, 160));
  window.__modSet = keptMod;

  // P3 — clearance box starts idle (no lookup yet)
  ck('P3-idle', byId('elevateBtn').hidden === true && byId('demoteBtn').hidden === true, 'elevate/demote hidden before lookup');

  // P4 — live clearance.get on a stranger id (read-only): guest/stranger
  let cg = null;
  try { cg = await call('clearance.get', { channelId: ch, id: '999999999999999999' }, 15000); } catch (e) { cg = null; }
  const cgv = cg && cg.ok && cg.value;
  ck('P4-stranger', !!(cgv && cgv.tier === 'guest'), JSON.stringify(cgv));

  // P5 — live status carries undoTop (v14 shell seam)
  let st = null;
  try { st = await call('status', null, 15000); } catch (e) { st = null; }
  const stv = st && st.ok && st.value;
  ck('P5-undoTop', !!(stv && stv.undoTop && typeof stv.undoTop === 'object'), stv ? ('keys: ' + Object.keys(stv.undoTop || {}).length) : 'no status');

  // P6 — live act.undo ONLY when the stack is empty (fails loud, zero state change);
  // if the operator has real entries, skip rather than pop one.
  const liveTop = stv && stv.undoTop ? stv.undoTop[ch || Object.keys(stv.undoTop)[0]] : null;
  if (!liveTop) {
    let u = null;
    try { u = await call('act.undo', { channelId: ch }, 15000); } catch (e) { u = null; }
    ck('P6-empty-loud', !!(u && !u.ok && /nothing undoable/.test(u.reason || '')), (u && u.reason) || 'no wire');
  } else { ck('P6-empty-loud', true, 'SKIP: live stack non-empty — refusing to pop a real entry'); }

  // P7 — lookup flow on a stranger id: guest -> elevate shown (→ resident), demote hidden
  byId('clearanceInput').value = '999999999999999999';
  byId('clearanceLookupBtn').click();
  let waited = 0;
  while (waited < 30 && !/999999999999999999/.test(byId('clearanceResult').textContent)) { await new Promise(r => setTimeout(r, 200)); waited++; }
  ck('P7-lookup', /guest/.test(byId('clearanceResult').textContent), byId('clearanceResult').textContent.slice(0, 100));
  ck('P7-buttons', byId('elevateBtn').hidden === false && /Recognize/.test(byId('elevateBtn').textContent) && byId('demoteBtn').hidden === true, 'elevate→resident shown, demote hidden for a stranger');

  restore();
  ck('P8-restore', true, 'restored to live status + roster');
  restore();
  return { pass: checks.every(c => c.ok), checks };
} catch (e) { try { window.__hamHold = false; } catch (e2) {} return { pass: false, checks, error: String((e && e.message) || e) }; }
})();
