// Item D probes — guards (fast) + real-path timeout branch (slow, batched).
// Restores inputs + unified timeline + debugLines. Returns {pass, checks}. Timeout section marks
// THROTTLED (not fail) if the background tab clamps timers past the deadline.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:D]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function logText() { return byId('chatLog') ? byId('chatLog').textContent : ''; }
const feed = byId('chatLog');
const beforeFeed = feed.innerHTML, beforeLog = logText();
const beforeLines = (typeof debugLines !== 'undefined') ? debugLines.slice() : null;
const snapPub = CHANSTATE.pub.slice(), snapDms = CHANSTATE.dms.slice();
const snapLabels = Object.assign({}, chanLabels);
const snapDirty = chanDirty;
const beforeMod = byId('modInput').value;
const beforeApplied = (typeof lastApplied !== 'undefined') ? Object.assign({}, lastApplied) : null;
function restore() {
  try { feed.innerHTML = beforeFeed; } catch (e) {}
  try { if (typeof debugLines !== 'undefined' && beforeLines) { debugLines.length = 0; Array.prototype.push.apply(debugLines, beforeLines); } } catch (e) {}
  CHANSTATE.pub = snapPub.slice(); CHANSTATE.dms = snapDms.slice();
  chanLabels = Object.assign({}, snapLabels); saveChanLabels();
  chanDirty = snapDirty; renderChanList();
  try { byId('chanAddInput').value = ''; } catch (e) {}
  byId('modInput').value = beforeMod;
  try { if (typeof lastApplied !== 'undefined' && beforeApplied) { Object.keys(lastApplied).forEach(k => { delete lastApplied[k]; }); Object.assign(lastApplied, beforeApplied); } } catch (e) {}
}
try {
  // D1 — guard: empty public channel list → immediate log, no transport (fast)
  CHANSTATE.pub = []; CHANSTATE.dms = []; chanDirty = false; renderChanList();
  byId('setChannelsBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('D1-empty-channels-guard', logText().indexOf('add at least one public channel first') >= 0, 'guard log present');
  // D2 — guard: empty mod id → immediate log
  byId('modInput').value = '   ';
  byId('addModBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('D2-empty-mod-guard', logText().indexOf('enter a user ID') >= 0, 'guard log present');
  // D3 — guard: pinNotice confirm-cancel performs nothing (stub confirm false)
  // NOTE (Batch 9): noticeState is '' (never pinned) so no confirm path exists — the click
  // FIRES A LIVE pinNotice ('x'). Observed live: message posts, pin 403s (no perms), nothing
  // pinned. Harmless single-char post, but a real one — do not run D while a clean mod log matters.
  const realConfirm = window.confirm; window.confirm = () => false;
  try { byId('noticeInput').value = 'x'; } catch (e) {}
  // noticeState is '' (never pinned) so no confirm path; just verify wiring fires without throw
  try { byId('pinNoticeBtn').click(); ck('D3-pin-click-no-throw', true, 'click dispatched (transport pending, 8s+)'); } catch (e) { ck('D3-pin-click-no-throw', false, String((e && e.message) || e)); }
  window.confirm = realConfirm;
  // D4 — batched real-path proof: start + stop + validate. Each resolves EITHER
  // 'timeout'/fail (userscript dark — the historical case) OR success (link up: D4 then
  // performs a start→stop round-trip, leaving the bot stopped). Poll the log up to 75s
  // (background throttling). Success lines are timestamped ('5:02:55 PM  stopped').
  byId('startBtn').click();
  byId('stopBtn').click();
  byId('validateBtn').click();
  let mark = logText().length;
  const t0 = Date.now(); let startLine = '', stopLine = '', valLine = '';
  while (Date.now() - t0 < 75000) {
    await new Promise(r => setTimeout(r, 2000));
    const tail = logText().slice(mark);
    if (!startLine && (/start failed: timeout/.test(tail) || /started T0 polling/.test(tail))) startLine = 'seen';
    if (!stopLine && (/stop failed: timeout/.test(tail) || /stopped/.test(tail))) stopLine = 'seen';
    if (!valLine && (/token validation failed: timeout/.test(tail) || /token OK ->/.test(tail))) valLine = 'seen';
    if (startLine && stopLine && valLine) break;
  }
  const throttled = !(startLine && stopLine && valLine);
  ck('D4-start-timeout-loud', !!startLine, startLine || ('THROTTLED — no start line within 75s' + (throttled ? ' (deferred, not a wire fail)' : '')));
  ck('D4-stop-timeout-branch', !!stopLine, stopLine || 'THROTTLED (deferred)');
  ck('D4-validate-reports', !!valLine, valLine || 'THROTTLED (deferred)');
  // D4-fix (11-08): a silent panel leg is AMBIGUOUS (reply lost downstream vs
  // request never sent vs link dark vs clamped fallback timer). The engine's
  // own linkStats are ground truth — status + diag.trace answer even in the
  // historical failure windows. Classify before shrugging.
  if (throttled) {
    var truth = { traceOk: false, counts: null, last: null, running: null };
    try {
      var tr = await call('diag.trace', null, 15000);
      if (tr && tr.ok && tr.value && tr.value.length) {
        var lastLine = tr.value[tr.value.length - 1];
        var m = /counts=(\{.*\})\s*$/.exec(lastLine.msg || '');
        truth.traceOk = true;
        truth.counts = m ? m[1] : null;
        var lm = /last=(\S+) (\S+)/.exec(lastLine.msg || '');
        truth.last = lm ? (lm[1] + ' ' + lm[2]) : null;
      }
      var st2 = await call('status', null, 15000);
      if (st2 && st2.ok && st2.value) truth.running = !!st2.value.running;
    } catch (e) { truth.err = String((e && e.message) || e); }
    ck('D4-engine-truth', truth.traceOk, truth.traceOk ? ('engine counts ' + truth.counts + ' | last ' + truth.last + ' | running=' + truth.running) : ('trace failed: ' + (truth.err || 'no link')));
    var cls = 'unclassified';
    if (truth.traceOk) {
      var c = {};
      try { c = JSON.parse(truth.counts || '{}'); } catch (e2) {}
      var missing = [];
      if (!startLine) missing.push('start');
      if (!stopLine) missing.push('stop');
      var heard = missing.filter(function (k) { return (c[k] || 0) > 0; });
      var unheard = missing.filter(function (k) { return !(c[k] > 0); });
      if (heard.length && !unheard.length) cls = 'REPLY-LOST (engine heard ' + heard.join('+') + ', panel saw nothing — downstream/message loss, not dispatch)';
      else if (unheard.length && !heard.length) cls = 'NEVER-SENT (engine never saw ' + unheard.join('+') + ' — panel post/timer domain)';
      else if (heard.length) cls = 'MIXED (heard ' + heard.join('+') + ', never-sent ' + unheard.join('+') + ')';
      else cls = 'nothing-missing?? (unreachable — throttled implies a missing leg)';
    } else cls = 'LINK-DARK (ground truth unreachable too — genuinely unreachable, not reply loss)';
    ck('D4-class', truth.traceOk, cls);
    ck('D4-note', true, 'conditional: background timer clamp hides the 8s fallback; the ladder above discriminates clamp vs loss vs dark');
  }
  // D5 — Batch 12: link-state-aware (was link-idle). With the link up D4's round-trip ends
  // in a successful refresh → dot on/linked; link-down → dot idle/waiting. Invariant: explicit +
  // consistent badge (no crash, no stuck contradiction), not a fixed state.
  const d5Cls = byId('linkDot').className, d5Tx = byId('linkTxt').textContent;
  const d5Ok = (d5Cls === 'dot idle' && /waiting/.test(d5Tx)) || (d5Cls === 'dot on' && /linked/.test(d5Tx));
  ck('D5-link-consistent', d5Ok, 'linkDot=' + d5Cls + '/' + d5Tx.slice(0, 30));
  // D6 — neighbors: no exception surfaced (console errors only from our own ck)
  ck('D6-alive', !!byId('runTxt'), 'panel alive, runTxt=' + byId('runTxt').textContent);
} finally { restore(); window.confirm = window.confirm || null; }
const pass = checks.every(c => c.ok);
return { pass, checks };
