// Item C adversarial. Restores unified timeline + debugLines + confirm stub + debug toggle.
// Run: page_eval {path:"src/tests/item-c-adversarial.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:C-adv]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const feed = byId('chatLog');
const beforeFeed = feed.innerHTML;
const beforeLines = (typeof debugLines !== 'undefined') ? debugLines.slice() : null;
const beforeToggle = byId('debugToggleChk') ? byId('debugToggleChk').checked : true;
const realConfirm = window.confirm;
const beforeRun = byId('runTxt') ? byId('runTxt').textContent : null;
function restore() {
  feed.innerHTML = beforeFeed;
  try { if (typeof debugLines !== 'undefined' && beforeLines) { debugLines.length = 0; Array.prototype.push.apply(debugLines, beforeLines); } } catch (e) {}
  try { const t = byId('debugToggleChk'); if (t) t.checked = beforeToggle; if (typeof syncDbgVis === 'function') syncDbgVis(); } catch (e) {}
  window.confirm = realConfirm;
}
try {
  // ADV1 — XSS line is text, never an element
  try { feedEvent('<img src=x onerror=alert(1)>', '00:00:00'); } catch (e) { ck('ADV1-no-throw', false, String((e && e.message) || e)); }
  ck('ADV1-xss', !feed.querySelector('img'), feed.querySelector('img') ? 'IMG INJECTED' : 'escaped as text');
  // ADV2 — empty + giant lines
  try { feedEvent('', '00:00:01'); ck('ADV2-empty', true, 'tolerated'); } catch (e) { ck('ADV2-empty', false, 'threw'); }
  const giant = new Array(50001).join('z');
  try { feedEvent(giant, '00:00:02'); const rs = feed.querySelectorAll('.ev'); ck('ADV2b-giant', rs[rs.length - 1].querySelector('.msg').textContent.length === 50000, 'len=' + rs[rs.length - 1].querySelector('.msg').textContent.length); } catch (e) { ck('ADV2b-giant', false, 'threw'); }
  // ADV3 — debug cap: 650 appends → debugLines ≤600 and DOM stays ≤ UNIFIED_MAX
  try { for (let i = 0; i < 650; i++) debugAppend('cap' + i, '00:00:03'); ck('ADV3-cap', debugLines.length <= 600, 'lines=' + debugLines.length); } catch (e) { ck('ADV3-cap', false, 'threw'); }
  ck('ADV3b-dom-cap', feed.childNodes.length <= ((typeof UNIFIED_MAX !== 'undefined') ? UNIFIED_MAX : 400) + 1, 'children=' + feed.childNodes.length);
  // ADV4 — resetBtn with confirm=false performs nothing (no throw, timeline unchanged)
  const tlBefore = feed.innerHTML;
  window.confirm = () => false;
  try { byId('resetBtn').click(); ck('ADV4-cancel', feed.innerHTML === tlBefore, 'cancel → silent'); } catch (e) { ck('ADV4-cancel', false, 'threw: ' + ((e && e.message) || e)); }
  window.confirm = realConfirm;
  // ADV5 — Clear twice idempotent; buffer stays empty and the empty note returns
  try { byId('feedClearBtn').click(); const a = feed.innerHTML; byId('feedClearBtn').click(); const b = feed.innerHTML; ck('ADV5-clear-idem', a === b, 'clear stable'); } catch (e) { ck('ADV5-clear-idem', false, 'threw'); }
  ck('ADV5b-empty', !!(byId('chatEmpty') && byId('chatEmpty').textContent === 'Conversation cleared.') && debugLines.length === 0, 'empty note + empty buffer');
  // ADV6 — neighbors untouched (live-state-proof: compare to suite-start value)
  ck('ADV6-neighbors', byId('runTxt').textContent === beforeRun && byId('rosterCount').textContent.indexOf('people') >= 0, 'run=' + byId('runTxt').textContent + ' roster=' + byId('rosterCount').textContent);
} finally { restore(); }
ck('ADV0-restored', feed.innerHTML === beforeFeed, 'restored');
const pass = checks.every(c => c.ok);
return { pass, checks };
