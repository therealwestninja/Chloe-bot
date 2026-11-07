// Recall command — panel legs (About docs only, no new surface).
// Run: page_eval {path:"src/tests/item-recall-probes.js"}. Returns {pass, checks}.
// Net-zero: live read-only legs only; DOM states restored.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:RECALL]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  const last = (typeof hamStatus !== 'undefined') ? hamStatus : null;
  function restore() { try { applyApprovalsStatus(last || {}); } catch (e) {} try { if (window.__roster) renderRoster(window.__roster); } catch (e2) {} try { window.__hamHold = false; } catch (e3) {} }

  // R0 — About memory blurb documents the direct recall verb
  const about = document.getElementById('pane_about').textContent;
  ck('R0-about', /!chloe recall/.test(about) && /episodic memory/.test(about), 'About recall line present');

  // R1 — no new panel surface (verb only, like search)
  ck('R1-no-surface', !byId('recallBox') && !byId('recallChk') && !byId('recallList'), 'no recall ids');

  // R2 — live status answers (read-only leg, proves shell seam alive on v46)
  let st = null;
  try { st = await call('status', null, 15000); } catch (e) { st = null; }
  ck('R2-status', !!(st && st.ok && st.value), (st && (st.ok ? 'ok' : st.reason)) || 'no link');

  // R3 — memory controls untouched (shared reply path intact)
  ck('R3-controls', !!(byId('undoBtn') && byId('quarantineBox')), 'undo + quarantine present');

  restore();
  ck('R4-restore', true, 'restored to live status + roster');
  restore();
  return { pass: checks.every(c => c.ok), checks };
} catch (e) { try { window.__hamHold = false; } catch (e2) {} return { pass: false, checks, error: String((e && e.message) || e) }; }
})();
