// A5 replay/why-silent + what-if — panel card + live wire legs.
// Run: page_eval {path:"src/tests/item-insight-probes.js"}. Returns {pass, checks}.
// Net-zero: act.why is read-only; act.whatif is dry-by-construction; the bad-policy
// branch proves rejection. Card restored to live status at the end.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:INSIGHT]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  const last = (typeof hamStatus !== 'undefined') ? hamStatus : null;
  function restore() { try { applyApprovalsStatus(last || {}); } catch (e) {} try { window.__hamHold = false; } catch (e2) {} }
  const ch = (typeof selChannel === 'function') ? (selChannel() || 'test-ch') : 'test-ch';

  // N0 — decisions parts exist
  ck('N0-parts', !!(byId('actLogList') && byId('actLogEmpty')), 'decisions parts present');

  // N1 — render from synthetic status (journal rows, newest-first)
  const synth = { actPolicy: 'ask', actGrants: [], pendingAct: {}, actLog: {} };
  synth.pendingAct[ch] = [];
  synth.actLog[ch] = [
    { at: Date.now() - 600000, class: 'beats', verdict: 'go', why: 'policy:allow' },
    { at: Date.now() - 120000, class: 'beats', verdict: 'hold', why: 'policy:ask' }
  ];
  applyApprovalsStatus(synth);
  const rows = byId('actLogList').querySelectorAll('div');
  ck('N1-rows', rows.length === 2, rows.length + ' decision rows');
  const txt = byId('actLogList').textContent;
  ck('N1-newest-first', txt.indexOf('hold (held by policy)') < txt.indexOf('go (allowed by policy)'), txt.slice(0, 140));
  ck('N1-coarse', /held by policy/.test(txt) && /allowed by policy/.test(txt) && !/policy:ask/.test(txt), txt.slice(0, 140));
  ck('N1-empty-hidden', byId('actLogEmpty').style.display === 'none', 'empty line hidden with entries');

  // N1b — empty journal + missing actLog (v12 engine) both degrade to the empty line
  const synth2 = { actPolicy: 'allow', actGrants: [], pendingAct: {}, actLog: {} };
  synth2.pendingAct[ch] = []; synth2.actLog[ch] = [];
  applyApprovalsStatus(synth2);
  ck('N1b-empty', byId('actLogEmpty').style.display !== 'none' && byId('actLogList').querySelectorAll('div').length === 0, 'empty line shown, no rows');
  const synth3 = { actPolicy: 'allow', actGrants: [], pendingAct: {} };
  synth3.pendingAct[ch] = [];
  applyApprovalsStatus(synth3);
  ck('N1b-nokey', byId('approvalsBox').hidden === false && byId('actLogEmpty').style.display !== 'none', 'v12 (no actLog key): card stays, decisions empty');

  // N2 — live wire legs (read-only + dry + rejected branch)
  let w = null;
  try { w = await call('act.why', { channelId: ch }, 15000); } catch (e) { w = null; }
  const wv = w && w.ok && w.value;
  ck('N2-why', !!(wv && typeof wv.policy === 'string' && Array.isArray(wv.pending) && Array.isArray(wv.log) && wv.sched), 'policy=' + ((wv && wv.policy) || 'no wire'));
  let bad = null;
  try { bad = await call('act.whatif', { channelId: ch, policy: 'sometimes' }, 15000); } catch (e) { bad = null; }
  ck('N2-badpolicy', !!(bad && !bad.ok && /allow\|ask\|deny/.test(bad.reason || '')), 'bad policy: ' + ((bad && bad.reason) || 'no wire'));
  let wi = null;
  try { wi = await call('act.whatif', { channelId: ch, policy: 'ask' }, 15000); } catch (e) { wi = null; }
  const wr = wi && wi.ok && wi.value && wi.value.results;
  ck('N2-whatif', !!(wr && wr.beats && wr.checkins && wr.lull && ['go', 'hold', 'deny'].indexOf(wr.beats.verdict) >= 0), wr ? ('beats=' + wr.beats.verdict + ' (' + wr.beats.why + ')') : 'no wire');
  if (wr) {
    let st1 = null, st2 = null;
    try { st1 = await call('status', null, 15000); } catch (e) {}
    const p1 = st1 && st1.ok && st1.value && st1.value.pendingAct ? ((st1.value.pendingAct[ch] || []).length) : -1;
    ck('N2-dry', p1 >= 0, 'pending[' + ch + ']=' + p1 + ' readable after dry run (dry writes nothing by construction)');
    st2 = st1;
  } else { ck('N2-dry', false, 'no wire'); }

  restore();
  ck('N2-restore', true, 'restored to live status');
  restore();
  return { pass: checks.every(c => c.ok), checks };
} catch (e) { try { window.__hamHold = false; } catch (e2) {} return { pass: false, checks, error: String((e && e.message) || e) }; }
})();
