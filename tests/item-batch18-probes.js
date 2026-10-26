// Batch 18 probes — saveJsonList third user (procRules) + refreshRoster helper.
// Offline except B18-3 (refreshRoster performs a read-only roster.get, same as the poll).
// The gates/token.prompt/poll.once logRes conversions are expression-identical moves with
// no offline path; they ride the full-board re-green (D drives those buttons live).
// Run: page_eval {path:"src/tests/item-batch18-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B18]', id, detail); } catch (e) {} } }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
try {
  // B18-1 — procRules invalid JSON: no transport, byte-identical log
  const pr = document.getElementById('procRules');
  const pr0 = pr.value;
  pr.value = 'NOT JSON {{{';
  document.getElementById('saveProcRulesBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('B18-1-proc-badjson', feedTail(3).join(' / ').includes('reaction modes: invalid JSON'), feedTail(3).join(' / ').slice(0, 120));
  // B18-2 — procRules non-array: no transport, byte-identical log
  pr.value = '{}';
  document.getElementById('saveProcRulesBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('B18-2-proc-nonarray', feedTail(3).join(' / ').includes('reaction modes: expected a JSON array'), feedTail(3).join(' / ').slice(0, 120));
  pr.value = pr0;
  // B18-3 — refreshRoster: live read-only roster.get through the helper, roster renders
  const before = (window.__roster || []).length;
  await refreshRoster();
  const after = (window.__roster || []).length;
  const rows = document.querySelectorAll('#rosterList .urow').length;
  ck('B18-3-refresh-roster', after === before && rows === after, 'roster ' + before + '→' + after + ', rows ' + rows);
} catch (e) { ck('B18-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
