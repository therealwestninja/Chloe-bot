// Setup News sources manager (F2 panel surface).
// Sources are CRUD cards (text fields, selects, filters, per-card Test);
// no `|` line syntax. Routing lives only in the card Posts-to dropdown.
// Test dry-runs the fetch chain without saving. Save validates locally,
// then dispatches the same feed objects to config.setNewsFeeds.
// Run: page_eval {path:"src/tests/item-newsline-probes.js"}. Returns {pass, checks}.
// Restores rows, drafts, all status maps, chanDirty. Run serially.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:NEWSLINE]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function newsCards() { return [...document.querySelectorAll('#newsSourcesList [data-newssource]')]; }
function cardInput(card, label) { return card.querySelector('[aria-label="' + label + '"]'); }
function newsTestBtn(i) { const c = newsCards()[i]; return c ? [...c.querySelectorAll('button')].filter(b => b.textContent === 'test' || b.textContent.indexOf('testing') === 0)[0] : null; }
function newsStatusText(i) { const c = newsCards()[i]; const s = c ? c.querySelector('.newsstatus') : null; return s ? s.textContent : null; }
const snapPub = CHANSTATE.pub.slice(), snapDms = CHANSTATE.dms.slice();
const snapLangs = lastChanLangs ? Object.assign({}, lastChanLangs) : null;
const snapGates = lastChanGates ? JSON.parse(JSON.stringify(lastChanGates)) : null;
const snapThoughts = lastThoughtsFeeds ? Object.assign({}, lastThoughtsFeeds) : null;
const snapNews = lastNewsFeeds ? JSON.parse(JSON.stringify(lastNewsFeeds)) : null;
const snapDirty = chanDirty;
const snapDrafts = newsDrafts ? JSON.parse(JSON.stringify(newsDrafts)) : null;
const snapSeed = newsSeed, snapSaw = newsSawStatus;
function restore() {
  CHANSTATE.pub = snapPub.slice(); CHANSTATE.dms = snapDms.slice();
  lastChanLangs = snapLangs ? Object.assign({}, snapLangs) : null;
  lastChanGates = snapGates ? JSON.parse(JSON.stringify(snapGates)) : null;
  lastThoughtsFeeds = snapThoughts ? Object.assign({}, snapThoughts) : null;
  lastNewsFeeds = snapNews ? JSON.parse(JSON.stringify(snapNews)) : null;
  newsDrafts = snapDrafts ? JSON.parse(JSON.stringify(snapDrafts)) : null;
  newsSeed = snapSeed; newsSawStatus = snapSaw; chanDirty = snapDirty;
  renderChanList(); renderNewsSources();
  const note = byId('chanEngineNote'); if (note) note.hidden = !!(lastChanLangs && lastChanGates && lastThoughtsFeeds);
  try { byId('chanAddInput').value = ''; } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
const FEEDS = [
  { id: 'kotaku-com', name: 'kotaku.com', site: 'https://kotaku.com', channelId: 'N1', intervalMs: 2700000, maxItems: 3, banWords: ['trade', 'rumor'], allowCats: ['baseball'], blockCats: [] },
  { id: 'deadspin', name: 'deadspin', site: 'https://deadspin.com', channelId: '', intervalMs: 3600000, maxItems: 5, banWords: [], allowCats: [], blockCats: [] }
];
function fullStatus(over) {
  const s = { running: false, channelId: 'N1', publicChannels: ['N1', 'N2'], dmChannels: [], channelLangs: {}, chanGates: {}, thoughtsFeeds: {}, newsFeeds: JSON.parse(JSON.stringify(FEEDS)) };
  return Object.assign(s, over || {});
}
try {
  // N0 — first-use auto-populate from status: two source cards, fields + dropdowns
  newsDrafts = null; newsDirty = false; newsSeed = ''; newsSawStatus = false; chanDirty = false;
  try { applyStatus(fullStatus()); } catch (e) { ck('N0-render', false, 'threw'); }
  const cards = newsCards();
  ck('N0-render', cards.length === 2, 'cards=' + cards.length);
  const firstSite = cards.length ? cardInput(cards[0], 'news source site or feed URL').value : '';
  const firstTarget = cards.length ? cardInput(cards[0], 'channel this source posts to').value : '?';
  const firstMax = cards.length ? cardInput(cards[0], 'maximum headlines per rollup').value : '?';
  ck('N0-fields', firstSite === 'https://kotaku.com' && firstTarget === 'N1' && firstMax === '3', firstSite + ' target=' + firstTarget + ' max=' + firstMax);
  const targetOpts = cards.length ? [...cardInput(cards[0], 'channel this source posts to').options].map(o => o.value).join(',') : '';
  ck('N0-targets', targetOpts === ',N1,N2', targetOpts);
  // N1 — existing non-curated cadence is preserved as an explicit custom option
  const everySel = cards.length ? cardInput(cards[0], 'refresh cadence') : null;
  ck('N1-custom', !!everySel && everySel.value === '2700000' && /custom/.test(everySel.options[everySel.selectedIndex].text), everySel ? (everySel.value + ' ' + everySel.options[everySel.selectedIndex].text) : 'no select');
  // N1b — routing lives only in the source card now: channel rows carry no news UI
  ck('N1-norow', !document.querySelector('#chanList .channewsfeed') && cards.length === 2, cards.length + ' cards');
  // N2 — empty manager starts with one blank draft; Add appends; site entry autofills name/id
  newsDrafts = null; newsDirty = false; newsSeed = ''; chanDirty = false;
  try { applyStatus(fullStatus({ newsFeeds: [] })); } catch (e) { ck('N2-blank', false, 'threw'); }
  let blank = newsCards();
  ck('N2-blank', blank.length === 1 && cardInput(blank[0], 'news source site or feed URL').value === '' && cardInput(blank[0], 'maximum headlines per rollup').value === '5' && cardInput(blank[0], 'refresh cadence').value === '3600000', 'cards=' + blank.length);
  try { byId('newsAddBtn').click(); } catch (e) { ck('N2-add', false, 'threw'); }
  blank = newsCards();
  ck('N2-add', blank.length === 2, 'cards=' + blank.length);
  const siteInput = cardInput(blank[1], 'news source site or feed URL');
  siteInput.value = 'https://www.example.com/';
  siteInput.dispatchEvent(new Event('change', { bubbles: true }));
  ck('N2-autofill', newsDrafts[1].site === 'https://www.example.com' && newsDrafts[1].name === 'www.example.com' && newsDrafts[1].id === 'example-com' && cardInput(blank[1], 'news source name').value === 'www.example.com', JSON.stringify({ site: newsDrafts[1].site, name: newsDrafts[1].name, id: newsDrafts[1].id }));
  // N3 — converter keeps wire limits (duplicate site/target/max/interval/word caps), nothing dispatched
  const chanSet = { N1: true, N2: true };
  const good = newsDraftToFeed({ id: 'kotaku-com', name: 'Kotaku', site: 'https://kotaku.com/', channelId: 'N1', intervalMs: 7200000, maxItems: 3, banWords: ['Trade', 'rumor'], allowCats: [], blockCats: [] }, 0, { sites: {}, ids: {} }, chanSet);
  ck('N3-good', good.ok && good.feed.name === 'Kotaku' && good.feed.banWords.join(',') === 'trade,rumor', JSON.stringify(good.ok ? good.feed : good.error));
  const badSite = newsDraftToFeed({ site: 'not a url' }, 1, { sites: {}, ids: {} }, chanSet);
  const dupSite = newsDraftToFeed({ site: 'https://kotaku.com' }, 1, { sites: { 'kotaku.com': true }, ids: {} }, chanSet);
  const badTarget = newsDraftToFeed({ site: 'https://a.com', channelId: 'N9', maxItems: 5, intervalMs: 3600000 }, 2, { sites: {}, ids: {} }, chanSet);
  const badMax = newsDraftToFeed({ site: 'https://a.com', maxItems: 99, intervalMs: 3600000 }, 3, { sites: {}, ids: {} }, chanSet);
  const badEvery = newsDraftToFeed({ site: 'https://a.com', maxItems: 5, intervalMs: 60000 }, 4, { sites: {}, ids: {} }, chanSet);
  const badWords = newsDraftToFeed({ site: 'https://a.com', maxItems: 5, intervalMs: 3600000, banWords: ['x'.repeat(41)] }, 5, { sites: {}, ids: {} }, chanSet);
  const shared = { sites: {}, ids: {} };
  const firstDup = newsDraftToFeed({ site: 'https://a.com', id: 'same', maxItems: 5, intervalMs: 3600000 }, 6, shared, chanSet);
  const secondDup = newsDraftToFeed({ site: 'https://b.com', id: 'same', maxItems: 5, intervalMs: 3600000 }, 7, shared, chanSet);
  ck('N3-errors', !badSite.ok && /https root/.test(badSite.error) && !dupSite.ok && /duplicate site/.test(dupSite.error) && !badTarget.ok && /known channel/.test(badTarget.error) && !badMax.ok && /1\u201310/.test(badMax.error) && !badEvery.ok && /10m\u201324h/.test(badEvery.error) && !badWords.ok && /40/.test(badWords.error) && firstDup.ok && !secondDup.ok && /duplicate feed id/.test(secondDup.error), [badSite.error, dupSite.error, badTarget.error, badMax.error, badEvery.error, badWords.error, secondDup.error].join(' | ').slice(0, 360));
  // N3f — direct feed URLs convert: path kept, name falls back to the bare
  // host, id maps slashes to dashes; same host + different paths are not dupes
  const fshared = { sites: {}, ids: {} };
  const f1 = newsDraftToFeed({ site: 'https://feeds.example.com/gaming', maxItems: 5, intervalMs: 3600000 }, 0, fshared, chanSet);
  const f2 = newsDraftToFeed({ site: 'https://feeds.example.com/tech', maxItems: 5, intervalMs: 3600000 }, 1, fshared, chanSet);
  const f3 = newsDraftToFeed({ site: 'https://feeds.example.com/gaming', maxItems: 5, intervalMs: 3600000 }, 2, { sites: fshared.sites, ids: {} }, chanSet);
  ck('N3-feedurl', f1.ok && f1.feed.site === 'https://feeds.example.com/gaming' && f1.feed.name === 'feeds.example.com' && f1.feed.id === 'feeds-example-com-gaming' && f2.ok && !f3.ok && /duplicate site/.test(f3.error), [f1.ok && f1.feed.id + '/' + f1.feed.name, f2.ok, f3.error].join(' | ').slice(0, 200));
  // N4 — unsaved draft survives the next status poll
  newsDrafts = null; newsDirty = false; newsSeed = ''; chanDirty = false;
  try { applyStatus(fullStatus()); } catch (e) { ck('N4-dirty', false, 'threw'); }
  const nameInput = cardInput(newsCards()[0], 'news source name');
  nameInput.value = 'Edited name';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  try { applyStatus(fullStatus()); } catch (e) { ck('N4-dirty', false, 'threw'); }
  ck('N4-dirty', newsDirty === true && cardInput(newsCards()[0], 'news source name').value === 'Edited name' && newsCards().length === 2, 'dirty=' + newsDirty);
  // N5b — Save dispatches the converted drafts; Remove drops a card (dispatch/confirm stubbed, net-zero)
  const realConfirm = window.confirm;
  try {
    newsDrafts = [{ id: 'kotaku-com', name: 'Kotaku', site: 'https://kotaku.com', channelId: 'N1', intervalMs: 7200000, maxItems: 3, banWords: ['trade'], allowCats: [], blockCats: [] }];
    newsDirty = true; renderNewsSources();
    let sent = null, refreshed = false;
    const fakeDispatch = function (cmd, args) {
      if (cmd === 'config.setNewsFeeds') { sent = args.feeds; return Promise.resolve({ ok: true, value: { count: args.feeds.length, feeds: args.feeds } }); }
      return Promise.resolve({ ok: false, reason: 'unexpected call' });
    };
    window.confirm = function () { return true; };
    saveNewsSources(fakeDispatch, function () { refreshed = true; return Promise.resolve(null); });
    await new Promise(function (r) { setTimeout(r, 50); });
    ck('N5b-save', !!sent && sent.length === 1 && sent[0].site === 'https://kotaku.com' && newsDirty === false && lastNewsFeeds.length === 1 && refreshed === true, JSON.stringify(sent && sent[0]));
    const removeBtn = [...newsCards()[0].querySelectorAll('button')].filter(b => b.textContent === 'remove')[0];
    removeBtn.click();
    ck('N5b-remove', newsDrafts.length === 0 && newsDirty === true, 'drafts=' + newsDrafts.length);
  } finally { window.confirm = realConfirm; }
  // N5d — Test button on a mistyped card fails locally (nothing sent, button untouched)
  newsDrafts = [{ id: 'bad', name: 'Bad', site: 'not a url', channelId: '', intervalMs: 3600000, maxItems: 5, banWords: [], allowCats: [], blockCats: [] }];
  newsDirty = true; renderNewsSources();
  let tb0 = newsTestBtn(0);
  ck('N5d-button', !!tb0 && tb0.textContent === 'test' && tb0.disabled === false, tb0 ? tb0.textContent : 'no test button');
  try { tb0.click(); } catch (e) { ck('N5d-invalid', false, 'threw'); }
  await new Promise(function (r) { setTimeout(r, 100); });
  tb0 = newsTestBtn(0);
  ck('N5d-invalid', !!tb0 && tb0.textContent === 'test' && tb0.disabled === false && newsDrafts.length === 1 && newsDirty === true && /https root/.test(newsStatusText(0) || ''), tb0 ? (tb0.textContent + ' dirty=' + newsDirty + ' status=' + newsStatusText(0)) : 'no test button');
  // N5e — Test button on a valid card enters the live dry-run and restores the
  // button (any clean outcome counts — ok or graceful fail; proves no crash).
  // Net-zero by design: the dry-run never writes, posts, or marks seen.
  newsDrafts = [{ id: 'example-com', name: 'example.com', site: 'https://example.com', channelId: '', intervalMs: 3600000, maxItems: 5, banWords: [], allowCats: [], blockCats: [] }];
  newsDirty = true; renderNewsSources();
  let entered = false, restored = false;
  try {
    newsTestBtn(0).click();
    let b = newsTestBtn(0);
    if (b && b.disabled) entered = true;
    for (let i = 0; i < 225 && !restored; i++) {
      await new Promise(function (r) { setTimeout(r, 200); });
      b = newsTestBtn(0);
      if (b && b.disabled) entered = true;
      if (entered && b && !b.disabled && b.textContent === 'test') restored = true;
    }
  } catch (e) { ck('N5e-live', false, String((e && e.message) || e)); }
  if (!checks.some(c => c.id === 'N5e-live')) ck('N5e-live', entered && restored && (newsStatusText(0) || '').length > 0, 'entered=' + entered + ' restored=' + restored + ' status=' + newsStatusText(0));
  // N5f — the result sticks: a poll re-render keeps the Test line on the card
  const stickyBefore = newsStatusText(0);
  renderNewsSources();
  ck('N5f-sticky', !!stickyBefore && newsStatusText(0) === stickyBefore, 'before=' + stickyBefore + ' after=' + newsStatusText(0));
  // N6 — old engine (no newsFeeds key): manager degrades, no crash
  newsDrafts = null; newsDirty = false; newsSeed = ''; newsSawStatus = false; chanDirty = false;
  try { applyStatus({ running: false, channelId: 'N1', publicChannels: ['N1', 'N2'], dmChannels: [], channelLangs: {}, chanGates: {}, thoughtsFeeds: {} }); } catch (e) { ck('N6-degrade', false, 'threw'); }
  ck('N6-degrade', byId('newsEngineNote') && byId('newsEngineNote').hidden === false && byId('newsAddBtn').disabled === true && /current engine/.test(byId('newsSourcesList').textContent), byId('newsSourcesList') ? byId('newsSourcesList').textContent.slice(0, 60) : 'no list');
  restore();
  // N7 — LIVE wire, version-aware, semantically a no-op: write the live feeds back
  let st = null;
  try { st = await call('status'); } catch (e) { st = null; }
  let liveHasNew = false, liveFeedsBefore = null;
  if (st && st.ok && st.value) {
    const hasNew = ('newsFeeds' in st.value);
    liveHasNew = hasNew;
    try { liveFeedsBefore = hasNew ? JSON.parse(JSON.stringify(st.value.newsFeeds)) : []; } catch (e) { liveFeedsBefore = []; }
    let res = null;
    try { res = await call('config.setNewsFeeds', { feeds: hasNew ? st.value.newsFeeds : [] }, 15000); } catch (e) { res = null; }
    if (hasNew) ck('N7-live-echo', !!(res && res.ok && res.value && typeof res.value.count === 'number'), JSON.stringify(res && res.value && res.value.count));
    else ck('N7-live-echo', !!(res && !res.ok && /unknown command/.test(res.reason || '')), (res && res.reason) || 'no response');
  } else ck('N7-live-echo', false, 'link down — status failed');
  // N5c — REGRESSION (user-reported 2026-11-02: clicking Save threw
  // "TypeError: dispatch is not a function"): the button listener used to hand
  // saveNewsSources straight to addEventListener, so the browser invoked it
  // with the click Event as `dispatch`. Click the REAL #newsSaveBtn with valid
  // drafts and assert no dispatch-TypeError escapes. Runs only on a linked
  // new-engine (needs the live bridge: `call` is closure-local, unstubbable).
  // Restores the engine feeds afterwards; net-zero checked below.
  if (liveHasNew && liveFeedsBefore) {
    let crashed = false;
    const errHook = function (msg) { try { if (/dispatch is not a function/.test(String((msg && msg.message) || msg))) crashed = true; } catch (e) {} };
    const origErr = console.error;
    const hamHoldPrev = window.__hamHold; window.__hamHold = true;   // park the 5s poll: a refresh mid-save can reseed drafts/seed under the settle wait + net-zero tail
    window.addEventListener('error', errHook);
    console.error = function () { try { if (/dispatch is not a function/.test(Array.prototype.join.call(arguments, ' '))) crashed = true; } catch (e) {} return origErr.apply(console, arguments); };
    try {
      newsDrafts = [{ id: 'example-com', name: 'example.com', site: 'https://example.com', channelId: '', intervalMs: 3600000, maxItems: 5, banWords: [], allowCats: [], blockCats: [] }];
      newsDirty = true; renderNewsSources();
      byId('newsSaveBtn').click();
      let settled = false;
      for (let i = 0; i < 60; i++) {
        await new Promise(function (r) { setTimeout(r, 200); });
        if (crashed) break;
        if (newsDirty === false && lastNewsFeeds && lastNewsFeeds.length === 1 && lastNewsFeeds[0].site === 'https://example.com') { settled = true; break; }
      }
      ck('N5c-click', !crashed && settled, 'crashed=' + crashed + ' settled=' + settled + ' dirty=' + newsDirty);
    } finally {
      window.removeEventListener('error', errHook);
      console.error = origErr;
      try { await call('config.setNewsFeeds', { feeds: liveFeedsBefore }, 15000); } catch (e) {}
      try { newsSeedFromStatus(liveFeedsBefore, true); } catch (e) {}   // resync panel seed/drafts to the restored engine before the snap compare
      restore();
      window.__hamHold = hamHoldPrev;
    }
  } else ck('N5c-click', true, 'skipped — no linked new-engine (N7); DI save covered by N5b');
} catch (e) { ck('N0-no-throw', false, String((e && e.message) || e)); }
finally { restore(); try { refresh(); } catch (e) {} }
let ok = CHANSTATE.pub.join(',') === snapPub.join(',') && CHANSTATE.dms.join(',') === snapDms.join(',') && chanDirty === snapDirty;
try { ok = ok && JSON.stringify(lastNewsFeeds) === JSON.stringify(snapNews) && JSON.stringify(lastThoughtsFeeds) === JSON.stringify(snapThoughts) && JSON.stringify(newsDrafts) === JSON.stringify(snapDrafts) && newsSeed === snapSeed && newsSawStatus === snapSaw; } catch (e) {}
ok = ok && checks.length > 0 && checks.every(c => c.ok);
return { ok, pass: ok, checks };
