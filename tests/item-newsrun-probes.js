// Per-card Run button (Setup → News sources): executes the card now.
// Run: page_eval {path:"src/tests/item-newsrun-probes.js"}. Returns {pass, checks}.
// Restores drafts; never dispatches a real run (call is stubbed or validation
// refuses first). Run serially.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:NEWSRUN]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function runCards() { return [...document.querySelectorAll('#newsSourcesList [data-newssource]')]; }
function cardBtn(card, label) { return [...card.querySelectorAll('button')].filter(b => b.textContent === label)[0] || null; }
const snapDrafts = newsDrafts ? JSON.parse(JSON.stringify(newsDrafts)) : null;
const snapSeed = newsSeed, snapSaw = newsSawStatus, snapDirty = (typeof chanDirty !== 'undefined') ? chanDirty : null;
const snapCall = call;
const snapPub = CHANSTATE.pub.slice(), snapDms = (CHANSTATE.dms || []).slice();
CHANSTATE.pub = ['N1', 'N2']; CHANSTATE.dms = [];
function restore() {
  CHANSTATE.pub = snapPub.slice(); CHANSTATE.dms = snapDms.slice();
  newsDrafts = snapDrafts ? JSON.parse(JSON.stringify(snapDrafts)) : null;
  newsSeed = snapSeed; newsSawStatus = snapSaw; if (snapDirty !== null && typeof chanDirty !== 'undefined') chanDirty = snapDirty;
  renderNewsSources();
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
try {
  // R0 — run button renders left of test on every card
  newsDrafts = [
    { id: 'a-com', name: 'A', site: 'https://a.com', channelId: 'N1', intervalMs: 3600000, maxItems: 5, banWords: [], allowCats: [], blockCats: [] },
    { id: 'b-com', name: 'B', site: 'https://b.com', channelId: '', intervalMs: 3600000, maxItems: 5, banWords: [], allowCats: [], blockCats: [] }
  ];
  newsDirty = false; newsSeed = '[]'; renderNewsSources();
  const cards = runCards();
  const order0 = cards.length ? [...cards[0].querySelectorAll('.chanactions button')].map(b => b.textContent) : [];
  ck('R0-render', cards.length === 2 && order0.join(',') === 'run,test,remove', order0.join(','));
  const aria = cards.length ? cardBtn(cards[0], 'run').getAttribute('aria-label') : '';
  ck('R0-aria', /run source 1 now/.test(aria || ''), aria);

  // R1 — invalid site refuses locally, never dispatches
  let dispatched = null;
  newsDrafts[0].site = 'notaurl';
  await newsRunFeedNow(0, cardBtn(runCards()[0], 'run'), function (cmd) { dispatched = cmd; return Promise.resolve({ ok: false, reason: 'stubbed' }); });
  const s1 = runCards()[0].querySelector('.newsstatus').textContent;
  ck('R1-invalid', dispatched === null && /run failed/.test(s1) && /https root/.test(s1), s1);
  newsDrafts[0].site = 'https://a.com';

  // R2 — dormant (no Posts-to) refuses locally, never dispatches
  dispatched = null;
  await newsRunFeedNow(1, cardBtn(runCards()[1], 'run'), function (cmd) { dispatched = cmd; return Promise.resolve({ ok: false, reason: 'stubbed' }); });
  const s2 = runCards()[1].querySelector('.newsstatus').textContent;
  ck('R2-dormant', dispatched === null && /Posts-to channel/.test(s2), s2);

  // R3 — engine failure surfaces honestly, button restored
  dispatched = null;
  function stubFail(cmd) { dispatched = cmd; return Promise.resolve({ ok: false, reason: 'run needs a current engine (Stop + Start the bot to load it)' }); }
  const btn3 = cardBtn(runCards()[0], 'run');
  await newsRunFeedNow(0, btn3, stubFail);
  const s3 = runCards()[0].querySelector('.newsstatus').textContent;
  ck('R3-fail', dispatched === 'config.runNewsFeedNow' && /run failed: run needs a current engine/.test(s3) && btn3.textContent === 'run' && btn3.disabled === false, s3 + ' btn=' + btn3.textContent);

  // R4 — success ack paints, countdown refreshes, button restored
  function stubPosted(cmd) {
    if (cmd === 'config.runNewsFeedNow') return Promise.resolve({ ok: true, value: { ok: true, ran: 'posted', detail: 'posted rollup (2 items)' } });
    return snapCall(cmd);
  }
  const btn4 = cardBtn(runCards()[0], 'run');
  await newsRunFeedNow(0, btn4, stubPosted);
  const s4 = runCards()[0].querySelector('.newsstatus').textContent;
  ck('R4-posted', /ran: posted rollup/.test(s4) && btn4.textContent === 'run' && btn4.disabled === false, s4);

  // R5 — running state disables the button mid-flight
  let release;
  const gate = new Promise(function (res) { release = res; });
  function stubGate(cmd) { if (cmd === 'config.runNewsFeedNow') return gate.then(function () { return { ok: true, value: { ok: true, ran: 'nothing', detail: 'checked — nothing new' } }; }); return snapCall(cmd); }
  const btn5 = cardBtn(runCards()[0], 'run');
  const p5 = newsRunFeedNow(0, btn5, stubGate);
  const midText = btn5.textContent, midDis = btn5.disabled;
  release(); await p5;
  ck('R5-busy', midText === 'running…' && midDis === true && btn5.textContent === 'run', midText + '/' + btn5.textContent);
} catch (e) { ck('R-THREW', false, String((e && e.stack) || e).slice(0, 300)); }
restore();
return { pass: checks.every(c => c.ok), checks };
