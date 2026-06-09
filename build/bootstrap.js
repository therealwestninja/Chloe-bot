// ===================================================================================
// chloe-bridge — GM transport + store adapters, control link, and menu (T0).
// Appended AFTER the verified engine.js (which defines `ChloeT0`).
// Runs only in the TOP frame; in Perchance sub-frames (the panel iframe) it no-ops,
// so the control generator's own page code is the only thing running there.
// This is plain userscript JS — NOT subject to the Perchance panel parser — so normal
// object indexing / template style is fine here (unlike the generator files).
// ===================================================================================
(function () {
  'use strict';
  if (window.top !== window) return;   // engine + link live in the top frame only

  var API = 'https://discord.com/api/v10';
  var UA = 'DiscordBot (https://github.com/therealwestninja, 1.0)';
  var NS = 'chloe:';
  var VERSION = '0.27.0';
  // D1: queen/worker role. Worker tabs are spawned with '#chloe-worker' in the URL; everything
  // else (including today's single-tab setup) is the queen. Workers never poll Discord, never
  // start the engine, and never write GM state — they contribute their tab's AI brain via jobs.
  var TAB_ROLE = (typeof location !== 'undefined' && /chloe-worker/.test(location.hash || '')) ? 'worker' : 'queen';

  function cfgGet(k, d) { var v = GM_getValue(NS + 'cfg:' + k, null); return v == null ? d : v; }
  function cfgSet(k, v) { GM_setValue(NS + 'cfg:' + k, v); }
  // #17: a small in-memory ring of link/transport/poll events, readable after the fact (the link's
  // failure modes are timing-dependent and easy to miss live). Mirrors to console; capped at 60.
  var traceRing = [], TRACE_MAX = 60;
  function trace(tag, msg) {
    var e = { t: Date.now(), tag: tag, msg: String(msg) };
    traceRing.push(e); if (traceRing.length > TRACE_MAX) traceRing = traceRing.slice(-TRACE_MAX);
    return e;
  }
  function tokenShape(t) {
    return { len: t ? t.length : 0, parts: t ? t.split('.').length : 0,
             ws: /\s/.test(t || ''), placeholder: !t || t.indexOf('PASTE_') === 0 };
  }
  function hasToken() { return !tokenShape(cfgGet('token', '')).placeholder; }

  // ---- GM store adapter (KV + maintained roster index) --------------------------------
  // D3: per-channel namespacing. The PRIMARY channel keeps the legacy un-prefixed namespace so an
  // existing install keeps its memory; every additional channel lives under 'ch:{id}:'.
  function makeStore(pfx) {
    var s = {
      get: function (k) { return Promise.resolve().then(function () { var v = GM_getValue(NS + pfx + k, null); if (v == null) return null; try { return JSON.parse(v); } catch (e) { return null; } }); },
      set: function (k, v) { GM_setValue(NS + pfx + k, JSON.stringify(v)); return Promise.resolve(true); },
      del: function (k) { GM_deleteValue(NS + pfx + k); return Promise.resolve(true); },
      listIndex: function () { return s.get('roster:index').then(function (a) { return a || []; }); },
      setIndex: function (arr) { return s.set('roster:index', arr); }
    };
    return s;
  }
  var store = makeStore('');
  function primaryChannel() { return String(cfgGet('channelId', '') || '').trim(); }
  function channelList() {
    var seen = {}, out = [];
    [primaryChannel()].concat(cfgGet('channels', []) || []).forEach(function (c) {
      c = String(c || '').trim();
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    return out;
  }
  function prefixFor(chId) { return chId === primaryChannel() ? '' : ('ch:' + chId + ':'); }
  function chKeyOf(args) { var c = String((args && args.channelId) || '').trim(); var list = channelList(); return (c && list.indexOf(c) >= 0) ? c : (list[0] || ''); }

  // ---- Discord transport (anonymous + bot UA + 429 honor) -----------------------------
  function dataUrlToBlob(dataUrl) {
    var s = String(dataUrl);
    var comma = s.indexOf(',');
    var meta = s.slice(0, comma), data = s.slice(comma + 1);
    var mime = (meta.match(/data:([^;]+)/) || [null, 'image/jpeg'])[1];
    var bytes;
    if (/;base64/i.test(meta)) {
      var bin = atob(data); var n = bin.length; bytes = new Uint8Array(n);
      for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(data));
    }
    return new Blob([bytes], { type: mime });
  }
  function rawRequest(method, path, opts) {
    opts = opts || {};
    var token = cfgGet('token', '');
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: method, url: API + path,
        headers: Object.assign({ 'Authorization': 'Bot ' + token, 'User-Agent': UA },
                               opts.json ? { 'Content-Type': 'application/json' } : {},
                               opts.headers || {}),
        data: opts.formData ? opts.formData : (opts.body != null ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined),
        anonymous: true,
        onload: function (r) { resolve(r); },
        onerror: function () { reject(new Error('transport error')); },
        ontimeout: function () { reject(new Error('transport timeout')); }
      });
    });
  }
  function requestJSON(method, path, opts, _tries) {
    _tries = _tries || 0;
    return rawRequest(method, path, opts).then(function (r) {
      if (r.status === 429 && _tries < 4) {
        var retry = 1; try { retry = (JSON.parse(r.responseText).retry_after) || 1; } catch (e) {}
        var hdr = /retry-after:\s*([\d.]+)/i.exec(r.responseHeaders || ''); if (hdr) retry = parseFloat(hdr[1]);
        trace('http', '429 on ' + method + ' ' + path + '; retry in ' + retry + 's');
        return new Promise(function (res) { setTimeout(res, Math.ceil(retry * 1000) + 50); })
          .then(function () { return requestJSON(method, path, opts, _tries + 1); });
      }
      var body = null; try { body = JSON.parse(r.responseText); } catch (e) {}
      if (r.status < 200 || r.status >= 300) { trace('http', 'HTTP ' + r.status + ' on ' + method + ' ' + path); var err = new Error('HTTP ' + r.status + (body ? ' ' + JSON.stringify(body) : '')); err.status = r.status; err.body = body; throw err; }
      return body;
    });
  }
  var transport = {
    getMe: function () { return requestJSON('GET', '/users/@me'); },
    getMessagesAfter: function (channelId, afterId, limit) {
      return requestJSON('GET', '/channels/' + channelId + '/messages?limit=' + (limit || 50) + (afterId ? '&after=' + afterId : ''));
    },
    sendMessage: function (channelId, text) {
      return requestJSON('POST', '/channels/' + channelId + '/messages', { json: true, body: { content: String(text || '').slice(0, 1900) } });
    },
    sendEmbed: function (channelId, embed) {
      return requestJSON('POST', '/channels/' + channelId + '/messages', { json: true, body: { embeds: [embed] } });
    },
    addReaction: function (channelId, messageId, emoji) {
      return requestJSON('PUT', '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me', {});
    },
    pinMessage: function (channelId, messageId) {
      return requestJSON('PUT', '/channels/' + channelId + '/pins/' + messageId, {});   // needs Manage Messages; 204 on success
    },
    startTyping: function (channelId) { return requestJSON('POST', '/channels/' + channelId + '/typing', { json: true, body: {} }); },
    getChannel: function (channelId) { return requestJSON('GET', '/channels/' + channelId, {}); },
    getReactions: function (channelId, messageId, emoji) { return requestJSON('GET', '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '?limit=10', {}); },
    getMember: function (guildId, userId) { return requestJSON('GET', '/guilds/' + guildId + '/members/' + userId, {}); },
    getMessagesBefore: function (channelId, beforeId, limit) {
      return requestJSON('GET', '/channels/' + channelId + '/messages?limit=' + (limit || 100) + (beforeId ? '&before=' + beforeId : ''));
    },
    banUser: function (guildId, userId, reason) {
      var h = reason ? { 'X-Audit-Log-Reason': encodeURIComponent(String(reason)).slice(0, 480) } : {};
      return requestJSON('PUT', '/guilds/' + guildId + '/bans/' + userId, { json: true, body: {}, headers: h });
    },
    // post an image as a native file attachment (multipart). content-type/boundary are set by
    // the request layer from the FormData, so we must NOT set Content-Type ourselves.
    sendImage: function (channelId, dataUrl, caption) {
      var blob = dataUrlToBlob(dataUrl);
      var ext = blob.type.indexOf('png') >= 0 ? 'png' : 'jpg';
      var fd = new FormData();
      fd.append('payload_json', JSON.stringify({ content: String(caption || '').slice(0, 1900) }));
      fd.append('files[0]', blob, 'chloe.' + ext);
      return requestJSON('POST', '/channels/' + channelId + '/messages', { formData: fd });
    },
    openDM: function (userId) {
      return requestJSON('POST', '/users/@me/channels', { json: true, body: { recipient_id: String(userId) } })
        .then(function (ch) { return ch && ch.id; });
    }
  };
  // #3: outbound send cap. The engine already spaces text sends, but greet/reply/image/beat lanes and
  // multi-ack batches can still bunch up; this serializes ALL outbound posts through one queue with a
  // minimum gap, a hard floor that keeps bursts under Discord's per-channel rate (429s stay the backstop).
  var SEND_MIN_GAP = cfgGet('sendMinGapMs', 1100), sendQueue = Promise.resolve(), lastSendAt = 0;
  function paced(fn) {
    return function () {
      var args = arguments;
      var run = function () {
        var wait = Math.max(0, SEND_MIN_GAP - (Date.now() - lastSendAt));
        return new Promise(function (res) { setTimeout(res, wait); }).then(function () { lastSendAt = Date.now(); return fn.apply(transport, args); });
      };
      var ret = sendQueue.then(run, run);   // run regardless of the previous send's outcome
      sendQueue = ret.catch(function () {}); // keep the chain alive for the next caller
      return ret;
    };
  }
  ['sendMessage', 'sendEmbed', 'sendImage'].forEach(function (k) { var orig = transport[k]; transport[k] = paced(orig); });

  // ---- bidirectional link plumbing: userscript -> page (brain) ------------------------
  // The page (generator HTML panel) is the only context that can run aiTextPlugin, so the
  // engine asks it to generate over a reverse call. Page window ref is captured on any
  // valid inbound message and refreshed on reload.
  var pageSource = null, pageOrigin = null;
  // #14: some userscript managers sandbox `window` so the page's postMessages miss a listener bound
  // to the wrapped window; bind to the real page window when available (Tampermonkey works either way).
  var LINKWIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  // #15: a sandboxed frame can report origin 'null'; posting back to targetOrigin 'null' is dropped,
  // so fall back to '*' in that one case (responses are nonce-matched, so this stays safe).
  function replyTarget(o) { return (o && o !== 'null') ? o : '*'; }
  var callPending = new Map(); var callSeq = 0;
  function callPage(method, args, timeoutMs) {
    return new Promise(function (resolve) {
      if (!pageSource) { resolve({ ok: false, reason: 'no control page linked (open the Chloe generator tab)' }); return; }
      var nonce = 'u' + (++callSeq) + '_' + Date.now();
      var t = setTimeout(function () { callPending.delete(nonce); resolve({ ok: false, reason: 'page timeout' }); }, timeoutMs || 30000);
      callPending.set(nonce, function (res) { clearTimeout(t); resolve(res); });
      try { pageSource.postMessage({ __chloe: 1, kind: 'call', nonce: nonce, method: method, args: args || null }, replyTarget(pageOrigin)); }
      catch (e) { clearTimeout(t); callPending.delete(nonce); resolve({ ok: false, reason: 'post failed' }); }
    });
  }
  function pushEvent(name, value) { if (!pageSource) return; try { pageSource.postMessage({ __chloe: 1, kind: 'event', name: name, value: value }, replyTarget(pageOrigin)); } catch (e) {} }

  // ---- D2: brain offload --------------------------------------------------------------
  // Every brain call goes through here: if this is the queen and an idle worker exists, the job
  // runs on that worker's tab (its own AI/image brokers — the genuinely parallel resource);
  // otherwise, or on any worker failure/loss mid-job, it runs locally via callPage. The engine
  // never knows the difference: same promise, same {ok, value} shape.
  function brainCall(kind, args, timeoutMs) {
    timeoutMs = timeoutMs || 40000;
    if (kind !== 'paint') {
      var dials = cfgGet('personality', null);
      if (dials) args = Object.assign({}, args || {}, { personality: dials });
    }
    function local() { return callPage(kind, args, timeoutMs); }
    if (tabBridge && TAB_ROLE === 'queen') {
      return tabBridge.dispatchJob('brain', { kind: kind, args: args, timeoutMs: timeoutMs }, timeoutMs + 5000, local);
    }
    return local();
  }

  // ---- engine wiring ------------------------------------------------------------------
  var engines = {};   // D3: channelId -> engine (each with its own namespaced store)
  var lastPoll = null;
  function buildEngine(chId) {
    var channelId = String(chId || primaryChannel() || '').trim();
    if (!channelId) return null;
    var eng = ChloeT0.createEngine({
      transport: transport, store: makeStore(prefixFor(channelId)),
      config: {
        channelId: channelId,
        botUserId: cfgGet('botUserId', ''),
        botName: cfgGet('botName', ''),
        botAliases: cfgGet('botAliases', []),
        addressMode: cfgGet('addressMode', 'both'),
        volunteer: !!cfgGet('volunteer', false),
        greet: !!cfgGet('greet', false),
        backfill: !!cfgGet('backfill', false),
        image: !!cfgGet('image', false),
        imageQueueMax: cfgGet('imageQueueMax', 8),
        imageCooldownMs: cfgGet('imageCooldownMs', 2000),
        autoMod: !!cfgGet('autoMod', false),
        autoModRules: cfgGet('autoModRules', []),
        strikeLadder: cfgGet('strikeLadder', [
          { action: 'ignore' },
          { action: 'timeout', durationMs: 600000 },
          { action: 'timeout', durationMs: 3600000 },
          { action: 'softban' }
        ]),
        strikeDecayMs: cfgGet('strikeDecayMs', 86400000),
        engageMode: cfgGet('engageMode:' + channelId, cfgGet('engageMode', 'normal')),
        beats: cfgGet('beats', []),
        beatFn: function (b) { return brainCall('beat', b, 30000); },
        greetFn: function (ctx) { return brainCall('greet', ctx, 40000); },
        modList: cfgGet('modList', []),
        commandPrefix: '!chloe', ackCommands: true,
        backgroundText: true,
        commandPrefixes: cfgGet('commandPrefixes', []),
        pollIntervalMs: 6000, cooldownMs: 8000, debounceMs: 2500, contextLines: 12,
        volunteerCooldownMs: 45000, judgeMinConfidence: 0.6,
        respond: function (ctx) { return brainCall('respond', ctx, 40000); },
        judge: function (ctx) { return brainCall('judge', ctx, 40000); },
        recapFn: function (ctx) { return brainCall('recap', ctx, 45000); },
        typing: function (cid) { return transport.startTyping(cid); },
        react: function (cid, mid, emoji) { return transport.addReaction(cid, mid, emoji); },
        paint: function (req) { return brainCall('paint', { prompt: req.prompt, resolution: req.resolution }, 120000); },
        sendImage: function (cid, dataUrl, caption) { return transport.sendImage(cid, dataUrl, caption); },
        openDM: function (uid) { return transport.openDM(uid); },
        send: function (cid, text) { return transport.sendMessage(cid, text); },
        sendEmbed: function (cid, embed) { return transport.sendEmbed(cid, embed); },
        onPoll: function (summary) {
          lastPoll = summary; pushEvent('poll', summary);
          if (summary && (summary.ingested || summary.replied || summary.imageJob || summary.greeted || summary.volunteered || summary.commands)) {
            trace('poll', 'in ' + (summary.ingested || 0) + (summary.replied ? ' reply' : '') + (summary.imageJob ? ' image' : '') + (summary.greeted ? ' greet' : '') + (summary.volunteered ? ' vol' : '') + (summary.commands ? ' cmd' : '') + ' [' + (summary.engageMode || 'normal') + ']');
          }
          if (summary && summary.engageMode && summary.engageMode !== cfgGet('engageMode:' + channelId, cfgGet('engageMode', 'normal'))) cfgSet('engageMode:' + channelId, summary.engageMode);  // a !chloe lockdown/unlock/open command changed it
          return presenceMaintenance(channelId);
        }
      },
      log: function () { console.log.apply(console, arguments); }
    });
    engines[channelId] = eng;
    return eng;
  }

  // T5: transport-backed maintenance, run after each poll. Backfill walks history one bounded page
  // at a time; the departure sweep 404-checks a bounded, prioritized set on a slow cadence.
  var maintTick = 0;
  function presenceMaintenance(chId) {
    var eng = engines[chId];
    if (!eng) return Promise.resolve();
    var jobs = Promise.resolve();
    if (cfgGet('backfill', false) && !cfgGet('backfillDone:' + chId, false)) {
      jobs = jobs.then(function () {
        return eng.backfillStep(function (before, limit) { return transport.getMessagesBefore(chId, before, limit); })
          .then(function (r) { if (r) { if (!r.done) pushEvent('backfill', r); else { cfgSet('backfillDone:' + chId, true); var allDone = channelList().every(function (c) { return cfgGet('backfillDone:' + c, false); }); if (allDone) cfgSet('backfill', false); console.log('[chloe.T5] backfill complete (' + chId + '): ' + r.ingested + ' msgs over ' + r.pages + ' page(s)'); pushEvent('backfill', r); } } }, function () {});
      });
    }
    maintTick++;
    if (cfgGet('memberCheck', false) && (maintTick % 10 === 0)) {
      jobs = jobs.then(function () {
        return resolveGuildId(chId).then(function (gid) {
          if (!gid) return;
          return eng.dueForMemberCheck(5).then(function (due) {
            var c = Promise.resolve();
            due.forEach(function (d) {
              c = c.then(function () {
                return transport.getMember(gid, d.id).then(
                  function () { return eng.noteMemberPresent(d.id); },
                  function (err) { if (err && err.status === 404) { console.log('[chloe.T5] ' + d.name + ' is no longer a member; marking departed'); return eng.markDeparted(d.id); } return eng.noteMemberPresent(d.id); }
                );
              });
            });
            return c;
          });
        }).catch(function () {});
      });
    }
    if (cfgGet('personaAnchor', false) && (maintTick % 10 === 3)) {
      jobs = jobs.then(function () {
        return eng.anchorSweep(
          function () { return transport.getMessagesAfter(chId, null, 20); },
          function (mid, emoji) { return transport.getReactions(chId, mid, emoji); }
        ).then(function (r) { if (r && r.changed) { trace('persona', 'new anchored note (' + chId + ')'); pushEvent('persona', r); } }, function () {});
      });
    }
    return jobs;
  }
  function ensureEngines() { return channelList().map(function (c) { return engines[c] || buildEngine(c); }).filter(Boolean); }
  function engineFor(chId) { var c = chKeyOf({ channelId: chId }); if (!c) return null; return engines[c] || buildEngine(c); }
  function ensureEngine() { return engineFor(''); }
  function eachEngine(fn) { Object.keys(engines).forEach(function (c) { try { fn(engines[c], c); } catch (e) {} }); }

  var guildIdCache = {};
  function resolveGuildId(chId) {
    var cid = String(chId || primaryChannel() || '').trim();
    if (!cid) return Promise.resolve(null);
    if (guildIdCache[cid]) return Promise.resolve(guildIdCache[cid]);
    return transport.getChannel(cid).then(function (ch) {
      guildIdCache[cid] = (ch && ch.guild_id) || null;
      return guildIdCache[cid];
    }, function () { return null; });
  }
  // config changes must not run on a stale instance: stop, rebuild, and restart if it was live
  function applyConfigChange() {
    var wasRunning = Object.keys(engines).some(function (c) { return engines[c] && engines[c].isRunning && engines[c].isRunning(); });
    eachEngine(function (e) { e.stop(); });
    engines = {};
    guildIdCache = {};
    if (wasRunning) ensureEngines().forEach(function (e) { e.start(); });
  }

  function validate() {
    return transport.getMe().then(function (me) {
      cfgSet('botUserId', me.id); cfgSet('botName', me.username || '');
      applyConfigChange();  // rebuild (and restart if live) with the fresh identity
      return { ok: true, value: { id: me.id, username: me.username, bot: me.bot } };
    }).catch(function (e) { return { ok: false, reason: 'HTTP ' + (e.status || '?'), body: e.body || null }; });
  }
  function statusSnapshot() {
    return {
      version: VERSION, hasToken: hasToken(),
      channelId: cfgGet('channelId', ''), botUserId: cfgGet('botUserId', ''), botName: cfgGet('botName', ''),
      addressMode: cfgGet('addressMode', 'both'), volunteer: !!cfgGet('volunteer', false),
      greet: !!cfgGet('greet', false), memberCheck: !!cfgGet('memberCheck', false), backfill: !!cfgGet('backfill', false),
      image: !!cfgGet('image', false),
      imageQueueMax: cfgGet('imageQueueMax', 8),
      autoMod: !!cfgGet('autoMod', false), autoModRules: cfgGet('autoModRules', []),
      engageMode: cfgGet('engageMode:' + primaryChannel(), cfgGet('engageMode', 'normal')),
      channels: channelList(),
      engageModes: (function () { var m = {}; channelList().forEach(function (c) { m[c] = cfgGet('engageMode:' + c, cfgGet('engageMode', 'normal')); }); return m; })(),
      runningByChannel: (function () { var m = {}; channelList().forEach(function (c) { m[c] = !!(engines[c] && engines[c].isRunning && engines[c].isRunning()); }); return m; })(),
      beats: cfgGet('beats', []),
      commandPrefixes: cfgGet('commandPrefixes', []),
      noticePinned: !!cfgGet('noticePinned', false), noticeText: cfgGet('noticeText', ''),
      personality: cfgGet('personality', null), personaAnchor: !!cfgGet('personaAnchor', false),
      pageLinked: !!pageSource,
      running: Object.keys(engines).some(function (c) { return engines[c] && engines[c].isRunning && engines[c].isRunning(); }),
      lastPoll: lastPoll
    };
  }

  // ---- control link: page (generator HTML panel) -> userscript (trusted surface) ------
  // Mirrors the skybridge trust shape: origin-checked, nonce-matched, scoped commands,
  // secrets never cross (the bot token is never returned to the page).
  var ORIGIN_OK = /^https:\/\/([a-z0-9]{32}\.)?perchance\.org$/;
  function dispatch(cmd, args) {
    switch (cmd) {
      case 'ping':            return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'status':          return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'config.setChannel':
        cfgSet('channelId', String((args && args.channelId) || '').trim()); applyConfigChange();
        return Promise.resolve({ ok: true, value: { channelId: cfgGet('channelId', '') } });
      case 'config.setMode':
        { var mode = String((args && args.mode) || 'both'); if (mode !== 'mention' && mode !== 'name' && mode !== 'both') mode = 'both'; cfgSet('addressMode', mode); applyConfigChange(); return Promise.resolve({ ok: true, value: { addressMode: mode } }); }
      case 'config.setVolunteer':
        { var on = !!(args && args.on); cfgSet('volunteer', on); applyConfigChange(); return Promise.resolve({ ok: true, value: { volunteer: on } }); }
      case 'config.setGreet':
        { var g = !!(args && args.on); cfgSet('greet', g); applyConfigChange(); return Promise.resolve({ ok: true, value: { greet: g } }); }
      case 'config.setMemberCheck':
        { var mc = !!(args && args.on); cfgSet('memberCheck', mc); return Promise.resolve({ ok: true, value: { memberCheck: mc } }); }
      case 'config.setBackfill':
        { var bf = !!(args && args.on); cfgSet('backfill', bf); applyConfigChange(); return Promise.resolve({ ok: true, value: { backfill: bf } }); }
      case 'config.setImage':
        { var im = !!(args && args.on); cfgSet('image', im); applyConfigChange(); return Promise.resolve({ ok: true, value: { image: im } }); }
      case 'config.setPrefixes': {
        var list = (args && args.prefixes);
        if (!Array.isArray(list)) return Promise.resolve({ ok: false, reason: 'prefixes must be an array' });
        var clean = [];
        list.forEach(function (p) { p = String(p || '').trim(); if (p && p !== '!chloe' && clean.indexOf(p) < 0) clean.push(p); });
        cfgSet('commandPrefixes', clean); applyConfigChange();
        return Promise.resolve({ ok: true, value: { commandPrefixes: clean } });
      }
      case 'mod.pinNotice': {
        var force = !!(args && args.force);
        if (cfgGet('noticePinned', false) && !force) return Promise.resolve({ ok: true, value: { already: true } });
        var nch = chKeyOf(args);
        if (!nch) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var ntext = (args && args.text) ? String(args.text) : 'Heads up: Chloe is a roleplay bot character, not a real person. She reads this channel and remembers regulars so she can chat in character. Mods can adjust or pause her at any time.';
        return transport.sendMessage(nch, ntext).then(function (m) {
          var mid = m && m.id;
          if (!mid) return { ok: false, reason: 'no message id returned' };
          return transport.pinMessage(nch, mid).then(function () {
            cfgSet('noticePinned', true); cfgSet('noticeMsgId', mid); cfgSet('noticeText', ntext);
            return { ok: true, value: { messageId: mid } };
          }, function (e) { return { ok: false, reason: 'posted, but pin failed (Manage Messages permission?): ' + ((e && e.message) || e) }; });
        }, function (e) { return { ok: false, reason: 'post failed: ' + ((e && e.message) || e) }; });
      }
      case 'config.setBeats': {
        var bl = (args && args.beats);
        if (!Array.isArray(bl)) return Promise.resolve({ ok: false, reason: 'beats must be an array' });
        var cleanB = [];
        bl.forEach(function (b) {
          if (!b || !b.id || !b.intervalMs) return;
          var o = { id: String(b.id), intervalMs: Number(b.intervalMs) || 0 };
          if (!o.intervalMs) return;
          if (Array.isArray(b.texts) && b.texts.length) o.texts = b.texts.map(String);
          else if (b.text) o.text = String(b.text);
          else if (b.prompt) o.prompt = String(b.prompt);
          else return;   // a beat with nothing to say is dropped
          if (b.activeWithinMs != null) o.activeWithinMs = Number(b.activeWithinMs) || 0;
          cleanB.push(o);
        });
        cfgSet('beats', cleanB); applyConfigChange();
        return Promise.resolve({ ok: true, value: { count: cleanB.length, beats: cleanB } });
      }
      case 'config.setPersonality': {
        var rawP = (args && args.personality);
        if (rawP == null) { cfgSet('personality', null); return Promise.resolve({ ok: true, value: { personality: null } }); }
        if (typeof rawP !== 'object') return Promise.resolve({ ok: false, reason: 'personality must be an object of 0..1 dials' });
        var DIALS = ['kindness', 'sarcasm', 'curiosity', 'playfulness', 'formality', 'verbosity'];
        var cleanP = {};
        DIALS.forEach(function (k) { if (rawP[k] != null && isFinite(rawP[k])) cleanP[k] = Math.max(0, Math.min(1, Number(rawP[k]))); });
        cfgSet('personality', cleanP);
        return Promise.resolve({ ok: true, value: { personality: cleanP } });
      }
      case 'config.setPersonaAnchor':
        { var paOn = !!(args && args.on); cfgSet('personaAnchor', paOn); return Promise.resolve({ ok: true, value: { personaAnchor: paOn } }); }
      case 'persona.get': {
        var eP = engineFor(args && args.channelId); if (!eP) return Promise.resolve({ ok: true, value: null });
        return eP.getPersonaNote().then(function (n) { return { ok: true, value: n }; });
      }
      case 'persona.clear': {
        var eC = engineFor(args && args.channelId); if (!eC) return Promise.resolve({ ok: false, reason: 'no channel set' });
        return eC.clearPersonaNote().then(function () { return { ok: true, value: { cleared: true } }; });
      }
      case 'config.setChannels': {
        var rawC = (args && args.channels);
        if (!Array.isArray(rawC)) return Promise.resolve({ ok: false, reason: 'channels must be an array of channel ids' });
        var cleanC = [], seenC = {};
        rawC.forEach(function (c) { c = String(c || '').trim(); if (/^\d+$/.test(c) && c !== primaryChannel() && !seenC[c]) { seenC[c] = 1; cleanC.push(c); } });
        cfgSet('channels', cleanC); applyConfigChange();
        return Promise.resolve({ ok: true, value: { channels: channelList() } });
      }
      case 'config.setEngageMode': {
        var mode = (args && args.mode);
        if (mode !== 'locked' && mode !== 'normal' && mode !== 'open') return Promise.resolve({ ok: false, reason: 'mode must be locked|normal|open' });
        var emCh = chKeyOf(args);
        if (!emCh) return Promise.resolve({ ok: false, reason: 'no channel set' });
        cfgSet('engageMode:' + emCh, mode); applyConfigChange();
        return Promise.resolve({ ok: true, value: { engageMode: mode, channelId: emCh } });
      }
      case 'config.setImageQueue': {
        var n = Math.max(1, Math.min(20, parseInt((args && args.max), 10) || 8));
        cfgSet('imageQueueMax', n); applyConfigChange();
        return Promise.resolve({ ok: true, value: { imageQueueMax: n } });
      }
      case 'config.setAutoMod':
        { var am = !!(args && args.on); cfgSet('autoMod', am); applyConfigChange(); return Promise.resolve({ ok: true, value: { autoMod: am } }); }
      case 'config.setAutoModRules': {
        var rules = (args && args.rules);
        if (!Array.isArray(rules)) return Promise.resolve({ ok: false, reason: 'rules must be an array' });
        var clean = [];
        rules.forEach(function (r) {
          if (!r || !r.pattern) return;
          var type = (r.type === 'regex' || r.type === 'confusables' || r.type === 'link') ? r.type : 'text';
          var action = (r.action === 'timeout' || r.action === 'softban' || r.action === 'clear' || r.action === 'warn') ? r.action : 'ignore';  // reversible only ('warn' = escalate)
          var o = { pattern: String(r.pattern), type: type, action: action };
          if (r.durationMs) o.durationMs = Number(r.durationMs) || undefined;
          if (r.reason) o.reason = String(r.reason);
          clean.push(o);
        });
        cfgSet('autoModRules', clean); applyConfigChange();
        return Promise.resolve({ ok: true, value: { count: clean.length, rules: clean } });
      }
      case 'bridge.status':
        return Promise.resolve({ ok: true, value: { role: TAB_ROLE, tabId: tabBridge ? tabBridge.tabId : null, bus: !!tabBus, workers: (tabBridge && TAB_ROLE === 'queen') ? tabBridge.workers() : {} } });
      case 'bridge.spawn':
        { if (TAB_ROLE !== 'queen') return Promise.resolve({ ok: false, reason: 'only the queen spawns workers' }); return Promise.resolve(spawnWorker()); }
      case 'bridge.shutdown':
        { if (!tabBridge || TAB_ROLE !== 'queen') return Promise.resolve({ ok: false, reason: 'no bridge / not the queen' }); tabBridge.shutdownWorker(String((args && args.id) || '')); return Promise.resolve({ ok: true, value: { id: (args && args.id) || null } }); }
      case 'diag':
        { var snap = statusSnapshot(); console.log('[chloe] diag', snap); return Promise.resolve({ ok: true, value: snap }); }
      case 'diag.trace':
        return Promise.resolve({ ok: true, value: traceRing.slice() });
      case 'token.prompt':    promptToken(); return Promise.resolve({ ok: true, value: { hasToken: hasToken() } });
      case 'token.validate':  return validate();
      case 'start':           { if (TAB_ROLE === 'worker') return Promise.resolve({ ok: false, reason: 'this tab is a worker \u2014 the engine (and the Discord transport) runs only in the queen tab' }); var es1 = ensureEngines(); if (!es1.length) return Promise.resolve({ ok: false, reason: 'no channel set' }); es1.forEach(function (e) { e.start(); }); cfgSet('autoResume', true); return Promise.resolve({ ok: true, value: statusSnapshot() }); }
      case 'stop':            eachEngine(function (e) { e.stop(); }); cfgSet('autoResume', false); return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'poll.once':       { var e2 = engineFor(args && args.channelId); if (!e2) return Promise.resolve({ ok: false, reason: 'no channel set' }); return e2.pollOnce().then(function (s) { return { ok: true, value: s }; }).catch(function (err) { return { ok: false, reason: err.message }; }); }
      case 'roster.get':      { var e3 = engineFor(args && args.channelId); if (!e3) return Promise.resolve({ ok: true, value: [] }); return e3.getRoster().then(function (r) { return { ok: true, value: r }; }); }
      case 'ring.get':        { var e4 = engineFor(args && args.channelId); if (!e4) return Promise.resolve({ ok: true, value: [] }); return e4.getSpeakerRing().then(function (r) { return { ok: true, value: r }; }); }
      case 'reset':           return resetState(true).then(function () { return { ok: true }; });
      // ---- T3 moderation: trusted (panel) actions + mod-list management ----
      case 'mod.action': {
        var act = String((args && args.action) || '');
        if (act === 'permaban') return Promise.resolve({ ok: false, reason: 'unimplemented (T4; irreversible purge requires a confirm in the trusted surface)' });
        var e5 = engineFor(args && args.channelId); if (!e5) return Promise.resolve({ ok: false, reason: 'no channel set' });
        return e5.applyModAction(act, String((args && args.id) || ''), { durationMs: args && args.durationMs, reason: args && args.reason, byModId: 'panel' });
      }
      case 'mod.listMods': return Promise.resolve({ ok: true, value: cfgGet('modList', []) });
      case 'mod.addMod': {
        var idA = String((args && args.id) || '').trim(); if (!idA) return Promise.resolve({ ok: false, reason: 'no id' });
        var listA = cfgGet('modList', []); if (listA.indexOf(idA) < 0) listA.push(idA); cfgSet('modList', listA); applyConfigChange();
        return Promise.resolve({ ok: true, value: listA });
      }
      case 'mod.removeMod': {
        var idR = String((args && args.id) || '').trim();
        var listR = cfgGet('modList', []).filter(function (x) { return x !== idR; }); cfgSet('modList', listR); applyConfigChange();
        return Promise.resolve({ ok: true, value: listR });
      }
      case 'mod.modlog': {
        var e6 = engineFor(args && args.channelId); if (!e6) return Promise.resolve({ ok: true, value: [] });
        return e6.getModLog().then(function (l) { return { ok: true, value: l }; });
      }
      // T4 irreversible: the authoritative confirm lives HERE, in the trusted surface (top frame).
      // Ban FIRST; only purge if the ban succeeds, so we never leave a purged-but-present stranger (F1).
      case 'mod.permaban': {
        var pid = String((args && args.id) || '').trim();
        var pname = String((args && args.name) || pid);
        var preason = (args && args.reason) || 'Chloe permaban';
        if (!pid) return Promise.resolve({ ok: false, reason: 'no target' });
        var e7 = engineFor(args && args.channelId); if (!e7) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var sure = false;
        try { sure = window.confirm('PERMABAN + PURGE "' + pname + '"?\n\nThis bans them from the Discord server AND permanently deletes everything Chloe remembers about them. This cannot be undone.'); } catch (e) { sure = false; }
        if (!sure) { log('[chloe.T4] permaban of ' + pname + ' cancelled at confirm'); return Promise.resolve({ ok: false, reason: 'cancelled' }); }
        return resolveGuildId(chKeyOf(args)).then(function (gid) {
          if (!gid) return { ok: false, reason: 'could not resolve guild id from channel' };
          log('[chloe.T4] banning ' + pname + ' (' + pid + ') ...');
          return transport.banUser(gid, pid, preason).then(function () {
            log('[chloe.T4] ban ok; purging partition ...');
            return e7.purge(pid, { targetName: pname }).then(function (pr) {
              if (!pr.ok) { log('[chloe.T4] PURGE NOT VERIFIED for ' + pname + ': ' + pr.reason); return { ok: false, reason: pr.reason, value: { banned: true, purged: false, verified: false } }; }
              return e7.appendModLog({ action: 'permaban', targetId: pid, name: pname, byModId: 'panel', reason: preason, at: Date.now() }).then(function () {
                log('[chloe.T4] permaban complete for ' + pname + ' (banned + purge verified)');
                return { ok: true, value: { banned: true, purged: true, verified: true, name: pname } };
              });
            });
          }, function (err) {
            log('[chloe.T4] ban FAILED for ' + pname + ': ' + err.message + ' — partition NOT purged (no purged-but-present)');
            return { ok: false, reason: 'ban failed: ' + err.message + ' (purge aborted; bot likely lacks Ban Members)', value: { banned: false, purged: false } };
          });
        });
      }
      default:                return Promise.resolve({ ok: false, reason: 'unknown command: ' + cmd });
    }
  }
  LINKWIN.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__chloe !== 1) return;
    if (!ORIGIN_OK.test(ev.origin)) { trace('link', 'rejected chloe-shaped message from disallowed origin ' + ev.origin); return; }
    // capture/refresh the control page window so the engine can call its brain
    if (!pageSource) trace('link', 'control page connected from ' + ev.origin);
    pageSource = ev.source; pageOrigin = ev.origin;
    if (d.kind === 'callres') { var cb = callPending.get(d.nonce); if (cb) { callPending.delete(d.nonce); cb(d); } return; }
    if (d.kind !== 'req') return;
    var nonce = d.nonce, source = ev.source, origin = ev.origin;
    Promise.resolve().then(function () { return dispatch(d.cmd, d.args); })
      .then(function (res) { res = res || { ok: false, reason: 'no result' }; res.__chloe = 1; res.kind = 'res'; res.nonce = nonce; try { source.postMessage(res, replyTarget(origin)); } catch (e) {} })
      .catch(function (err) { trace('dispatch', '"' + d.cmd + '" failed: ' + String(err && err.message || err)); try { source.postMessage({ __chloe: 1, kind: 'res', nonce: nonce, ok: false, reason: String(err && err.message || err) }, replyTarget(origin)); } catch (e) {} });
  });

  // ---- D1: tab bridge (queen/worker) ---------------------------------------------------
  // Same-origin BroadcastChannel between userscript instances; GM value-change events as the
  // fallback bus (script-scoped, so it also survives exotic sandboxing). The bus token lives in
  // GM storage — page code on perchance.org cannot read it, so only our tabs can speak.
  function makeBroadcastBus() {
    if (typeof BroadcastChannel === 'undefined') return null;
    try {
      var ch = new BroadcastChannel('chloe_bridge_v1');
      return { post: function (e) { ch.postMessage(e); }, onMessage: function (fn) { ch.onmessage = function (ev) { fn(ev.data); }; } };
    } catch (e) { return null; }
  }
  function makeGmBus() {
    if (typeof GM_addValueChangeListener !== 'function') return null;
    var KEY = NS + 'bus:frame', fn = null;
    GM_addValueChangeListener(KEY, function (name, oldV, newV, remote) { if (remote && newV && newV.env && fn) fn(newV.env); });
    return { post: function (e) { GM_setValue(KEY, { n: Date.now() + Math.random(), env: e }); }, onMessage: function (f) { fn = f; } };
  }
  var busToken = GM_getValue(NS + 'bus:token', null);
  if (!busToken) { busToken = Math.random().toString(36).slice(2) + Date.now().toString(36); GM_setValue(NS + 'bus:token', busToken); }
  var tabBus = makeBroadcastBus() || makeGmBus();
  var tabBridge = null;
  // D6: the queen lease — the single source of truth for "who is queen" during failover.
  var queenLease = {
    get: function () { var v = GM_getValue(NS + 'queen:lease', null); if (v == null) return Promise.resolve(null); try { return Promise.resolve(JSON.parse(v)); } catch (e) { return Promise.resolve(null); } },
    set: function (v) { GM_setValue(NS + 'queen:lease', JSON.stringify(v)); return Promise.resolve(true); }
  };
  if (tabBus && typeof ChloeTabBridge !== 'undefined') {
    tabBridge = ChloeTabBridge.createTabBridge({
      role: TAB_ROLE, token: busToken, bus: tabBus,
      lease: queenLease,
      queenDeadAfterMs: cfgGet('queenDeadAfterMs', 90000),
      log: function (m) { trace('bridge', m); },
      onWorkerJoin: function (id) { trace('bridge', 'worker joined: ' + id); },
      onWorkerLost: function (id, why) { trace('bridge', 'worker lost: ' + id + ' (' + why + ')'); },
      onShutdown: function () { try { window.close(); } catch (e) { trace('bridge', 'self-close blocked'); } },
      // D6: this tab won the election after the queen tab died.
      onPromote: function () {
        TAB_ROLE = 'queen';
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
        trace('bridge', 'PROMOTED to queen' + (cfgGet('autoResume', false) ? ' \u2014 resuming the engine(s)' : ''));
        console.log('[chloe-bridge] this tab was promoted to QUEEN (the previous queen tab went silent).');
        if (cfgGet('autoResume', false)) { try { ensureEngines().forEach(function (e) { e.start(); }); } catch (e) { trace('bridge', 'auto-resume failed: ' + (e && e.message)); } }
      },
      // D6: a lease conflict said another tab is queen — stand down completely.
      onDemote: function () {
        TAB_ROLE = 'worker';
        eachEngine(function (e) { e.stop(); });
        try { if (location.hash.indexOf('chloe-worker') < 0) location.hash = 'chloe-worker'; } catch (e) {}
        trace('bridge', 'demoted to worker (another queen holds the lease); engines stopped');
      }
    });
    // Every tab registers job handlers: a worker serves them now; a queen may be demoted later
    // (sleep/wake revival) and must be able to serve them then.
    tabBridge.onJob('echo', function (args) { return Promise.resolve(args == null ? null : args); });
    tabBridge.onJob('brain', function (p) {
      p = p || {};
      return callPage(String(p.kind || 'respond'), p.args || {}, p.timeoutMs || 40000);
    });
    tabBridge.start();
    setInterval(function () { tabBridge.tick(); }, 5000);   // host-driven time; the queen tab is the foreground tab
  } else {
    trace('bridge', 'no bus available (BroadcastChannel + GM listener both missing) \u2014 single-tab mode');
  }
  function spawnWorker() {
    var url = location.href.split('#')[0] + '#chloe-worker';
    try { GM_openInTab(url, { active: false, insert: true }); return { ok: true, value: { url: url } }; }
    catch (e) {
      try { window.open(url, '_blank'); return { ok: true, value: { url: url, via: 'window.open' } }; }
      catch (e2) { return { ok: false, reason: 'could not open a tab (popup blocked?)' }; }
    }
  }

  // ---- menu (fallback / token entry; token must be set in the trusted surface) --------
  function promptToken() {
    var t = prompt('Paste the BOT token (Developer Portal > Bot). Stored in this browser only.');
    if (t == null) return; t = t.trim(); cfgSet('token', t);
    var s = tokenShape(t); console.log('[chloe] token saved — shape:', s);
    if (s.placeholder || s.parts !== 3) console.log('[chloe] warning: does not look like a bot token (expect ~70+ chars, 3 dot-parts).');
  }
  function resetState(silent) {
    if (!silent && !confirm('Reset state (cursor, roster, ring) for ALL channels? Token is NOT touched.')) return Promise.resolve();
    var chain = Promise.resolve();
    channelList().forEach(function (ch) {
      var pfx = prefixFor(ch), st = makeStore(pfx);
      chain = chain.then(function () {
        return st.listIndex().then(function (ids) {
          (ids || []).forEach(function (id) { GM_deleteValue(NS + pfx + 'u:' + id); });
          ['cursor:' + ch, 'roster:index', 'speaker:ring:' + ch, 'rhythm:' + ch, 'modlog', 'backfill:' + ch].forEach(function (k) { GM_deleteValue(NS + pfx + k); });
          GM_deleteValue(NS + 'cfg:backfillDone:' + ch);
        });
      });
    });
    return chain.then(function () { eachEngine(function (e) { e.stop(); }); engines = {}; lastPoll = null; console.log('[chloe] state reset for all channels.'); });
  }
  GM_registerMenuCommand('Set bot token', promptToken);
  GM_registerMenuCommand('Reset T0 state (keeps token)', function () { resetState(false); });

  console.log('[chloe-bridge ' + VERSION + '] loaded as ' + TAB_ROLE + '. token set:', hasToken(),
    '| channel set:', !!cfgGet('channelId', ''), '\n  Open your Chloe control generator on this same perchance.org tab to drive it.');
})();
