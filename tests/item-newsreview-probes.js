// News review queue card — staged rollups with mini-preview, headline edits,
// composed-text edit, Post now / Regenerate / Save / Discard. Render drives
// off synthetic queue data; live legs only echo (no mutations, no posts).
// Run: page_eval {path:"src/tests/item-newsreview-probes.js"}. Returns {pass, checks}.
// Restores lastNewsReview/lastNewsQueue + re-renders. Run serially.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:NEWSREVIEW]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const snapReview = lastNewsReview, snapQueue = JSON.parse(JSON.stringify(lastNewsQueue || {}));
const snapDirty = (typeof chanDirty === 'undefined') ? null : chanDirty;
function restore() {
  lastNewsReview = snapReview; lastNewsQueue = snapQueue;
  try { renderNewsQueue(); } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
const ENTRY = { qid: 'qtest1', feedId: 'f1', name: 'Feed', max: 5, target: 'CHX', at: Date.now() - 120000,
  items: [{ title: 'Alpha headline', url: 'https://x.example/1' }, { title: 'Beta headline', url: 'https://x.example/2' }, { title: 'Gamma headline', url: 'https://x.example/3' }, { title: 'Delta headline', url: 'https://x.example/4' }],
  text: 'staged post text here' };
try {
  // Q0 — static card surfaces exist
  ck('Q0-card', !!(byId('newsQueueCard') && byId('newsQueueList')), 'card+list present');
  // Q1 — synthetic queue renders one entry with mini-preview + editors + tools
  lastNewsReview = true; lastNewsQueue = { CHX: [JSON.parse(JSON.stringify(ENTRY))] };
  try { renderNewsQueue(); } catch (e) { ck('Q1-render', false, 'threw: ' + (e && e.message)); }
  const card = document.querySelector('#newsQueueList [data-nqqid="qtest1"]');
  ck('Q1-render', !!card, card ? 'card rendered' : 'no card');
  const prev = card ? [...card.querySelectorAll('.nqprev li')].map((li) => li.textContent) : [];
  ck('Q1-preview', prev.length === 3 && prev[0] === 'Alpha headline' && prev[2] === 'Gamma headline', prev.join(' | '));
  const inputs = card ? [...card.querySelectorAll('[data-nqtitle]')] : [];
  ck('Q1-items', inputs.length === 4 && inputs[1].value === 'Beta headline', inputs.map((i) => i.value).join(' | '));
  const ta = card ? card.querySelector('textarea.nqtext') : null;
  ck('Q1-text', !!(ta && ta.value === 'staged post text here'), ta ? ta.value.slice(0, 40) : 'no textarea');
  const btns = card ? [...card.querySelectorAll('.row button')].map((b) => b.textContent) : [];
  ck('Q1-tools', btns.join(',') === 'Post now,Regenerate,Save,Discard', btns.join(','));
  const sum = card ? (card.querySelector('details summary') || {}).textContent : '';
  ck('Q1-fulltext', sum === 'full post text' && card.querySelector('details pre').textContent === 'staged post text here', sum);
  // Q2 — dropping a headline row removes it from the DOM (Save would persist)
  const drop = card ? card.querySelector('.nqitem [aria-label="drop headline 4"]') : null;
  if (drop) drop.click();
  ck('Q2-drop', card.querySelectorAll('[data-nqtitle]').length === 3, 'rows left=' + card.querySelectorAll('[data-nqtitle]').length);
  restore();
  // Q3 — review flag applies from status into the toggle
  try { applyStatus({ running: false, channelId: 'N1', publicChannels: ['N1'], dmChannels: [], channelLangs: {}, chanGates: {}, thoughtsFeeds: {}, newsFeeds: [], newsReview: true }); } catch (e) { ck('Q3-flag', false, 'threw'); }
  ck('Q3-flag', lastNewsReview === true && !!(byId('newsReviewChk') && byId('newsReviewChk').checked), 'flag=' + lastNewsReview + ' checked=' + (byId('newsReviewChk') && byId('newsReviewChk').checked));
  // Q4 — old engine (no newsReview): null flag + engine note, no throw
  try { applyStatus({ running: false, channelId: 'N1', publicChannels: ['N1'], dmChannels: [], channelLangs: {}, chanGates: {}, thoughtsFeeds: {}, newsFeeds: [] }); } catch (e) { ck('Q4-degrade', false, 'threw'); }
  renderNewsQueue();
  ck('Q4-degrade', lastNewsReview === null && byId('newsQueueNote') && byId('newsQueueNote').hidden === false, 'flag=' + lastNewsReview);
  restore();
  // Q5 — LIVE wire, net-zero: setNewsReview echo writes back the current value
  let st = null;
  try { st = await call('status'); } catch (e) { st = null; }
  if (st && st.ok && st.value && ('newsReview' in st.value)) {
    const cur = !!st.value.newsReview;
    let res = null;
    try { res = await call('config.setNewsReview', { on: cur }, 15000); } catch (e) { res = null; }
    ck('Q5-live-echo', !!(res && res.ok && res.value && res.value.newsReview === cur), JSON.stringify(res && res.value));
    let lq = null;
    try { lq = await call('config.listNewsQueue', {}, 15000); } catch (e) { lq = null; }
    ck('Q5-live-list', !!(lq && lq.ok && lq.value && lq.value.queues && typeof lq.value.queues === 'object' && typeof lq.value.review === 'boolean'), JSON.stringify(lq && lq.value && { chans: Object.keys(lq.value.queues), review: lq.value.review }));
  } else ck('Q5-live-echo', false, 'link down or old engine — no newsReview in status');
} catch (e) { ck('Q0-no-throw', false, String((e && e.message) || e)); }
finally { restore(); try { refresh(); } catch (e) {} }
let ok = (typeof chanDirty === 'undefined') || (chanDirty === snapDirty);
try { ok = ok && JSON.stringify(lastNewsQueue) === JSON.stringify(snapQueue) && lastNewsReview === snapReview; } catch (e) { ok = false; }
return { ok, pass: ok, checks };
