// Queue probes — brain-line architecture lock (post-10-18: lines live engine-side).
// The 10-18 probe drove panel textLine/imageLine globals; those moved into the engine
// (wiring.js localTextLine/localImageLine via makeLocalLine) so the old suite tested
// globals that no longer exist — red by design, not a product bug. This suite locks the
// CURRENT architecture from panel-reachable paths only: absence by design, the direct
// paint-empty decline (no AI, no hang), and the dispatch/unknown/guard shapes in the
// executable scripts (liveSrc — never the inert preloaded copy, Batch 19 lesson).
// Engine-side FIFO/serial/routing is proven headlessly against the REAL shipped source
// in scratch/e2e-queue-lines.js (extracted makeLocalLine, never a hand copy).
// Run: page_eval {path:"src/tests/item-queue-probes.js"}. Returns {pass, checks}.
// Net-zero: writes nothing (paint-empty returns before touching __chloePaint).
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:Q]', id, detail); } catch (e) {} } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
const feedBk = document.getElementById('chatLog') ? document.getElementById('chatLog').textContent.length : -1;
let adminBk = null;
try { adminBk = localStorage.getItem('chloe.adminProfile.v1'); } catch (e) {}
return (async function () {
try {
  // Q-0 — absence by design: neither the old panel names nor the engine-side names
  // leak into panel scope (adversarial: check all four, not just the old two).
  ck('Q-0-no-panel-lines', typeof textLine === 'undefined' && typeof imageLine === 'undefined', 'textLine=' + typeof textLine + ' imageLine=' + typeof imageLine);
  ck('Q-0b-no-engine-leak', typeof localTextLine === 'undefined' && typeof localImageLine === 'undefined', 'localTextLine=' + typeof localTextLine + ' localImageLine=' + typeof localImageLine);

  // Q-1 — direct paint-empty route: declines fast with 'empty prompt', no AI, no hang.
  // Adversarial battery (inputs NOT used while building): '' + whitespace + missing arg.
  let t0 = Date.now(), r1 = null;
  try { r1 = await paint({ prompt: '' }); } catch (e) { r1 = { ok: true, reason: 'THREW ' + ((e && e.message) || e) }; }
  ck('Q-1-paint-empty', !!r1 && r1.ok === false && r1.reason === 'empty prompt' && (Date.now() - t0) < 1000, 'reason=' + (r1 && r1.reason) + ' ' + (Date.now() - t0) + 'ms');
  let r2 = null;
  try { r2 = await paint({ prompt: '   ' }); } catch (e) { r2 = { ok: true }; }
  ck('Q-1b-paint-whitespace', !!r2 && r2.ok === false && r2.reason === 'empty prompt', 'reason=' + (r2 && r2.reason));
  let r3 = null;
  try { r3 = await paint(); } catch (e) { r3 = { ok: true }; }
  ck('Q-1c-paint-missing', !!r3 && r3.ok === false && r3.reason === 'empty prompt', 'reason=' + (r3 && r3.reason));

  // Q-2 — dispatch table + unknown fast-path + pinned-peer guard, in executable scripts only.
  const liveSrc = [...document.querySelectorAll('script')].filter(s => { const t = (s.type || '').toLowerCase(); return t === '' || t.indexOf('javascript') >= 0 || t === 'module'; }).map(s => s.textContent || '').join('\n');
  ck('Q-2-dispatch', liveSrc.indexOf("else if (d.method === 'paint') handler = paint") >= 0 && liveSrc.indexOf("else if (d.method === 'facts') handler = facts") >= 0, 'paint+facts dispatch present');
  ck('Q-2-unknown', liveSrc.indexOf('unknown method:') >= 0, 'unknown fast-path present (no line)');
  ck('Q-2-guard', liveSrc.indexOf('ev.source !== peerWin') >= 0, 'pinned-peer guard present (self-post correctly dropped)');

  // Q-3 — null-controls: this probe writes nothing (paint-empty returns before the Map,
  // no transport, no storage). Feed + admin key identical before/after.
  let adminAfter = null;
  try { adminAfter = localStorage.getItem('chloe.adminProfile.v1'); } catch (e) {}
  const feedAfter = document.getElementById('chatLog') ? document.getElementById('chatLog').textContent.length : -2;
  ck('Q-3-net-zero', adminAfter === adminBk && feedAfter === feedBk, 'admin same=' + (adminAfter === adminBk) + ' feed same=' + (feedAfter === feedBk));
} catch (e) { ck('Q-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
})();
