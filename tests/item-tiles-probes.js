// Tile arrange probes — order/width persistence + arrange mode. No CDN needed
// (drag-library load is best-effort and NOT asserted). Restores layout store,
// DOM order/classes, arrange mode, and timeline.
// Run: page_eval {path:"src/tests/item-tiles-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:TILES]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const storeBk = localStorage.getItem('chloe.tiles.v1');
const feedEl = byId('chatLog');
const feedBk = feedEl ? feedEl.innerHTML : null;
const linesBk = (typeof debugLines !== 'undefined') ? debugLines.slice() : null;
const wasArranging = document.body.classList.contains('arranging');
function restore() {
  try { if (storeBk === null) localStorage.removeItem('chloe.tiles.v1'); else localStorage.setItem('chloe.tiles.v1', storeBk); } catch (e) {}
  try { applyTileLayout(); } catch (e) {}
  try { if (!wasArranging && arranging) setArranging(false); } catch (e) {}
  try { if (feedEl && feedBk !== null) feedEl.innerHTML = feedBk; } catch (e) {}
  try { if (typeof debugLines !== 'undefined' && linesBk) { debugLines.length = 0; Array.prototype.push.apply(debugLines, linesBk); } } catch (e) {}
}
try {
  // T1 — arrange controls + layout fns present
  ck('T1-ids', !!byId('arrangeBtn') && !!byId('layoutResetBtn'), 'arrange + reset buttons present');
  ck('T1-fns', typeof applyTileLayout === 'function' && typeof tileKey === 'function' && typeof setArranging === 'function' && typeof resetTileLayout === 'function', 'layout fns present');
  // T2 — arrange mode injects per-tile tools + body class (no CDN needed for this)
  setArranging(true);
  const setupBox = byId('pane_setup').querySelector('.tiles');
  const tiles = [...setupBox.children].filter(t => t.classList && t.classList.contains('tile'));
  const first = tiles[0];
  ck('T2-mode', document.body.classList.contains('arranging') && tiles.every(t => !!t.querySelector('.tiletools .grip') && !!t.querySelector('.tiletools .widthBtn')), tiles.length + ' setup tiles tooled');
  ck('T2-reset-visible', !byId('layoutResetBtn').hidden, 'reset button revealed');
  // T3 — width button cycles 1→2→3→1 from whatever the factory width is
  const origCls = first.className;
  let want = origCls.indexOf('span3') >= 0 ? 3 : origCls.indexOf('span2') >= 0 ? 2 : 1;
  [['T3-cyc1'], ['T3-cyc2'], ['T3-cyc3']].forEach(function ([id]) {
    want = want % 3 + 1;
    first.querySelector('.widthBtn').click();
    const got = first.classList.contains('span3') ? 3 : first.classList.contains('span2') ? 2 : 1;
    ck(id, got === want && first.querySelector('.widthBtn').textContent === want + 'x', 'from factory: got ' + got + 'x want ' + want + 'x (' + first.className + ')');
  });
  first.className = origCls;
  // T4 — persistence round-trip: store a span + a moved tile, re-apply from storage
  const lastKey = tileKey(tiles[tiles.length - 1]);
  const st = loadTileStore();
  st['pane_setup'] = { order: [lastKey], span: {} };
  st['pane_setup'].span[tileKey(first)] = 2;
  saveTileStore(st);
  applyTileLayout();
  ck('T4-span', first.classList.contains('span2'), 'span restored from store');
  ck('T4-order', tileKey(setupBox.children[setupBox.children.length - 1]) === lastKey, 'saved tile moved to end');
  // T5 — reset clears the store and restores factory order + classes
  resetTileLayout();
  ck('T5-store', localStorage.getItem('chloe.tiles.v1') === null, 'store cleared');
  ck('T5-class', first.className === origCls, first.className);
  ck('T5-first', setupBox.children[0] === first, 'factory order restored');
  setArranging(false);
  ck('T5-mode-off', !document.body.classList.contains('arranging') && byId('layoutResetBtn').hidden && byId('arrangeBtn').textContent === 'Arrange', 'mode off, button relabeled');
} catch (e) { ck('T0-no-throw', false, String((e && e.message) || e)); }
restore();
const pass = checks.every(c => c.ok);
return { pass, checks };
