// ─── ChloeWordle — Wordle, first game on the ChloeGames harness ───
// Lists live in wordle-lists.js (WORDLE_ANSWERS / WORDLE_ALLOWED globals).
// Pure core (pattern, daily pick, hard check, render) + state handlers that
// take injected promise IO, so the same code runs in the engine and in
// headless tests. Registers itself as the 'wordle' game def.
// Parser-safe plain JS (no imports, no DOM). Loaded AFTER games.js + lists,
// BEFORE engine.js in the bundle.
var ChloeWordle = (function () {
  'use strict';
  var ID = 'wordle';
  var EMOJI = { g: '🟩', y: '🟨', b: '⬛' };
  var EMPTY_ROW = '⬜⬜⬜⬜⬜';
  var DAILY_OFFSET = 13;   // decorrelates the daily pick from other Wordle clones

  var _answers = null, _valid = null;
  function answers() {
    if (!_answers) _answers = (typeof WORDLE_ANSWERS === 'string' ? WORDLE_ANSWERS : '').split(' ').filter(Boolean);
    return _answers;
  }
  function validSet() {
    if (!_valid) {
      _valid = {};
      var a = answers(), i;
      for (i = 0; i < a.length; i++) _valid[a[i]] = true;
      var extra = (typeof WORDLE_ALLOWED === 'string' ? WORDLE_ALLOWED : '').split(' ').filter(Boolean);
      for (i = 0; i < extra.length; i++) _valid[extra[i]] = true;
    }
    return _valid;
  }
  // Standard Wordle feedback, duplicate-safe (same semantics as the
  // /wordle-solver reverse core: computePatternR). -> e.g. 'bbgyg'.
  function scoreGuess(guess, answer) {
    var res = ['b', 'b', 'b', 'b', 'b'], counts = {}, k, c;
    guess = String(guess).toLowerCase();
    answer = String(answer).toLowerCase();
    for (k = 0; k < 5; k++) { c = answer.charAt(k); counts[c] = (counts[c] || 0) + 1; }
    for (k = 0; k < 5; k++) {
      if (guess.charAt(k) === answer.charAt(k)) { res[k] = 'g'; counts[guess.charAt(k)]--; }
    }
    for (k = 0; k < 5; k++) {
      if (res[k] === 'g') continue;
      c = guess.charAt(k);
      if (counts[c] > 0) { res[k] = 'y'; counts[c]--; }
    }
    return res.join('');
  }
  function dayStr(ts) { return new Date(ts).toISOString().slice(0, 10); }
  function dayNum(ts) { return Math.floor(ts / 86400000); }
  function pickAnswer(pool, n) { return pool[((n % pool.length) + pool.length) % pool.length]; }
  function dailyAnswer(pool, ts) { return pickAnswer(pool, dayNum(ts) + DAILY_OFFSET); }
  function poolFor(settings) {
    var a = answers();
    if (settings && settings.pool === 'full') {
      var extra = (typeof WORDLE_ALLOWED === 'string' ? WORDLE_ALLOWED : '').split(' ').filter(Boolean);
      return a.concat(extra);
    }
    return a;
  }

  // def surface (the harness contract) ──
  function defaultSettings() { return { hard: false, daily: true, maxGuesses: 6, pool: 'answers' }; }
  function schema() {
    return {
      hard: { type: 'bool', blurb: 'on = guesses must fit all known hints' },
      daily: { type: 'bool', blurb: 'on = one shared puzzle per day' },
      maxGuesses: { type: 'int', min: 4, max: 8, blurb: 'guesses per day (4..8)' },
      pool: { type: 'enum', values: ['answers', 'full'], blurb: 'which words can be the answer' }
    };
  }
  var TITLE = 'Wordle';
  var BLURB = 'guess the 5-letter word — one shared puzzle a day, emoji board, streaks';
  function helpLines(p) {
    return [
      p + ' wordle CRANE — guess (starts today\'s game; anyone can play)',
      p + ' wordle — your board · ' + p + ' wordle board — table · ' + p + ' wordle stats — leaderboard',
      'mods: ' + p + ' wordle new [WORD] (fresh answer) · ' + p + ' wordle end (close today)',
      'mods: ' + p + ' game settings wordle hard on|off · maxguesses 4..8 · daily on|off · pool answers|full'
    ];
  }

  // State: { day, answer, forced, players: { uid: {name, guesses:[{w,p}], status} } }.
  // Rule R: rebuild defensively — stored shapes are untrusted input.
  function blankState(day, answer) { return { day: day, answer: answer, forced: false, players: {} }; }
  function validateState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day)) return null;
    if (typeof raw.answer !== 'string' || !/^[a-z]{5}$/.test(raw.answer)) return null;
    var st = { day: raw.day, answer: raw.answer, forced: raw.forced === true, players: {} };
    var ps = (raw.players && typeof raw.players === 'object' && !Array.isArray(raw.players)) ? raw.players : {};
    Object.keys(ps).forEach(function (uid) {
      if (!/^\d{8,32}$/.test(uid)) return;
      var p = ps[uid];
      if (!p || typeof p !== 'object') return;
      var gs = Array.isArray(p.gs || p.guesses) ? (p.gs || p.guesses) : [];
      var clean = [];
      for (var i = 0; i < gs.length && clean.length < 8; i++) {
        var g = gs[i];
        if (g && typeof g.w === 'string' && /^[a-z]{5}$/.test(g.w) && typeof g.p === 'string' && /^[byg]{5}$/.test(g.p)) {
          clean.push({ w: g.w, p: g.p });
        }
      }
      var status = (p.status === 'won' || p.status === 'lost') ? p.status : 'playing';
      st.players[uid] = { name: String(p.name || 'someone').slice(0, 32), guesses: clean, status: status };
    });
    return st;
  }
  function ensurePlayer(st, uid, name) {
    var p = st.players[uid];
    if (!p) { p = st.players[uid] = { name: String(name || 'someone').slice(0, 32), guesses: [], status: 'playing' }; }
    else if (name) p.name = String(name).slice(0, 32);
    return p;
  }
  // Candidate-semantics hard check (same rule as /wordle-solver hard mode):
  // the guess must reproduce every known pattern when scored against itself.
  function hardLegal(candidate, prior) {
    for (var i = 0; i < prior.length; i++) {
      if (scoreGuess(prior[i].w, candidate) !== prior[i].p) return prior[i];
    }
    return null;
  }

  function rowLine(g) {
    var s = '';
    for (var i = 0; i < 5; i++) s += EMOJI[g.p.charAt(i)] || EMOJI.b;
    return s + '  ' + g.w.toUpperCase();
  }
  function renderBoard(st, settings, uid, name) {
    var p = st.players[uid];
    var max = settings.maxGuesses;
    var head = 'Wordle ' + st.day.slice(5).replace('-', '/') + ' · ' + (name || (p && p.name) || 'you');
    if (!p || !p.guesses.length) {
      var hint = settings.hard ? ' · hard mode' : '';
      return head + ' · 0/' + max + hint + '\n' + EMPTY_ROW + '\nno guesses yet — guess with `wordle CRANE`';
    }
    var lines = p.guesses.map(rowLine);
    while (lines.length < max) lines.push(EMPTY_ROW);
    var tail = ' · ' + p.guesses.length + '/' + max + (settings.hard ? ' · hard' : '');
    if (p.status === 'won') tail += ' · solved 🎉';
    else if (p.status === 'lost') tail += ' · answer was ' + st.answer.toUpperCase();
    return head + tail + '\n' + lines.join('\n');
  }
  function renderSummary(st, settings) {
    var uids = Object.keys(st.players);
    if (!uids.length) return 'no one has played today yet — be the first (`wordle CRANE`)';
    return 'today ' + st.day + ' · ' + uids.length + ' playing:\n' + uids.map(function (uid) {
      var p = st.players[uid];
      var mark = p.status === 'won' ? '🎉 ' + p.guesses.length + '/' + settings.maxGuesses : (p.status === 'lost' ? '💀 ' + p.guesses.length + '/' + settings.maxGuesses : '▶ ' + p.guesses.length + '/' + settings.maxGuesses);
      return '· ' + p.name + ' — ' + mark;
    }).join('\n');
  }
  function renderLeaderboard(stats) {
    var rows = ChloeGames.leaderboard(stats).slice(0, 10);
    if (!rows.length) return 'no scores yet — play today\'s wordle';
    return 'wordle leaderboard:\n' + rows.map(function (e, i) {
      return (i + 1) + '. ' + e.name + ' — streak ' + e.streak + ' (best ' + e.maxStreak + '), ' + e.won + '/' + e.played + ' solved';
    }).join('\n');
  }
  function renderSettings(settings) {
    return 'hard ' + (settings.hard ? 'on' : 'off') + ' · daily ' + (settings.daily ? 'on' : 'off') +
      ' · ' + settings.maxGuesses + ' guesses · ' + settings.pool + ' pool';
  }

  // IO helpers (engine passes io = {get,set} over the userscript store) ──
  function loadState(io, ch) {
    return Promise.resolve(io.get(ChloeGames.stateKey(ID, ch))).then(function (v) { return validateState(v); });
  }
  function saveState(io, ch, st) { return Promise.resolve(io.set(ChloeGames.stateKey(ID, ch), st)); }
  function loadStats(io, ch) {
    return Promise.resolve(io.get(ChloeGames.statsKey(ID, ch))).then(function (v) { return ChloeGames.validateStats(v); });
  }
  function saveStats(io, ch, s) { return Promise.resolve(io.set(ChloeGames.statsKey(ID, ch), s)); }
  // Rollover: a new day (in daily mode) starts a fresh table; unfinished
  // games don't break streaks, they just don't finish.
  function withToday(io, ch, settings, now) {
    var today = dayStr(now);
    return loadState(io, ch).then(function (st) {
      if (st && settings.daily && st.day === today && !st.forced) return { state: st, fresh: false };
      if (st && !settings.daily && st.day === today) return { state: st, fresh: false };
      if (st && settings.daily && st.day !== today && !st.forced) {
        var ns = blankState(today, dailyAnswer(poolFor(settings), now));
        return saveState(io, ch, ns).then(function () { return { state: ns, fresh: true }; });
      }
      if (st && st.forced && st.day === today) return { state: st, fresh: false };
      if (st && st.day !== today) {
        var ns2 = blankState(today, settings.daily ? dailyAnswer(poolFor(settings), now) : st.answer);
        return saveState(io, ch, ns2).then(function () { return { state: ns2, fresh: true }; });
      }
      var first = blankState(today, settings.daily ? dailyAnswer(poolFor(settings), now) : pickAnswer(poolFor(settings), Math.floor(Math.random() * 100000)));
      return saveState(io, ch, first).then(function () { return { state: first, fresh: true }; });
    });
  }

  // ctx: {uid, name, isMod, prefix, now, io, channelId}
  function playGuess(ctx, settings, word) {
    var io = ctx.io, ch = ctx.channelId;
    word = String(word || '').toLowerCase();
    if (!/^[a-z]{5}$/.test(word)) return Promise.resolve({ ack: 'guesses are 5 letters — `' + ctx.prefix + ' wordle CRANE`' });
    if (!validSet()[word]) return Promise.resolve({ ack: '"' + word.toUpperCase() + '" isn\'t in my word list — try another' });
    return withToday(io, ch, settings, ctx.now).then(function (t) {
      var st = t.state;
      var p = ensurePlayer(st, ctx.uid, ctx.name);
      if (p.status !== 'playing') {
        return { ack: renderBoard(st, settings, ctx.uid, ctx.name) + '\n' + (p.status === 'won' ? 'already solved — see you tomorrow' : 'out of guesses — see you tomorrow') };
      }
      if (p.guesses.some(function (g) { return g.w === word; })) {
        return { ack: 'you already tried ' + word.toUpperCase() + ' — try another' };
      }
      if (settings.hard) {
        var bad = hardLegal(word, p.guesses);
        if (bad) {
          var bl = '';
          for (var i = 0; i < 5; i++) bl += EMOJI[bad.p.charAt(i)];
          return { ack: 'hard mode: your guess must fit ' + bad.w.toUpperCase() + ' ' + bl + ' — try another' };
        }
      }
      var pattern = scoreGuess(word, st.answer);
      p.guesses.push({ w: word, p: pattern });
      var statsP = loadStats(io, ch);
      return statsP.then(function (stats) {
        ChloeGames.notePlayed(stats, ctx.uid, ctx.name, st.day);
        var done = null;
        if (pattern === 'ggggg') {
          p.status = 'won';
          ChloeGames.noteFinished(stats, ctx.uid, true);
          var e = stats[ctx.uid];
          done = '🎉 ' + ctx.name + ' solved it in ' + p.guesses.length + '/' + settings.maxGuesses + ' (streak ' + e.streak + ')';
        } else if (p.guesses.length >= settings.maxGuesses) {
          p.status = 'lost';
          ChloeGames.noteFinished(stats, ctx.uid, false);
          done = '💀 out of guesses — the answer was ' + st.answer.toUpperCase();
        }
        return saveState(io, ch, st).then(function () {
          return saveStats(io, ch, stats).then(function () {
            var board = renderBoard(st, settings, ctx.uid, ctx.name);
            return { ack: board + (done ? '\n' + done : '') };
          });
        });
      });
    });
  }

  function handleWordle(ctx, args) {
    var io = ctx.io, ch = ctx.channelId, pfx = ctx.prefix;
    return ChloeGames.loadIndex(io, ch).then(function (idx) {
      var settings = ChloeGames.getSettings(idx, ID);
      var a = String(args || '').trim();
      var low = a.toLowerCase();
      if (!low) {
        return withToday(io, ch, settings, ctx.now).then(function (t) {
          ensurePlayer(t.state, ctx.uid, ctx.name);
          return saveState(io, ch, t.state).then(function () {
            return { ack: renderBoard(t.state, settings, ctx.uid, ctx.name) + '\n' + pfx + ' wordle CRANE to guess · ' + pfx + ' wordle board · ' + pfx + ' wordle stats' };
          });
        });
      }
      if (low === 'board') {
        return withToday(io, ch, settings, ctx.now).then(function (t) {
          return { ack: renderSummary(t.state, settings) };
        });
      }
      if (low === 'stats' || low === 'leaderboard' || low === 'scores') {
        return loadStats(io, ch).then(function (stats) { return { ack: renderLeaderboard(stats) }; });
      }
      if (low === 'help' || low === '?') return Promise.resolve({ ack: helpLines(pfx).join('\n') });
      if (low === 'end' || low === 'close') {
        if (!ctx.isMod) return Promise.resolve({ ack: 'only mods can close today\'s game' });
        return saveState(io, ch, null).then(function () { return { ack: 'today\'s wordle is closed — next guess starts fresh' }; });
      }
      var nm = a.match(/^new(?:\s+([A-Za-z]{5}))?$/i);
      if (nm) {
        if (!ctx.isMod) return Promise.resolve({ ack: 'only mods can deal a fresh word (daily puzzle is automatic)' });
        var custom = nm[1] ? nm[1].toLowerCase() : null;
        if (custom && !validSet()[custom]) return Promise.resolve({ ack: '"' + custom.toUpperCase() + '" isn\'t in my word list' });
        var today = dayStr(ctx.now);
        var ans = custom || pickAnswer(poolFor(settings), Math.floor(Math.random() * poolFor(settings).length));
        var st = blankState(today, ans); st.forced = true;
        return saveState(io, ch, st).then(function () {
          return { ack: 'fresh wordle dealt' + (custom ? ' (' + custom.toUpperCase() + ' — shh, mods chose it)' : '') + ' — ' + pfx + ' wordle CRANE to play' };
        });
      }
      if (/^[A-Za-z]{5}$/.test(a)) return playGuess(ctx, settings, a);
      return Promise.resolve({ ack: 'usage: ' + pfx + ' wordle CRANE (guess) · ' + pfx + ' wordle board · ' + pfx + ' wordle stats' });
    });
  }

  function handleGame(ctx, args) {
    var io = ctx.io, ch = ctx.channelId, pfx = ctx.prefix;
    var a = String(args || '').trim();
    var low = a.toLowerCase();
    if (!low) {
      return ChloeGames.loadIndex(io, ch).then(function (idx) {
        var names = ChloeGames.list().map(function (d) { return d.id; }).join(', ');
        var act = idx.active ? ('tonight\'s table: ' + idx.active) : 'the table is open — no game started yet';
        return { ack: act + ' (games: ' + names + '). Try `' + pfx + ' game list` or `' + pfx + ' wordle CRANE`.' };
      });
    }
    if (low === 'list') {
      var lines = ChloeGames.list().map(function (d) { return '· ' + d.id + ' — ' + d.blurb; });
      return Promise.resolve({ ack: 'games on this bot:\n' + lines.join('\n') + '\n(more coming — wordle proves the harness)' });
    }
    var sm = a.match(/^settings(?:\s+(\S+))?(?:\s+(\S+)\s+([\s\S]+))?$/i);
    if (sm) {
      var gid = (sm[1] || ID).toLowerCase();
      var key = sm[2] ? sm[2].toLowerCase() : null;
      var val = sm[3] != null ? sm[3].trim() : null;
      return ChloeGames.loadIndex(io, ch).then(function (idx) {
        var def = ChloeGames.get(gid);
        if (!def) return { ack: 'unknown game "' + gid + '" (try: game list)' };
        var settings = ChloeGames.getSettings(idx, gid);
        if (!key) return { ack: gid + ' settings: ' + ChloeGames.describeSettings(def, settings) };
        if (!ctx.isMod) return { ack: 'only mods can change game settings (yours to read, theirs to tweak)' };
        var r = ChloeGames.setSetting(idx, gid, key, val);
        if (!r.ok) return { ack: 'settings rejected: ' + r.reason + '\n' + gid + ' settings: ' + ChloeGames.describeSettings(def, settings) };
        return ChloeGames.saveIndex(io, ch, idx).then(function () {
          return { ack: gid + ' updated: ' + ChloeGames.describeSettings(def, r.settings) };
        });
      });
    }
    var start = a.match(/^start\s+(\S+)$/i);
    if (start) {
      if (!ctx.isMod) return Promise.resolve({ ack: 'only mods can open a table (anyone can play once it\'s open)' });
      var sid = start[1].toLowerCase();
      if (!ChloeGames.get(sid)) return Promise.resolve({ ack: 'unknown game "' + sid + '" (try: game list)' });
      return ChloeGames.loadIndex(io, ch).then(function (idx) {
        idx.active = sid;
        return ChloeGames.saveIndex(io, ch, idx).then(function () {
          return { ack: sid + ' is on the table — ' + ChloeGames.get(sid).helpLines(pfx).join('\n') };
        });
      });
    }
    if (/^stop$/i.test(low)) {
      if (!ctx.isMod) return Promise.resolve({ ack: 'only mods can close the table' });
      return ChloeGames.loadIndex(io, ch).then(function (idx) {
        idx.active = null;
        return ChloeGames.saveIndex(io, ch, idx).then(function () { return { ack: 'table closed — wordle guesses will reopen it' }; });
      });
    }
    return Promise.resolve({ ack: 'usage: ' + pfx + ' game list · ' + pfx + ' game settings [wordle] [key value] · ' + pfx + ' game start wordle · ' + pfx + ' game stop' });
  }

  var def = {
    id: ID, title: TITLE, blurb: BLURB, helpLines: helpLines,
    defaultSettings: defaultSettings, schema: schema,
    handleWordle: handleWordle, handleGame: handleGame,
    // status/panel seams (pure over stored shapes) ──
    statusFor: function (idxRaw, stRaw) {
      var idx = ChloeGames.validateIndex(idxRaw);
      var st = validateState(stRaw);
      var settings = ChloeGames.getSettings(idx, ID);
      if (!st) return { active: idx.active, day: null, players: 0, solved: 0, finished: false, hard: !!settings.hard };
      var uids = Object.keys(st.players);
      var solved = uids.filter(function (u) { return st.players[u].status === 'won'; }).length;
      return { active: idx.active, day: st.day, players: uids.length, solved: solved, finished: solved > 0, hard: !!settings.hard, maxGuesses: settings.maxGuesses };
    }
  };
  ChloeGames.register(def);
  return def;
})();
