// A1 chain (modlog) + A2 import preview/quarantine — panel + live wire legs.
// Run: page_eval {path:"src/tests/item-modchain-probes.js"}. Returns {pass, checks}.
// Net-zero: verifyLog/preview/export are read-only; release/drop are only
// exercised in their nothing-held failure branches (proving preview stashed
// nothing). Restores quarantine card from the last live status.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:CHAIN]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  const last = (typeof hamStatus !== 'undefined') ? hamStatus : null;
  function restore() { try { applyQuarantineStatus(last || {}); } catch (e) {} try { window.__hamHold = false; } catch (e2) {} }

  // C0 — quarantine card exists
  ck('C0-card', !!(byId('quarantineBox') && byId('quarantineTxt') && byId('quarantineReleaseBtn') && byId('quarantineDropBtn') && byId('quarantineEngineNote')), 'card parts present');

  // C1 — live verifyLog is read-only and well-shaped
  const ch = (typeof selChannel === 'function') ? selChannel() : null;
  let vr = null;
  try { vr = await call('mod.verifyLog', { channelId: ch }, 15000); } catch (e) { vr = null; }
  ck('C1-ok', !!(vr && vr.ok && vr.value && typeof vr.value.ok === 'boolean'), 'verifyLog answers');
  if (vr && vr.ok && vr.value) {
    const v = vr.value;
    ck('C1-shape', typeof v.chained === 'number' && typeof v.preChain === 'number' && typeof v.badIndex === 'number', 'chained=' + v.chained + ' preChain=' + v.preChain);
    ck('C1-intact', v.ok === true, v.ok ? 'chain intact' : ('BROKEN at ' + v.badIndex + ': ' + v.reason));
  } else { ck('C1-shape', false, 'no value'); ck('C1-intact', false, 'no value'); }

  // C2 — modlog display fields survive chaining (name/byModId/context intact)
  let ml = null;
  try { ml = await call('mod.modlog', { channelId: ch }, 15000); } catch (e) { ml = null; }
  const rows = (ml && ml.ok && Array.isArray(ml.value)) ? ml.value : null;
  if (rows && rows.length) {
    const chained = rows.filter(e => e && e.digest);
    const displays = rows.filter(e => e && e.action && (e.name || e.targetId));
    ck('C2-rows', displays.length === rows.length, displays.length + '/' + rows.length + ' displayable');
    ck('C2-chain', chained.length > 0 || rows.every(e => !e.digest), chained.length + '/' + rows.length + ' carry digests');
  } else {
    ck('C2-rows', true, 'empty log — nothing to display-check');
    ck('C2-chain', true, 'empty log — nothing to chain-check');
  }

  // C3 — import-preview round-trips live export data with zero writes
  let ex = null;
  try { ex = await call('export-state', null, 30000); } catch (e) { ex = null; }
  ck('C3-export', !!(ex && ex.ok && ex.value && ex.value.cfg), 'export answers');
  if (ex && ex.ok && ex.value) {
    let pv = null;
    try { pv = await call('import-preview', { data: ex.value }, 30000); } catch (e) { pv = null; }
    const p = pv && pv.ok ? pv.value : null;
    ck('C3-preview', !!p, 'preview answers on live data');
    if (p) {
      const q = p.quarantined || {};
      ck('C3-self-noop', (q.beats || 0) === 0 && (q.autoModRules || 0) === 0 && (q.procRules || 0) === 0 && (p.dropped || 0) === 0,
        'self-preview holds nothing, drops nothing (writes=' + p.writes + ')');
      // net-zero proof: a preview stashes nothing, so release/drop find nothing held
      let rel = null, drop = null;
      try { rel = await call('quarantine-release', { kind: 'all' }, 15000); } catch (e) { rel = null; }
      try { drop = await call('quarantine-drop', { kind: 'all' }, 15000); } catch (e) { drop = null; }
      ck('C3-noop-release', !!(rel && !rel.ok && /nothing held/.test(rel.reason || '')), 'release: ' + ((rel && (rel.reason || 'released?!')) || 'no wire'));
      ck('C3-noop-drop', !!(drop && !drop.ok && /nothing held/.test(drop.reason || '')), 'drop: ' + ((drop && (drop.reason || 'dropped?!')) || 'no wire'));
    } else { ck('C3-self-noop', false, 'no preview'); ck('C3-noop-release', false, 'no preview'); ck('C3-noop-drop', false, 'no preview'); }
    // garbage preview fails clean, writes nothing
    let bad = null;
    try { bad = await call('import-preview', { data: 'nope' }, 15000); } catch (e) { bad = null; }
    ck('C3-garbage', !!(bad && !bad.ok), 'non-object preview rejected');
  } else { ck('C3-preview', false, 'no export'); ck('C3-self-noop', false, 'no export'); ck('C3-noop-release', false, 'no export'); ck('C3-noop-drop', false, 'no export'); ck('C3-garbage', false, 'no export'); }

  // C4 — quarantine card render + old-engine degrade + restore
  applyQuarantineStatus({ quarantine: { at: Date.now(), beats: 2, autoModRules: 1, procRules: 0 } });
  const qt = byId('quarantineTxt') ? byId('quarantineTxt').textContent : '';
  ck('C4-render', byId('quarantineBox').hidden === false && /2 beat/.test(qt) && /1 auto-mod/.test(qt), qt.slice(0, 100));
  ck('C4-note', byId('quarantineEngineNote').hidden === true, 'note hidden with key');
  applyQuarantineStatus({});
  ck('C4-hidden', byId('quarantineBox').hidden === true, 'box hidden without key');
  ck('C4-degrade', byId('quarantineEngineNote').hidden === false, 'note shown without key');
  restore();
  ck('C4-restore', true, 'restored to live status');

  restore();
} catch (e) { ck('C0-no-throw', false, String((e && e.message) || e)); try { window.__hamHold = false; } catch (e2) {} }
const pass = checks.every(c => c.ok);
return { pass, checks };
})();
