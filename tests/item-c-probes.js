// Item C probes — unified timeline (chat + activity + debug rows share #chatLog).
// Restores timeline HTML + debugLines + debug toggle.
// Run: page_eval {path:"src/tests/item-c-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:C]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const feed = byId('chatLog');
const beforeFeed = feed ? feed.innerHTML : null;
const beforeLines = (typeof debugLines !== 'undefined') ? debugLines.slice() : null;
const beforeToggle = byId('debugToggleChk') ? byId('debugToggleChk').checked : true;
function restore() {
  if (feed && beforeFeed !== null) feed.innerHTML = beforeFeed;
  try { if (typeof debugLines !== 'undefined' && beforeLines) { debugLines.length = 0; Array.prototype.push.apply(debugLines, beforeLines); } } catch (e) {}
  try { const t = byId('debugToggleChk'); if (t) t.checked = beforeToggle; if (typeof syncDbgVis === 'function') syncDbgVis(); } catch (e) {}
}
try {
  // C1 — drive each tag type, verify class + tag text
  const cases = [
    ['boom error fail', 'warning', 'WARNING'],
    ['abandon ship', 'moderation', 'ABANDON'],
    ['[chloe.img] painted a cat', 'image', 'IMAGE'],
    ['[chloe.poll] 5 fetched', 'poll', 'POLL'],
    ['user got a strike', 'moderation', 'MODERATION'],
    ['Chloe replied to Alice', 'response', 'RESPONSE'],
    ['fact learned about Bob', 'memory', 'MEMORY'],
    ['packing context thinking', 'thinking', 'THINKING'],
    ['received new message', 'received', 'RECEIVED'],
    ['just a note', 'system', 'SYSTEM']
  ];
  let tagOk = true; const got = [];
  cases.forEach(c => { try { feedEvent(c[0], '00:00:00'); } catch (e) { tagOk = false; got.push(c[0] + ':THREW'); return; } });
  const rows = feed.querySelectorAll('.ev');
  const last10 = Array.prototype.slice.call(rows, -10);
  last10.forEach((r, i) => { got.push(r.className + '/' + r.querySelector('.tag').textContent); if (r.className !== 'ev ' + cases[i][1] || r.querySelector('.tag').textContent !== cases[i][2]) tagOk = false; });
  ck('C1-tags', tagOk, got.join(' ; ').slice(0, 400));
  // C2 — prefix strip: [chloe.xxx] removed from .msg but chip shows type
  try { feedEvent('[chloe.poll] 5 fetched, 3 ingested', '00:00:01'); } catch (e) {}
  const last = feed.querySelectorAll('.ev'); const lr = last[last.length - 1];
  ck('C2-strip', lr.querySelector('.msg').textContent.indexOf('[chloe.') < 0 && lr.querySelector('.tag').textContent === 'POLL', 'msg=' + lr.querySelector('.msg').textContent.slice(0, 60));
  // C3 — cap: push 260, children must stay ≤ UNIFIED_MAX; the empty placeholder is consumed by content
  try { for (let i = 0; i < 260; i++) feedEvent('cap line ' + i, '00:00:02'); } catch (e) { ck('C3-no-throw', false, String((e && e.message) || e)); }
  const cap = (typeof UNIFIED_MAX !== 'undefined') ? UNIFIED_MAX : 400;
  ck('C3-cap', feed.childNodes.length <= cap + 1, 'children=' + feed.childNodes.length + ' cap=' + cap);
  ck('C3-empty-gone', !byId('chatEmpty'), 'empty placeholder consumed once content arrives');
  // C4 — force fail: feedEvent(null) / feedEvent(undefined)
  let threw = null; try { feedEvent(null); } catch (e) { threw = e; }
  ck('C4-null-feed', !threw, threw ? 'threw: ' + ((threw && threw.message) || threw) : 'tolerated null (renders "null" row)');
  // C5 — debug-only lines render as .dbg rows in the SAME timeline, never as .ev
  try { feedEvent('marker-before-debug-split', '00:00:03'); } catch (e) {}
  let lastMsg = () => { const rs = feed.querySelectorAll('.ev'); return rs.length ? rs[rs.length - 1].querySelector('.msg').textContent : '<none>'; };
  try { log('[chloe.poll] mechanical poll line'); } catch (e) {}
  const dbgRows = feed.querySelectorAll('.dbg');
  const dbgHit = dbgRows.length ? [...dbgRows].pop().textContent.indexOf('mechanical') >= 0 : false;
  ck('C5-debug-only', lastMsg() === 'marker-before-debug-split' && dbgHit, 'last .ev unchanged:' + (lastMsg() === 'marker-before-debug-split') + ' in .dbg:' + dbgHit);
  try { log('hello human activity'); } catch (e) {}
  ck('C5b-activity', lastMsg() === 'hello human activity', 'last .ev row=' + lastMsg().slice(0, 60));
  // C6 — one Clear empties everything (chat lines, .ev, .dbg, buffer) and restores the empty note
  try { byId('feedClearBtn').click(); } catch (e) { ck('C6-clear-no-throw', false, String((e && e.message) || e)); }
  const em = byId('chatEmpty');
  ck('C6-clear', feed.querySelectorAll('.ev').length === 0 && feed.querySelectorAll('.dbg').length === 0 && feed.querySelectorAll('.chatline').length === 0 && !!(em && em.textContent === 'Conversation cleared.') && debugLines.length === 0, 'ev=0 dbg=0 lines=0 empty=' + (em ? em.textContent : '<none>') + ' buf=' + debugLines.length);
  // C7 — debug toggle hides/shows .dbg rows via the hide-dbg class
  try { log('[chloe.poll] toggle probe line'); } catch (e) {}
  const hasDbg = feed.querySelectorAll('.dbg').length > 0;
  const tgl = byId('debugToggleChk');
  tgl.checked = false; tgl.dispatchEvent(new Event('change', { bubbles: true }));
  const hiddenNow = feed.classList.contains('hide-dbg');
  tgl.checked = true; tgl.dispatchEvent(new Event('change', { bubbles: true }));
  const shownAgain = !feed.classList.contains('hide-dbg');
  ck('C7-toggle', hasDbg && hiddenNow && shownAgain, 'dbg=' + hasDbg + ' hidden=' + hiddenNow + ' shown=' + shownAgain);
  try { tgl.checked = beforeToggle; tgl.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
} finally { restore(); }
ck('C0-restored', feed.innerHTML === beforeFeed, 'timeline restored');
const pass = checks.every(c => c.ok);
return { pass, checks };
