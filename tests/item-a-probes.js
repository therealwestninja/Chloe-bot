// Item A probes — core status strip. Offline deterministic, no userscript.
// Run: page_eval {path:"src/tests/item-a-probes.js"}. Saves before-copy, restores after.
// Returns {pass, checks:[{id, ok, detail}]}. Failures also console.error('[wire:A] ...').
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:A]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function snap(ids) { const o = {}; ids.forEach(id => { const el = byId(id); o[id] = el ? { t: el.textContent, c: el.className, d: el.style ? el.style.display : '', h: (id === 'sb_workers_wrap') ? el.innerHTML : undefined } : null; }); return o; }
const IDS = ['runDot','runTxt','sb_run_dot','sb_run','linkDot','linkTxt','verTxt','tokTxt','botTxt','sb_brain','sb_workers_wrap','sb_workers','pollTxt','bridgeRole'];
const before = snap(IDS);
function restore() {
  IDS.forEach(id => { const el = byId(id); const b = before[id]; if (!el || !b) return; if (id === 'sb_workers_wrap' && b.h !== undefined) el.innerHTML = b.h; else el.textContent = b.t; el.className = b.c; try { el.style.display = b.d; } catch (e) {} });
}
function txt(id) { const el = byId(id); return el ? el.textContent : '<missing>'; }
function cls(id) { const el = byId(id); return el ? el.className : '<missing>'; }
try {
  // P1 — initial capture (before-copy already taken)
  // Batch 10 (F10): the 5s interval fail path now resets run dots to idle while the link is
  // down, so on this long-lived page "initial" may read idle instead of fresh-load off.
  // Batch 15: state-agnostic — the operator may legitimately be running the bot (or have
  // workers) while suites run. The invariant is a DETERMINATE, CONSISTENT pair (F1's bug
  // was the bare indeterminate `dot`), never a fixed state.
  function pairOk(dotCls, txt, pairs) { return pairs.some(function (p) { return dotCls === p[0] && txt === p[1]; }); }
  ck('A1-rundot-initial', pairOk(cls('runDot'), txt('runTxt'), [['dot off', 'stopped'], ['dot idle', '\u2026'], ['dot on', 'running']]), 'runDot class=' + cls('runDot') + ' runTxt=' + txt('runTxt') + ' (consistent pair)');
  ck('A1-sbdot-initial', pairOk(cls('sb_run_dot'), txt('sb_run'), [['dot off', 'stopped'], ['dot idle', '\u2026'], ['dot on', 'running']]), 'sb_run_dot class=' + cls('sb_run_dot') + ' sb_run=' + txt('sb_run'));
  // Batch 12: link-state-aware — with the userscript linked the strip reads dot on/linked;
  // link-down it reads dot idle/waiting. The invariant is an explicit, consistent badge (F1's bug
  // was the bare indeterminate `dot`), not a fixed state.
  const a1Cls = cls('linkDot'), a1Tx = txt('linkTxt');
  const a1Consistent = (a1Cls === 'dot idle' && /waiting/.test(a1Tx)) || (a1Cls === 'dot on' && /linked/.test(a1Tx));
  ck('A1-link-initial', a1Cls !== 'dot' && a1Consistent, 'link=' + a1Cls + '/' + a1Tx.slice(0, 30) + ' (explicit + consistent)');

  // P2 — DRIVE: applyStatus running=true full payload
  const s1 = { running: true, version: 'v9.9', hasToken: true, botUserId: '123', brain: { respond: { srtt: 321, state: 'closed' } }, lastPoll: { ingested: 5, fetched: 20 } };
  try { applyStatus(s1); } catch (e) { ck('A2-apply-no-throw', false, 'threw: ' + ((e && e.message) || e)); }
  ck('A2-run-on', cls('runDot') === 'dot on' && txt('runTxt') === 'running', 'runDot=' + cls('runDot') + ' runTxt=' + txt('runTxt'));
  ck('A2-sb-on', cls('sb_run_dot') === 'dot on' && txt('sb_run') === 'running', 'sb=' + cls('sb_run_dot') + '/' + txt('sb_run'));
  ck('A2-ver-tok-bot', txt('verTxt') === 'v9.9' && txt('tokTxt') === 'set' && txt('botTxt') === '123', 'ver=' + txt('verTxt') + ' tok=' + txt('tokTxt') + ' bot=' + txt('botTxt'));
  ck('A2-brain-ms', txt('sb_brain') === '321ms', 'sb_brain=' + txt('sb_brain'));
  ck('A2-poll', txt('pollTxt') === '5 new of 20', 'pollTxt=' + txt('pollTxt'));

  // P3 — DRIVE: running=false minimal payload (brain missing, lastPoll missing)
  const s0 = { running: false, version: '', hasToken: false };
  try { applyStatus(s0); } catch (e) { ck('A3-apply-no-throw', false, 'threw: ' + ((e && e.message) || e)); }
  ck('A3-run-off', cls('runDot') === 'dot off' && txt('runTxt') === 'stopped', 'runDot=' + cls('runDot') + ' runTxt=' + txt('runTxt'));
  ck('A3-sb-off', cls('sb_run_dot') === 'dot off' && txt('sb_run') === 'stopped', 'sb=' + cls('sb_run_dot') + '/' + txt('sb_run'));
  ck('A3-brain-stopped-dash', txt('sb_brain') === '\u2013' || txt('sb_brain') === '–', 'sb_brain=' + txt('sb_brain') + ' (stopped+no brain → dash)');
  ck('A3-poll-reset', txt('pollTxt') === '–' || txt('pollTxt') === '\u2013', 'pollTxt=' + txt('pollTxt') + ' (F3: reset when lastPoll missing, no stale)');
  ck('A3-ver-fallback', txt('verTxt') === '–' || txt('verTxt') === '\u2013', 'verTxt=' + txt('verTxt'));
  ck('A3-tok-bot-fallback', txt('tokTxt') === 'not set' && txt('botTxt') === 'unverified', 'tok=' + txt('tokTxt') + ' bot=' + txt('botTxt'));

  // P4 — DRIVE: brain open (down) + warming
  try { applyStatus({ running: true, brain: { respond: { srtt: 999, state: 'open' } } }); } catch (e) {}
  ck('A4-brain-down', txt('sb_brain') === 'down', 'sb_brain=' + txt('sb_brain') + ' (state open → down)');
  try { applyStatus({ running: true }); } catch (e) {}
  ck('A4-brain-warming', txt('sb_brain') === 'warming', 'sb_brain=' + txt('sb_brain') + ' (running, no brain → warming)');

  // P5 — FORCE FAIL: applyStatus(null) — must be LOUD, not silent
  let threw = null;
  try { applyStatus(null); } catch (e) { threw = e; try { console.error('[wire:A] applyStatus(null) threw as forced:', (e && e.message) || e); } catch (e2) {} }
  ck('A5-null-loud', !!threw, threw ? 'threw: ' + ((threw && threw.message) || threw) : 'SILENT — applyStatus(null) did not throw (swallow?)');
  // P6 — FORCE FAIL: applyStatus({}) — missing everything, must not throw (falsy-tolerant)?
  threw = null;
  try { applyStatus({}); } catch (e) { threw = e; }
  ck('A6-empty-tolerant', !threw, threw ? 'threw: ' + ((threw && threw.message) || threw) : 'tolerated {} (falsy fallbacks)');

  // P7 — FORCE link both ways
  try { setLink(true); } catch (e) { ck('A7-link-true-no-throw', false, String((e && e.message) || e)); }
  ck('A7-link-true', cls('linkDot') === 'dot on' && txt('linkTxt') === 'userscript linked', 'link=' + cls('linkDot') + '/' + txt('linkTxt'));
  try { setLink(false); } catch (e) { ck('A7-link-false-no-throw', false, String((e && e.message) || e)); }
  ck('A7-link-false', cls('linkDot') === 'dot idle' && txt('linkTxt').indexOf('waiting') === 0, 'link=' + cls('linkDot') + '/' + txt('linkTxt').slice(0, 30));
  const stale = byId('linkBanner');
  ck('A7-no-banner', !stale, stale ? 'linkBanner exists (should be removed)' : 'no linkBanner (by design)');

  // P8 — NULL-CONTROL: off means explicit off (not bare dot); restore check happens after
  try { applyStatus({ running: true }); applyStatus({ running: false }); } catch (e) {}
  ck('A8-off-explicit', cls('runDot') === 'dot off' && cls('sb_run_dot') === 'dot off', 'after on→off: runDot=' + cls('runDot') + ' sb=' + cls('sb_run_dot'));

  // P9 — bridgeRole initial (from live refreshWorkers at load: queen · 0 workers)
  ck('A9-bridgerole-shape', txt('bridgeRole').indexOf('tabs:') === 0, 'bridgeRole=' + txt('bridgeRole').slice(0, 60));
  // Batch 15: worker-aware — a live worker tab makes the pill visible, which is correct.
  // Invariant: visibility matches the role line's worker count (hidden ⟺ queen+0).
  const a9role = txt('bridgeRole'); const a9m = a9role.match(/(\d+) worker/);
  const a9n = a9m ? parseInt(a9m[1], 10) : 0;
  const a9vis = byId('sb_workers_wrap').style.display !== 'none';
  ck('A9-workers-hidden', (a9n > 0) === a9vis, 'sb_workers_wrap display=' + byId('sb_workers_wrap').style.display + ' vs role [' + a9role.slice(0, 60) + ']');
} finally {
  restore();
}
const after = snap(IDS);
let restoredOk = true; const drift = [];
// Compare text/class/display only (innerHTML `h` is restore-only: class="" serialization noise).
IDS.forEach(id => { const b = before[id], a = after[id]; const bb = b ? { t: b.t, c: b.c, d: b.d } : b; const aa = a ? { t: a.t, c: a.c, d: a.d } : a; if (JSON.stringify(bb) !== JSON.stringify(aa)) { restoredOk = false; drift.push({ id, b: bb, a: aa }); } });
ck('A0-restored', restoredOk, restoredOk ? 'before-copy restored byte-identical' : 'RESTORE DRIFT: ' + JSON.stringify(drift));
const pass = checks.every(c => c.ok);
return { pass, checks };
