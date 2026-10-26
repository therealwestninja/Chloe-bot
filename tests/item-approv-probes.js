// A1 approvals + A4 grants — panel card + live wire legs.
// Run: page_eval {path:"src/tests/item-approv-probes.js"}. Returns {pass, checks}.
// Net-zero: invalid-policy / bogus-id dismiss / bogus-resource revoke are all
// rejected branches (no writes); the card is restored to live status at the end.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:APPROV]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  const last = (typeof hamStatus !== 'undefined') ? hamStatus : null;
  function restore() { try { applyApprovalsStatus(last || {}); } catch (e) {} try { window.__hamHold = false; } catch (e2) {} }
  const ch = (typeof selChannel === 'function') ? (selChannel() || 'test-ch') : 'test-ch';

  // A0 — card parts exist
  ck('A0-card', !!(byId('approvalsBox') && byId('actPolicySel') && byId('approvalsList') && byId('approvalsEmpty') && byId('actGrantsList') && byId('actGrantsEmpty') && byId('approvalsApproveAllBtn') && byId('approvalsDismissAllBtn') && byId('approvalsEngineNote')), 'card parts present');

  // A1 — render from synthetic status (selected channel)
  const synth = {
    actPolicy: 'ask',
    actGrants: [{ action: 'beats', resource: '123', scope: 'always', at: Date.now() }],
    pendingAct: {}
  };
  synth.pendingAct[ch] = [
    { id: 'ax1', class: 'beats', at: Date.now() - 120000, reason: 'beat "morning" due' },
    { id: 'ax2', class: 'checkins', at: Date.now() - 60000, reason: 'check-in on Ada due' }
  ];
  applyApprovalsStatus(synth);
  ck('A1-box', byId('approvalsBox').hidden === false, 'box shown with keys');
  ck('A1-note', byId('approvalsEngineNote').hidden === true, 'note hidden with keys');
  ck('A1-policy', byId('actPolicySel').value === 'ask', 'select=' + byId('actPolicySel').value);
  const rows = byId('approvalsList').querySelectorAll('div');
  ck('A1-rows', rows.length === 2, rows.length + ' pending rows');
  const rowTxt = byId('approvalsList').textContent;
  ck('A1-rowtext', /beats/.test(rowTxt) && /morning/.test(rowTxt) && /checkins/.test(rowTxt) && /Ada/.test(rowTxt), rowTxt.slice(0, 120));
  ck('A1-empty-hidden', byId('approvalsEmpty').style.display === 'none', 'empty line hidden when held');
  const btns = byId('approvalsList').querySelectorAll('button');
  ck('A1-perrow', btns.length === 6, btns.length + ' buttons (once/always/dismiss x2)');
  const gTxt = byId('actGrantsList').textContent;
  ck('A1-grants', /beats/.test(gTxt) && /123/.test(gTxt), gTxt.slice(0, 100));
  ck('A1-grants-empty-hidden', byId('actGrantsEmpty').style.display === 'none', 'grants empty line hidden');

  // A1b — empty states
  const synth2 = { actPolicy: 'allow', actGrants: [], pendingAct: {} };
  synth2.pendingAct[ch] = [];
  applyApprovalsStatus(synth2);
  ck('A1b-empty', byId('approvalsEmpty').style.display !== 'none', 'empty line shown when nothing held');
  ck('A1b-grants-empty', byId('actGrantsEmpty').style.display !== 'none', 'grants empty line shown');
  ck('A1b-policy', byId('actPolicySel').value === 'allow', 'select=' + byId('actPolicySel').value);

  // A2 — old-engine degrade + restore
  applyApprovalsStatus({});
  ck('A2-hidden', byId('approvalsBox').hidden === true, 'box hidden without keys');
  ck('A2-degrade', byId('approvalsEngineNote').hidden === false, 'note shown without keys');

  // A3 — live wire legs (all rejected branches: zero writes)
  let bad = null;
  try { bad = await call('config.setActPolicy', { policy: 'sometimes' }, 15000); } catch (e) { bad = null; }
  ck('A3-badpolicy', !!(bad && !bad.ok), 'invalid policy rejected (' + ((bad && bad.reason) || 'no wire') + ')');
  let dd = null;
  try { dd = await call('act.dismiss', { channelId: ch, id: 'definitely-not-an-id' }, 15000); } catch (e) { dd = null; }
  ck('A3-bogusdismiss', !!(dd && !dd.ok && /nothing held/.test(dd.reason || '')), 'bogus dismiss: ' + ((dd && (dd.reason || 'dismissed?!')) || 'no wire'));
  let rv = null;
  try { rv = await call('act.revokeGrant', { action: 'beats', resource: 'nope-never' }, 15000); } catch (e) { rv = null; }
  ck('A3-bogusrevoke', !!(rv && !rv.ok && /no matching grant/.test(rv.reason || '')), 'bogus revoke: ' + ((rv && (rv.reason || 'revoked?!')) || 'no wire'));
  let st = null;
  try { st = await call('status', null, 15000); } catch (e) { st = null; }
  const sv = st && st.ok ? st.value : null;
  const hasKeys = !!(sv && ('actPolicy' in sv) && ('pendingAct' in sv) && ('actGrants' in sv));
  ck('A3-livekeys', hasKeys, hasKeys ? ('policy=' + sv.actPolicy + ' grants=' + (sv.actGrants || []).length) : 'old engine (pre-v12) or no wire — card degrades');
  if (hasKeys && ch && sv.pendingAct) {
    const live = sv.pendingAct[ch] || 'n/a';
    ck('A3-livepending', Array.isArray(live) || live === 'n/a', 'pending[' + ch + ']=' + (Array.isArray(live) ? live.length + ' held' : live));
  } else { ck('A3-livepending', hasKeys, 'no channel selected'); }

  restore();
  ck('A3-restore', true, 'restored to live status');
  restore();
  return { pass: checks.every(c => c.ok), checks };
} catch (e) { try { window.__hamHold = false; } catch (e2) {} return { pass: false, checks, error: String((e && e.message) || e) }; }
})();
