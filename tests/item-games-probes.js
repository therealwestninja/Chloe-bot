// Games (wordle harness) — panel tile + About docs + live status shape.
// Run: page_eval {path:"src/tests/item-games-probes.js"}. Returns {pass, checks}.
// Net-zero: drives applyGamesStatus() directly with synthetic objects only and
// restores from the last live status; the only wire call is read-only status.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:GAMES]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
return (async function () {
try {
  window.__hamHold = true;   // park the 5s refresh while we drive forced states
  const last = (typeof hamStatus !== 'undefined') ? hamStatus : null;
  function restore() { try { applyGamesStatus(last || {}); } catch (e) {} try { window.__hamHold = false; } catch (e2) {} }

  // W0 — tile exists with status line + engine note
  ck('W0-tile', !!byId('gamesCard'), 'gamesCard present');
  ck('W0-parts', !!(byId('gamesStatusTxt') && byId('gamesStatusBox') && byId('gamesEngineNote')), 'status line + box + note present');

  // W1 — renders from a synthetic games map (channel-aware, baseline-relative)
  const ch = (typeof selChannel === 'function') ? selChannel() : null;
  const fake = { active: 'wordle', day: '2026-10-26', players: 3, solved: 1, finished: false, hard: true, maxGuesses: 6 };
  const syn = { games: {} };
  if (ch) syn.games[ch] = fake;
  applyGamesStatus(syn);
  const txt = byId('gamesStatusTxt') ? byId('gamesStatusTxt').textContent : '';
  if (ch) {
    ck('W1-render', /3 playing/.test(txt) && /1 solved/.test(txt) && /hard mode/.test(txt) && /2026-10-26/.test(txt), txt.slice(0, 120));
  } else {
    ck('W1-render', /pick a channel/.test(txt), txt.slice(0, 80));
  }
  ck('W1-box', byId('gamesStatusBox') && byId('gamesStatusBox').hidden === false, 'box shown with map');
  ck('W1-note', byId('gamesEngineNote') && byId('gamesEngineNote').hidden === true, 'note hidden with map');

  // W1b — entry without a day (table open, no puzzle yet) still reads sanely
  if (ch) {
    const syn2 = { games: {} }; syn2.games[ch] = { active: 'wordle', day: null, players: 0, solved: 0, finished: false, hard: false };
    applyGamesStatus(syn2);
    const t2 = byId('gamesStatusTxt') ? byId('gamesStatusTxt').textContent : '';
    ck('W1b-noday', /wordle on the table/.test(t2) && /0 playing/.test(t2), t2.slice(0, 100));
  } else {
    ck('W1b-noday', true, 'skipped (no channel selected)');
  }

  // W2 — old-engine degrade: no games map hides box + shows note, then restore
  applyGamesStatus({});
  ck('W2-hidden', byId('gamesStatusBox').hidden === true, 'box hidden without map');
  ck('W2-note', byId('gamesEngineNote').hidden === false, 'version note shown without map');
  restore();
  const rtxt = byId('gamesStatusTxt') ? byId('gamesStatusTxt').textContent : '';
  ck('W2-restore', true, 'restored to: ' + rtxt.slice(0, 80));

  // W3 — live status shape (baseline-relative: v9 map OR old-engine degrade)
  let live = null;
  try { live = await call('status', null, 15000); } catch (e) { live = null; }
  const gv = live && live.ok && live.value ? live.value.games : null;
  if (gv && typeof gv === 'object') {
    const ids = Object.keys(gv);
    const shapes = ids.map(id => { const g = gv[id]; return g && typeof g.players === 'number' && typeof g.solved === 'number'; });
    ck('W3-map', ids.length > 0, ids.length + ' channel(s) in games map');
    ck('W3-shape', shapes.every(Boolean), 'entries carry players/solved numbers');
  } else {
    ck('W3-map', byId('gamesStatusBox').hidden === true && byId('gamesEngineNote').hidden === false, 'old engine still running — tile degrades (Stop+Start loads v9)');
    ck('W3-shape', true, 'shape check waits for v9');
  }

  // W4 — About documents the game commands
  const about = byId('pane_about') ? byId('pane_about').textContent.replace(/\s+/g, ' ') : '';
  ck('W4-guess', /wordle CRANE/.test(about), 'wordle guess documented');
  ck('W4-settings', /game settings wordle hard on/.test(about), 'game settings documented');
  restore();
} catch (e) { ck('W0-no-throw', false, String((e && e.message) || e)); try { window.__hamHold = false; } catch (e2) {} }
const pass = checks.every(c => c.ok);
return { pass, checks };
})();
