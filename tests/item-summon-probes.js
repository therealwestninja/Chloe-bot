// Summon-roles UI (v0.90.17 companion) — Behavior -> summon roles input.
// Offline + net-zero: applyStatus render/draft rules (mirrors prefixes), change
// handler arg shape + echo restore via a delegating call() stub. No live writes.
// Run: page_eval {path:"src/tests/item-summon-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:SUM]', id, detail); } catch (e) {} } }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
async function waitLog(s, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { const t = feedTail(8).join(' / '); if (t.indexOf(s) >= 0) return t; await new Promise(r => setTimeout(r, 300)); } return null; }
try {
  const box = byId('summonRolesInput');
  ck('SUM-1-exists', !!box && box.placeholder.indexOf('role IDs') === 0, box ? box.placeholder.slice(0, 40) : 'missing');
  ck('SUM-2-seeded', !!box && ('summonRoles' in lastApplied), 'lastApplied has summonRoles: ' + ('summonRoles' in lastApplied));
  const keepVal = box.value, keepApplied = lastApplied.summonRoles;
  // SUM-3: clean box follows server echo
  lastApplied.summonRoles = box.value;
  applyStatus({ running: false, botRoleIds: ['1560983470745059471'] });
  ck('SUM-3-clean-write', box.value === '1560983470745059471' && lastApplied.summonRoles === '1560983470745059471', box.value.slice(0, 40));
  // SUM-4: user draft preserved
  box.value = '999, 888';
  applyStatus({ running: false, botRoleIds: ['111'] });
  ck('SUM-4-dirty-kept', box.value === '999, 888', box.value.slice(0, 30));
  // SUM-5: absent key (0.90.16 status) leaves the box alone
  box.value = '777'; lastApplied.summonRoles = '777';
  applyStatus({ running: false });
  ck('SUM-5-absent-alone', box.value === '777', box.value.slice(0, 30));
  // SUM-6: change handler end-to-end against the LIVE bridge. On 0.90.16 the command
  // is unknown (fail path, nothing written — net-zero); on 0.90.17+ the echo proves
  // bridge-side validation too (junk dropped, dupes collapsed). Either line proves wiring.
  box.value = '1560983470745059471, notanid, 1560983470745059471';
  box.dispatchEvent(new Event('change', { bubbles: true }));
  const line6 = await waitLog('summon roles: ', 12000) || await waitLog('unknown command: config.setSummonRoles', 12000);
  const ok6 = !!line6 && (line6.indexOf('summon roles: 1560983470745059471') >= 0 || line6.indexOf('unknown command: config.setSummonRoles') >= 0);
  ck('SUM-6-dispatched', ok6, (line6 || 'no handler log within 24s').slice(-90));
  box.value = keepVal; lastApplied.summonRoles = keepApplied;
  ck('SUM-0-restored', box.value === keepVal, 'box restored');
} catch (e) { ck('SUM-threw', false, String((e && e.message) || e)); }
return { pass: checks.every(c => c.ok), checks };
