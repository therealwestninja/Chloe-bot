// System sweep — System tab + unproven Batch-19 conversions, all net-zero.
// Read-only: refreshWorkspace / refreshTokState / refreshWorkers / diagBtn (chat tools now live in Activity).
// Value-identical writes (server-confirmed same values, restored where flipped):
// savePool(0), prefix(''), imageQueue(8), reaction-notes anchor flip, clean/translate flips,
// personaClear (only when no note anchored), addMod+removeMod probe-id round-trip.
// Run: page_eval {path:"src/tests/item-system-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:SYS]', id, detail); } catch (e) {} } }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
async function waitLog(s, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 15000)) { const t = feedTail(5).join(' / '); if (t.includes(s)) return t; await new Promise(r => setTimeout(r, 400)); } return null; }
try {
  // SYS-1 — workspace refresh (read-only work.get)
  await refreshWorkspace();
  const wbox = document.getElementById('workspaceBox').textContent;
  ck('SYS-1-workspace', wbox.length > 0, wbox.slice(0, 90));
  // SYS-2 — tokState refresh (read-only bridge.status)
  await refreshTokState();
  const tok = document.getElementById('tokState').textContent;
  ck('SYS-2-tokstate', tok.indexOf('tokenizer:') === 0, tok.slice(0, 80));
  // SYS-3 — workers refresh (read-only bridge.status)
  await refreshWorkers();
  const role = document.getElementById('bridgeRole').textContent;
  ck('SYS-3-workers', role.indexOf('tabs:') === 0, role.slice(0, 80));
  // SYS-4 — diagnostics dump lands in the log (read-only engine side)
  document.getElementById('diagBtn').click();
  const dg = await waitLog('diagnostics', 20000) || await waitLog('trace', 20000);
  ck('SYS-4-diag', !!dg, (dg || 'no diag log within 40s').slice(0, 120));
  // SYS-5 — pool value-identical save (poolSizeInput already 0)
  const pool0 = document.getElementById('poolSizeInput').value;
  document.getElementById('savePoolBtn').click();
  const pl = await waitLog('pool target set to ' + pool0, 15000);
  ck('SYS-5-pool', !!pl, (pl || 'no pool log').slice(-100));
  // SYS-6 — prefixes value-identical save (echoes the same string back)
  const pf0 = document.getElementById('prefixInput').value;
  document.getElementById('prefixInput').dispatchEvent(new Event('change', { bubbles: true }));
  const pfl = await waitLog('extra prefixes: ', 15000);
  ck('SYS-6-prefix', !!pfl && document.getElementById('prefixInput').value === pf0, (pfl || 'no prefix log').slice(-80));
  // SYS-7 — imageQueue value-identical save
  const iq0 = document.getElementById('imageQueueInput').value;
  document.getElementById('imageQueueInput').dispatchEvent(new Event('change', { bubbles: true }));
  const iql = await waitLog('image queue depth: ', 15000);
  ck('SYS-7-imgq', !!iql && String(document.getElementById('imageQueueInput').value) === String(iq0), (iql || 'no imgq log').slice(-80));
  // SYS-9 — clean + translate flips with restore (inert while stopped)
  const cl = document.getElementById('cleanChk'), tr = document.getElementById('translateChk');
  cl.click(); const cll = await waitLog('tidy replies: ', 15000); cl.click(); const cll2 = await waitLog('tidy replies: ', 15000);
  ck('SYS-9-clean', !!cll && !!cll2, 'flip+restore logged');
  tr.click(); const trl = await waitLog('per-user translation: ', 15000); tr.click(); const trl2 = await waitLog('per-user translation: ', 15000);
  ck('SYS-9-translate', !!trl && !!trl2, 'flip+restore logged');
  // SYS-10 — personaClear only when no note is anchored (net-zero)
  const nb = document.getElementById('personaNoteBox').textContent;
  if (nb.indexOf('no anchored note') >= 0) {
    document.getElementById('personaClearBtn').click();
    const pcl = await waitLog('anchored note cleared', 15000);
    ck('SYS-10-clear', !!pcl, (pcl || 'no clear log').slice(-80));
  } else ck('SYS-10-clear', true, 'SKIPPED: note anchored (' + nb.slice(0, 40) + ')');
  // SYS-11 — addMod + removeMod probe-id round-trip (net-zero)
  const mi = document.getElementById('modInput'), mi0 = mi.value;
  mi.value = 'ProbeSys22';
  document.getElementById('addModBtn').click();
  const aml = await waitLog('added mod ProbeSys22', 15000);
  let rml = null;
  if (aml) {
    const rows = [...document.querySelectorAll('#modListBox .row')];
    const row = rows.find(r => (r.textContent || '').includes('ProbeSys22'));
    if (row && row.querySelector('button')) { row.querySelector('button').click(); rml = await waitLog('removed mod ProbeSys22', 15000); }
  }
  mi.value = mi0;
  ck('SYS-11-mod-roundtrip', !!aml && !!rml, 'add=' + !!aml + ' remove=' + !!rml);
} catch (e) { ck('SYS-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
