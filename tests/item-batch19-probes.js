// Batch 19 probes — logRes onOk + addMod empty-input guard.
// Fully offline (no transport). The nine converted handlers are expression-identical
// moves onto the already-proven logRes helper; they ride the full-board re-green.
// Run: page_eval {path:"src/tests/item-batch19-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B19]', id, detail); } catch (e) {} } }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
try {
  // B19-1 — logRes onOk: success logs the message, then runs onOk exactly once
  let hits = 0;
  logRes({ ok: true, value: { x: 1 } }, 'msg-ok-123', 'fail-x', function (r) { hits += (r.value && r.value.x) || 0; });
  await new Promise(r => setTimeout(r, 200));
  ck('B19-1-onok-runs', hits === 1 && feedTail(4).join(' / ').includes('msg-ok-123'), 'hits=' + hits);
  // B19-2 — logRes without onOk still works (backward compatible), fail path untouched
  logRes({ ok: true }, 'msg-ok-456', 'fail-y');
  logRes(null, 'never-logged', 'fail-y');
  await new Promise(r => setTimeout(r, 200));
  const tail = feedTail(5).join(' / ');
  ck('B19-2-compat', tail.includes('msg-ok-456') && tail.includes('fail-y: unknown') && !tail.includes('never-logged'), tail.slice(0, 140));
  // B19-3 — addMod empty input: pre-transport guard, no engine call
  const mi = document.getElementById('modInput');
  const mi0 = mi.value;
  mi.value = '   ';
  document.getElementById('addModBtn').click();
  await new Promise(r => setTimeout(r, 300));
  ck('B19-3-addmod-empty', feedTail(3).join(' / ').includes('enter a user ID'), feedTail(3).join(' / ').slice(0, 100));
  mi.value = mi0;
  // B19-4 — converted handlers route through logRes (live-source shapes)
  const liveSrc = [...document.querySelectorAll('script')].filter(s => { const t = (s.type || '').toLowerCase(); return t === '' || t.indexOf('javascript') >= 0 || t === 'module'; }).map(s => s.textContent || '').join('\n');
  const shapes = [
    ['persona-clear', "logRes(res, 'anchored note cleared', 'clear note failed'"],
    ['prefixes', "'extra prefixes: ' + (cps.join"],
    ['imgqueue', "'image queue depth: ' + r.value.imageQueueMax"],
    ['spawn', "'spawn failed', function () { setTimeout(refreshWorkers, 2000); }"],
    ['unban', "'unban failed', function () { refreshBanned(); }"],
    ['removemod', "'remove mod failed', function (r) { renderMods(r.value || []); }"],
    ['addmod', "'add mod failed', function (r) { byId('modInput').value = ''; renderMods(r.value || []); }"],
  ];
  shapes.forEach(p => ck('B19-4-' + p[0], liveSrc.indexOf(p[1]) >= 0, p[1].slice(0, 60)));
} catch (e) { ck('B19-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
