// Reach-out settings (pace, pinned favorites, check-in blacklist) — panel + live engine legs.
// Run: page_eval {path:"src/tests/item-reachout-probes.js"}. Returns {pass, checks}.
// Config-only commands (no sends, no start/stop): safe while running or stopped.
// Restores every value touched; baseline-relative (lived-in panels may carry values).
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:REACH]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const feedEl = byId('chatLog');
const feedBk = feedEl ? feedEl.innerHTML : null;
const linesBk = (typeof debugLines !== 'undefined') ? debugLines.slice() : null;
const reachMinBk = (typeof lastApplied !== 'undefined' && 'reachMin' in lastApplied) ? lastApplied.reachMin : undefined;
const REACH_KEYS = ['lullPatienceMs', 'lullMinGapMs', 'checkinMinInteractions', 'checkinAbsenceMs', 'checkinPerUserGapMs', 'checkinGapMs', 'checkinFavorites', 'checkinBlacklist'];
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  // R0 — baseline: status carries all 8 reach-out keys with sane shapes
  const st0 = await call('status', null, 15000);
  ck('R0-status', !!(st0 && st0.ok && st0.value), 'status acked');
  const v0 = (st0 && st0.ok && st0.value) || {};
  const base = {};
  REACH_KEYS.forEach(k => { base[k] = v0[k]; });
  ck('R0-keys', REACH_KEYS.every(k => k in v0), 'all 8 keys present: ' + REACH_KEYS.map(k => k + '=' + JSON.stringify(v0[k])).join(', '));
  ck('R0-shapes', ['lullPatienceMs', 'lullMinGapMs', 'checkinAbsenceMs', 'checkinPerUserGapMs', 'checkinGapMs'].every(k => isFinite(v0[k])) && isFinite(v0.checkinMinInteractions) && Array.isArray(v0.checkinFavorites) && Array.isArray(v0.checkinBlacklist), 'numbers finite, lists arrays');

  // R1 — panel: settings visible, controls match status
  ck('R1-visible', !!(byId('reachoutSettings') && !byId('reachoutSettings').hidden), 'settings block shown');
  ck('R1-note', !!(byId('reachoutEngineNote') && byId('reachoutEngineNote').hidden), 'engine note hidden');
  const selMatch = [['lullPatienceSel', 'lullPatienceMs'], ['lullGapSel', 'lullMinGapMs'], ['checkinAbsenceSel', 'checkinAbsenceMs'], ['checkinGapSel', 'checkinGapMs'], ['checkinPerUserSel', 'checkinPerUserGapMs']];
  selMatch.forEach(([id, k]) => {
    const el = byId(id);
    ck('R1-' + id, !!(el && el.value === String(v0[k])), id + '=' + (el && el.value) + ' vs status ' + v0[k]);
  });
  ck('R1-min', !!(byId('checkinMinInput') && byId('checkinMinInput').value === String(v0.checkinMinInteractions)), 'min input=' + (byId('checkinMinInput') && byId('checkinMinInput').value));
  const favPills = byId('favList') ? byId('favList').querySelectorAll('.reachpill').length : -1;
  const blkPills = byId('blkList') ? byId('blkList').querySelectorAll('.reachpill').length : -1;
  ck('R1-favlist', favPills === (v0.checkinFavorites || []).length, favPills + ' pill(s) vs ' + (v0.checkinFavorites || []).length + ' favorite(s)');
  ck('R1-blklist', blkPills === (v0.checkinBlacklist || []).length, blkPills + ' pill(s) vs ' + (v0.checkinBlacklist || []).length + ' blacklisted');
  ck('R1-pickers', !!(byId('favPickSel') && byId('blkPickSel')), 'roster pickers present');

  // R2 — old-engine degrade: keyless status hides settings + shows note, then restore
  applyReachoutStatus({});
  ck('R2-hidden', !!(byId('reachoutSettings') && byId('reachoutSettings').hidden), 'settings hidden without keys');
  ck('R2-note', !!(byId('reachoutEngineNote') && !byId('reachoutEngineNote').hidden), 'version note shown without keys');
  applyReachoutStatus(v0);
  ck('R2-restore', !!(byId('reachoutSettings') && !byId('reachoutSettings').hidden) && !!(byId('reachoutEngineNote') && byId('reachoutEngineNote').hidden), 'settings back with keys');

  // R3 — lull timing round-trip (absurd values clamp), status-verified, restored
  const weird = await call('config.setLullTiming', { patienceMs: 1, minGapMs: 1e15 }, 15000);
  ck('R3-clamp', !!(weird && weird.ok && weird.value && weird.value.lullPatienceMs === 3600000 && weird.value.lullMinGapMs === 1209600000), 'clamped to 1h/14d: ' + JSON.stringify(weird && weird.value));
  const stW = await call('status', null, 15000);
  ck('R3-status', !!(stW && stW.ok && stW.value.lullPatienceMs === 3600000 && stW.value.lullMinGapMs === 1209600000), 'status shows clamped values');
  const back = await call('config.setLullTiming', { patienceMs: base.lullPatienceMs, minGapMs: base.lullMinGapMs }, 15000);
  ck('R3-restore-ack', !!(back && back.ok && back.value.lullPatienceMs === base.lullPatienceMs && back.value.lullMinGapMs === base.lullMinGapMs), 'baseline re-acked');
  const stB = await call('status', null, 15000);
  ck('R3-restore-status', !!(stB && stB.ok && stB.value.lullPatienceMs === base.lullPatienceMs && stB.value.lullMinGapMs === base.lullMinGapMs), 'status shows baseline');

  // R4 — check-in timing round-trip, status-verified, restored
  const cw = await call('config.setCheckinTiming', { absenceMs: 1000, gapMs: 0, perUserGapMs: 1e15, minInteractions: 999 }, 15000);
  const cwOk = cw && cw.ok && cw.value && cw.value.checkinAbsenceMs === 21600000 && cw.value.checkinGapMs === 86400000 && cw.value.checkinPerUserGapMs === 7776000000 && cw.value.checkinMinInteractions === 100;
  ck('R4-clamp', !!cwOk, 'clamped 6h/1d/90d/100: ' + JSON.stringify(cw && cw.value));
  const cb = await call('config.setCheckinTiming', { absenceMs: base.checkinAbsenceMs, gapMs: base.checkinGapMs, perUserGapMs: base.checkinPerUserGapMs, minInteractions: base.checkinMinInteractions }, 15000);
  ck('R4-restore-ack', !!(cb && cb.ok && cb.value.checkinAbsenceMs === base.checkinAbsenceMs && cb.value.checkinMinInteractions === base.checkinMinInteractions), 'baseline re-acked');
  const stC = await call('status', null, 15000);
  ck('R4-restore-status', !!(stC && stC.ok && stC.value.checkinAbsenceMs === base.checkinAbsenceMs && stC.value.checkinGapMs === base.checkinGapMs && stC.value.checkinPerUserGapMs === base.checkinPerUserGapMs && stC.value.checkinMinInteractions === base.checkinMinInteractions), 'status shows baseline');

  // R5 — lists round-trip with probe-only fake ids (not real users: no behavior side effects), restored
  const FAKE_F = '123456789012345678', FAKE_B = '999988887777666555';
  ck('R5-fakes-absent', (base.checkinFavorites || []).indexOf(FAKE_F) < 0 && (base.checkinBlacklist || []).indexOf(FAKE_B) < 0, 'fake ids not in baseline (else pick others)');
  const addF = (base.checkinFavorites || []).concat([FAKE_F]), addB = (base.checkinBlacklist || []).concat([FAKE_B]);
  const ladd = await call('config.setCheckinLists', { favorites: addF, blacklist: addB }, 15000);
  ck('R5-add', !!(ladd && ladd.ok && ladd.value.checkinFavorites.indexOf(FAKE_F) >= 0 && ladd.value.checkinBlacklist.indexOf(FAKE_B) >= 0), 'both ids acked: ' + JSON.stringify(ladd && ladd.value));
  const stL = await call('status', null, 15000);
  ck('R5-status', !!(stL && stL.ok && stL.value.checkinFavorites.indexOf(FAKE_F) >= 0 && stL.value.checkinBlacklist.indexOf(FAKE_B) >= 0), 'status echoes both ids');
  applyReachoutStatus(stL.value);   // repaint panels from the live state, like a refresh would
  ck('R5-pills', byId('favList').querySelectorAll('.reachpill').length === addF.length && byId('blkList').querySelectorAll('.reachpill').length === addB.length, 'pills match live lists');
  const bad = await call('config.setCheckinLists', { favorites: 'nope', blacklist: [] }, 15000);
  ck('R5-reject', !(bad && bad.ok), 'non-array favorites rejected: ' + ((bad && bad.reason) || 'ok?!'));
  const lback = await call('config.setCheckinLists', { favorites: base.checkinFavorites || [], blacklist: base.checkinBlacklist || [] }, 15000);
  ck('R5-restore-ack', !!(lback && lback.ok && JSON.stringify(lback.value.checkinFavorites) === JSON.stringify(base.checkinFavorites || []) && JSON.stringify(lback.value.checkinBlacklist) === JSON.stringify(base.checkinBlacklist || [])), 'baseline lists re-acked');
  const stL2 = await call('status', null, 15000);
  ck('R5-restore-status', !!(stL2 && stL2.ok && JSON.stringify(stL2.value.checkinFavorites) === JSON.stringify(base.checkinFavorites || []) && JSON.stringify(stL2.value.checkinBlacklist) === JSON.stringify(base.checkinBlacklist || [])), 'status shows baseline lists');

  // R6 — export carries the keys; import firewall drops junk, applies good
  const exp = await call('export-state', null, 30000);
  const ecfg = (exp && exp.ok && exp.value && exp.value.cfg) || {};
  ck('R6-export', REACH_KEYS.every(k => (base[k] == null && !(k in ecfg)) || JSON.stringify(ecfg[k]) === JSON.stringify(base[k])), 'snapshot carries baseline reach keys');
  const impData = { cfg: { checkinGapMs: 7200000, lullPatienceMs: 5, checkinFavorites: 'nope', token: 'x-secret', bogusReach: 1 } };
  const imp = await call('import-state', { data: impData }, 30000);
  const dropped = imp && imp.ok && imp.value && imp.value.dropped;
  ck('R6-import-ok', !!(imp && imp.ok), 'import acked');
  ck('R6-import-dropped', dropped >= 4, 'dropped>=4 junk (5ms, non-array, token, unknown; saw ' + dropped + ')');
  const stI = await call('status', null, 15000);
  ck('R6-import-applied', !!(stI && stI.ok && stI.value.checkinGapMs === 7200000), 'valid gap applied: ' + (stI && stI.ok && stI.value.checkinGapMs));
  await call('config.setCheckinTiming', { absenceMs: base.checkinAbsenceMs, gapMs: base.checkinGapMs, perUserGapMs: base.checkinPerUserGapMs, minInteractions: base.checkinMinInteractions }, 15000);
  const stF = await call('status', null, 15000);
  const netZero = stF && stF.ok && REACH_KEYS.every(k => JSON.stringify(stF.value[k]) === JSON.stringify(base[k]));
  ck('R6-netzero', !!netZero, 'all 8 keys match run-start baseline');
  applyReachoutStatus(stF.value);   // repaint panels at baseline
} catch (e) {
  ck('R-threw', false, 'probe threw: ' + ((e && e.stack) || e));
}
try { if (feedEl && feedBk !== null) feedEl.innerHTML = feedBk; } catch (e) {}
try { if (typeof debugLines !== 'undefined' && linesBk) { debugLines.length = 0; Array.prototype.push.apply(debugLines, linesBk); } } catch (e) {}
try { if (typeof lastApplied !== 'undefined') { if (reachMinBk === undefined) delete lastApplied.reachMin; else lastApplied.reachMin = reachMinBk; } } catch (e) {}
try { window.__hamHold = false; } catch (e) {}
const pass = checks.every(c => c.ok);
return { pass, checks };
})();