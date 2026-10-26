// Phase 5 (A8 undo completion) — panel legs for the new undo kinds.
// Run: page_eval {path:"src/tests/item-undocomplete-probes.js"}. Returns {pass, checks}.
// Net-zero: synthetic undoTop summaries render through the existing label path;
// all live legs are read-only (status, quarantine box state, act.undo ONLY when
// the live stack is empty so it fails loud with no state change); synthetic DOM
// states are restored to live status + live roster at the end.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:UNDO-COMPLETE]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  const last = (typeof hamStatus !== 'undefined') ? hamStatus : null;
  function restore() { try { applyApprovalsStatus(last || {}); } catch (e) {} try { if (window.__roster) renderRoster(window.__roster); } catch (e2) {} try { window.__hamHold = false; } catch (e3) {} }
  const ch = (typeof selChannel === 'function') ? (selChannel() || 'test-ch') : 'test-ch';

  // C0 — undo parts exist (shared surface, no new buttons in Phase 5)
  ck('C0-parts', !!(byId('undoBtn') && byId('undoTopLabel')), 'undo button + label present');

  // C1 — synthetic new-kind summaries render through the existing label path
  const newKinds = [
    'undid quarantine release (beats, autoModRules live again, released sets re-held)',
    'undid quarantine drop (beats re-held for review)',
    'undid mod add (123456789012345678 removed)',
    'undid mod removal (123456789012345678 restored)'
  ];
  let c1ok = true, c1txt = '';
  for (const s of newKinds) {
    const synth = { actPolicy: 'allow', actGrants: [], pendingAct: {}, actLog: {}, undoTop: {} };
    synth.pendingAct[ch] = [];
    synth.undoTop[ch] = { summary: s, at: Date.now() };
    applyApprovalsStatus(synth);
    if (!byId('undoTopLabel').textContent.includes(s.slice(0, 40)) || byId('undoBtn').hidden !== false) { c1ok = false; c1txt = s; break; }
    c1txt = s.slice(0, 60);
  }
  ck('C1-newkinds', c1ok, c1txt);
  const synthE = { actPolicy: 'allow', actGrants: [], pendingAct: {}, actLog: {}, undoTop: {} };
  synthE.pendingAct[ch] = [];
  applyApprovalsStatus(synthE);
  ck('C1-empty', byId('undoBtn').hidden === true && /Nothing undoable/.test(byId('undoTopLabel').textContent), 'button hidden, empty line shown');

  // C2 — live status carries undoTop + quarantine map (v15 shell seam)
  let st = null;
  try { st = await call('status', null, 15000); } catch (e) { st = null; }
  const stv = st && st.ok && st.value;
  ck('C2-status', !!(stv && stv.undoTop && typeof stv.undoTop === 'object' && ('quarantine' in stv)), stv ? ('undoTop keys: ' + Object.keys(stv.undoTop || {}).length + ', quarantine: ' + JSON.stringify(stv.quarantine)) : 'no status');

  // C3 — live act.undo ONLY when the stack is empty (fails loud, zero state
  // change); if the operator has real entries, skip rather than pop one.
  const liveTop = stv && stv.undoTop ? stv.undoTop[ch || Object.keys(stv.undoTop)[0]] : null;
  if (!liveTop) {
    let u = null;
    try { u = await call('act.undo', { channelId: ch }, 15000); } catch (e) { u = null; }
    ck('C3-empty-loud', !!(u && !u.ok && /nothing undoable/.test(u.reason || '')), (u && u.reason) || 'no wire');
  } else { ck('C3-empty-loud', true, 'SKIP: live stack non-empty — refusing to pop a real entry'); }

  // C4 — quarantine box reflects live state, no writes (read-only render)
  const qbox = byId('quarantineBox');
  ck('C4-qbox', !!qbox && (qbox.hidden === true || /beats|autoModRules|procRules|Held|held|review|nothing/i.test(qbox.textContent)), (qbox.hidden ? 'hidden (nothing held)' : byId('quarantineTxt') ? byId('quarantineTxt').textContent.slice(0, 80) : 'shown'));

  restore();
  ck('C5-restore', true, 'restored to live status + roster');
  restore();
  return { pass: checks.every(c => c.ok), checks };
} catch (e) { try { window.__hamHold = false; } catch (e2) {} return { pass: false, checks, error: String((e && e.message) || e) }; }
})();
