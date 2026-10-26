// Batch 17 probes — memRow kind-table (memKind + memKeyArgs/memEditArgs).
// All rows stay detached with a fake uid → the engine answers 'not found': the fail
// branches prove the wiring with zero writes. Link-up safe.
// Run: page_eval {path:"src/tests/item-batch17-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B17]', id, detail); } catch (e) {} } }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 10000)) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 400)); }
  return null;
}
try {
  // B17-1 — fact dirty-blur → saveRow through the table → engine fail → 'error' indicator
  const fr = memRow('u-no-such', 'fact', { id: 'f9', text: 'zzz', importance: 7 });
  const fta = fr.querySelector('textarea'), find = fr.querySelector('.memind');
  fta.value = 'zzz edited';
  fta.dispatchEvent(new Event('input', { bubbles: true }));
  fta.dispatchEvent(new Event('blur', { bubbles: true }));
  const e1 = await waitFor(() => find.textContent === 'error' ? 'error' : null);
  ck('B17-1-fact-edit-fail', e1 === 'error' && find.className.includes('err'), 'ind=' + find.textContent + '/' + find.className);
  // B17-2 — insight dirty-blur → insight branch of the table → 'error' indicator
  const ir = memRow('u-no-such', 'insight', { id: 'i9', text: 'night owl' });
  const ita = ir.querySelector('textarea'), iind = ir.querySelector('.memind');
  ita.value = 'night owl edited';
  ita.dispatchEvent(new Event('input', { bubbles: true }));
  ita.dispatchEvent(new Event('blur', { bubbles: true }));
  const e2 = await waitFor(() => iind.textContent === 'error' ? 'error' : null);
  ck('B17-2-insight-edit-fail', e2 === 'error', 'ind=' + iind.textContent);
  // B17-3 — insight delete click → memKind.del insight branch → fail log, row survives
  ir.querySelector('button.memx').click();
  const l3 = await waitFor(() => { const t = feedTail(3).join(' / '); return t.includes('delete memory failed') ? t : null; });
  ck('B17-3-insight-del-fail', !!l3 && !!ir.querySelector('textarea'), (l3 || 'no fail log').slice(0, 120));
  // B17-4 — emptied fact box → removeRow path through the table → fail log
  const er = memRow('u-no-such', 'fact', { id: 'f10', text: 'gone' });
  const eta = er.querySelector('textarea');
  eta.value = '   ';
  eta.dispatchEvent(new Event('input', { bubbles: true }));
  eta.dispatchEvent(new Event('blur', { bubbles: true }));
  const l4 = await waitFor(() => { const t = feedTail(3).join(' / '); return t.includes('delete memory failed') ? t : null; });
  ck('B17-4-empty-is-delete', !!l4, (l4 || 'no fail log').slice(0, 120));
  // B17-5 — importance change → saveRow with new importance → engine fail → 'error'
  const cr = memRow('u-no-such', 'fact', { id: 'f11', text: 'weighted', importance: 3 });
  const cimp = cr.querySelector('input.memimp'), cind = cr.querySelector('.memind');
  cimp.value = '9';
  cimp.dispatchEvent(new Event('change', { bubbles: true }));
  const e5 = await waitFor(() => cind.textContent === 'error' ? 'error' : null);
  ck('B17-5-imp-change-fail', e5 === 'error', 'ind=' + cind.textContent);
} catch (e) { ck('B17-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
