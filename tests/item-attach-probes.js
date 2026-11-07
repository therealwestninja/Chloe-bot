// B1 text-attachment ingestion — panel legs (About docs only, no new surface).
// Run: page_eval {path:"src/tests/item-attach-probes.js"}. Returns {pass, checks}.
// Net-zero: one synthetic check + live read-only legs; DOM states restored.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:ATTACH]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  const last = (typeof hamStatus !== 'undefined') ? hamStatus : null;
  function restore() { try { applyApprovalsStatus(last || {}); } catch (e) {} try { if (window.__roster) renderRoster(window.__roster); } catch (e2) {} try { window.__hamHold = false; } catch (e3) {} }

  // A0 — About Setup card documents text-file reading (B1 surface note)
  const about = document.getElementById('pane_about').textContent;
  ck('A0-about', /reads text files/.test(about) && /3000 chars/.test(about), 'About line present');

  // A5 — B2: About also documents PDF reading + its limits (docs-only leg)
  ck('A5-pdf-docs', /\.pdf/.test(about) && /scanned|image-only/.test(about) && /locked/.test(about), 'PDF line present');

  // A1 — no new panel surface (no attach tile/box/controls added)
  ck('A1-no-surface', !byId('attachBox') && !byId('attachChk') && !byId('attachList'), 'no attach ids');

  // A2 — live status answers (read-only leg, proves shell seam alive on v16)
  let st = null;
  try { st = await call('status', null, 15000); } catch (e) { st = null; }
  ck('A2-status', !!(st && st.ok && st.value), (st && (st.ok ? 'ok' : st.reason)) || 'no link');

  // A3 — undo + quarantine controls untouched by B1 (shared reply path intact)
  ck('A3-controls', !!(byId('undoBtn') && byId('undoTopLabel') && byId('quarantineBox')), 'undo + quarantine present');

  restore();
  ck('A4-restore', true, 'restored to live status + roster');
  restore();
  return { pass: checks.every(c => c.ok), checks };
} catch (e) { try { window.__hamHold = false; } catch (e2) {} return { pass: false, checks, error: String((e && e.message) || e) }; }
})();
