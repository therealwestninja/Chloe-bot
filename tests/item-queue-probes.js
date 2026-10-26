// Queue probes — brain lines (FIFO, one running at a time per backend).
// Fully offline except the plugin's presence: instrumented runs prove FIFO order,
// and no-AI fast paths (facts with no lines, paint with empty prompt, unknown method)
// prove end-to-end dispatch through the lines. Behavior rides the full-board re-green.
// Run: page_eval {path:"src/tests/item-queue-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:Q]', id, detail); } catch (e) {} } }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
try {
  ck('Q-0-lines-exist', typeof textLine !== 'undefined' && typeof textLine.push === 'function' && typeof imageLine !== 'undefined' && typeof imageLine.push === 'function', 'textLine/imageLine push fns');
  // Q-1 — FIFO + serial: three overlapping runs settle strictly in push order
  const order = [];
  function mkRun(tag, ms) {
    return function () {
      order.push(tag + '-start');
      return sleep(ms).then(function () { order.push(tag + '-end'); });
    };
  }
  textLine.push(mkRun('a', 60));
  textLine.push(mkRun('b', 30));
  textLine.push(mkRun('c', 10));
  for (let i = 0; i < 100 && order.length < 6; i++) await sleep(50);
  ck('Q-1-fifo-serial', order.join(',') === 'a-start,a-end,b-start,b-end,c-start,c-end', order.join(','));
  // Q-2 — imageLine serializes too (factory shared, one overlapping pair)
  const iorder = [];
  imageLine.push(function () { iorder.push('x-start'); return sleep(40).then(function () { iorder.push('x-end'); }); });
  imageLine.push(function () { iorder.push('y-start'); return sleep(5).then(function () { iorder.push('y-end'); }); });
  for (let i = 0; i < 100 && iorder.length < 4; i++) await sleep(50);
  ck('Q-2-image-serial', iorder.join(',') === 'x-start,x-end,y-start,y-end', iorder.join(','));
  // Q-3..Q-5 — end-to-end through the real dispatcher via self-posted calls
  const replies = {};
  function onMsg(ev) {
    const d = ev.data;
    if (d && d.__chloe === 1 && d.kind === 'callres' && typeof d.nonce === 'string' && d.nonce.indexOf('qline') === 0) replies[d.nonce] = d;
  }
  window.addEventListener('message', onMsg);
  try {
    // Q-3 — three facts calls (no lines: no-AI fast path) all answered, in order
    window.postMessage({ __chloe: 1, kind: 'call', nonce: 'qlineF1', method: 'facts', args: { name: 'Q', lines: [] } }, '*');
    window.postMessage({ __chloe: 1, kind: 'call', nonce: 'qlineF2', method: 'facts', args: { name: 'Q', lines: [] } }, '*');
    window.postMessage({ __chloe: 1, kind: 'call', nonce: 'qlineF3', method: 'facts', args: { name: 'Q', lines: [] } }, '*');
    for (let i = 0; i < 100 && (!replies.qlineF1 || !replies.qlineF2 || !replies.qlineF3); i++) await sleep(50);
    const fOk = replies.qlineF1 && replies.qlineF1.ok && replies.qlineF2 && replies.qlineF2.ok && replies.qlineF3 && replies.qlineF3.ok;
    ck('Q-3-facts-through-line', !!fOk, 'F1=' + !!(replies.qlineF1 && replies.qlineF1.ok) + ' F2=' + !!(replies.qlineF2 && replies.qlineF2.ok) + ' F3=' + !!(replies.qlineF3 && replies.qlineF3.ok));
    // Q-4 — unknown method bypasses the line: answered while a slow run still holds it
    let slowDone = false;
    textLine.push(function () { return sleep(400).then(function () { slowDone = true; }); });
    await sleep(50); // let the slow run start
    window.postMessage({ __chloe: 1, kind: 'call', nonce: 'qlineU1', method: 'nope', args: {} }, '*');
    for (let i = 0; i < 60 && !replies.qlineU1; i++) await sleep(50);
    ck('Q-4-unknown-bypass', !!replies.qlineU1 && replies.qlineU1.ok === false && !slowDone, 'replied=' + !!replies.qlineU1 + ' slowDoneAtReply=' + slowDone);
    for (let i = 0; i < 60 && !slowDone; i++) await sleep(50);
    // Q-5 — paint routes via imageLine: empty prompt declines without AI
    window.postMessage({ __chloe: 1, kind: 'call', nonce: 'qlineP1', method: 'paint', args: { prompt: '' } }, '*');
    for (let i = 0; i < 60 && !replies.qlineP1; i++) await sleep(50);
    ck('Q-5-paint-through-line', !!replies.qlineP1 && replies.qlineP1.ok === false && replies.qlineP1.reason === 'empty prompt', 'reason=' + (replies.qlineP1 && replies.qlineP1.reason));
  } finally {
    window.removeEventListener('message', onMsg);
  }
} catch (e) { ck('Q-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
