// ===================================================================================
// chloe wiring — engine + control link + GM adapters (SHIPPED IN THE ENGINE BUNDLE).
// Runs inside the shell userscript scope (GM_* globals visible). Installed by the
// shell via __installEngine; Shell = { LINKWIN, tabRole, engineVersion }.
// This file is the old bridge body with only the seam changed: IIFE -> __chloeWire,
// top-frame guard + LINKWIN + TAB_ROLE now come from the shell.
// ===================================================================================
function __chloeWire(Shell) {
  'use strict';
  var LINKWIN = Shell.LINKWIN;
  var TAB_ROLE = Shell.tabRole;
  var NS = 'chloe:';
  var VERSION = Shell.engineVersion;
  var API = 'https://discord.com/api/v10';
  var UA = 'DiscordBot (https://github.com/therealwestninja, 1.0)';
  var tickTimer = null, helloTimer = null;
  var workerSelfHealTried = false;   // one-shot: a worker-roled tab that turns out to host the panel reclaims queen

  function cfgGet(k, d) { var v = GM_getValue(NS + 'cfg:' + k, null); return v == null ? d : v; }
  // Arbitrary semantic-injection store (DESIGN-semantic-inject.md): a map of id -> {id,text,priority,ttlMs,at}.
  function semInjectMap() { var m = GM_getValue(NS + 'seminject:map', null); return (m && typeof m === 'object') ? m : {}; }
  function semInjectList() { var m = semInjectMap(); return Object.keys(m).map(function (k) { return m[k]; }); }
  function semInjectUpsert(entry) { var m = semInjectMap(); m[entry.id] = entry; GM_setValue(NS + 'seminject:map', m); }
  function semInjectDrop(id) { var m = semInjectMap(); if (m[id]) { delete m[id]; GM_setValue(NS + 'seminject:map', m); } }
  function cfgSet(k, v) { GM_setValue(NS + 'cfg:' + k, v); }
  // #17: a small in-memory ring of link/transport/poll events, readable after the fact (the link's
  // failure modes are timing-dependent and easy to miss live). Mirrors to console; capped at 60.
  var traceRing = [], TRACE_MAX = 60;
  function trace(tag, msg) {
    var e = { t: Date.now(), tag: tag, msg: String(msg) };
    traceRing.push(e); if (traceRing.length > TRACE_MAX) traceRing = traceRing.slice(-TRACE_MAX);
    return e;
  }
  // Error ring (v0.90.11): failures ALSO land here (50 slots) so diag.errors can show them
  // without the noise of the 60-slot trace ring. Engine error-tier logs arrive via the log
  // wrapper in buildEngine; userscript failures call traceErr directly; hot paths use warnOnce.
  var errRing = [], ERR_MAX = 50;
  function traceErr(tag, msg) {
    var e = { t: Date.now(), tag: tag, msg: String(msg).slice(0, 500) };
    traceRing.push(e); if (traceRing.length > TRACE_MAX) traceRing = traceRing.slice(-TRACE_MAX);
    errRing.push(e); if (errRing.length > ERR_MAX) errRing = errRing.slice(-ERR_MAX);
    return e;
  }
  var warnedKeys7065 = {};
  function warnOnce(key, tag, msg) {
    if (warnedKeys7065[key]) return null;
    warnedKeys7065[key] = true; return traceErr(tag, msg);
  }
  // Diagnostics hygiene: a diag dump may be pasted into a public GitHub issue, so strip PII that is NOT needed to
  // debug the bot — IP addresses, emails, and the user/locale/country/region fields Discord error bodies can carry.
  // Error CODES are deliberately KEPT (see errBrief) — they are what you need, and carry no personal data.
  function scrubPII(s) {
    var t = String(s == null ? '' : s);
    t = t.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');                                          // IPv4
    t = t.replace(/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, '[ip6]');                            // IPv6 (>=4 groups: never a clock/snowflake)
    t = t.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[email]');                             // email
    t = t.replace(/("(?:locale|country|region|email|phone|ip|real_name|username_global)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"');  // known PII JSON fields in an embedded body
    return t;
  }
  // A compact, PII-FREE rendering of a Discord error body for diagnostics: keep the error CODE + short message (what
  // surfaces the problem), drop everything else (user objects, field-level `errors` that can carry names/locale/etc.).
  function errBrief(body) {
    if (!body || typeof body !== 'object') return '';
    var parts = [];
    if (body.code != null) parts.push('code=' + body.code);
    if (body.message) parts.push('msg="' + scrubPII(String(body.message)).slice(0, 200) + '"');
    if (body.retry_after != null) parts.push('retry_after=' + body.retry_after);
    return parts.length ? '{' + parts.join(' ') + '}' : '';
  }
  // Bootstrap log: console.log + pushEvent so messages appear in both the browser console
  // and the panel activity feed. Use for anything a mod operator needs to see at a glance.
  function bLog(msg) { console.log(msg); pushEvent('log', msg); }
  function tokenShape(t) {
    return { len: t ? t.length : 0, parts: t ? t.split('.').length : 0,
             ws: /\s/.test(t || ''), placeholder: !t || t.indexOf('PASTE_') === 0 };
  }
  function hasToken() { return !tokenShape(cfgGet('token', '')).placeholder; }

  // ---- GM store adapter (KV + maintained roster index) --------------------------------
  // D3: per-channel namespacing. The PRIMARY channel keeps the legacy un-prefixed namespace so an
  // existing install keeps its memory; every additional channel lives under 'ch:{id}:'.
  function makeStore(pfx) {
    var INDEX_GM_KEY = NS + pfx + 'roster:index';
    function readIndex() { var v = GM_getValue(INDEX_GM_KEY, null); if (!v) return []; try { var pa = JSON.parse(v) || []; return Array.isArray(pa) ? pa : []; } catch (e) { warnOnce('store:roster-index:' + pfx, 'store', 'roster index is corrupt, starting empty (' + ((e && e.message) || e) + ')'); return []; } }
    var s = {
      get: function (k) { return Promise.resolve().then(function () { var v = GM_getValue(NS + pfx + k, null); if (v == null) return null; try { return JSON.parse(v); } catch (e) { warnOnce('store:get:' + pfx + ':' + k, 'store', 'stored key is corrupt, treating as missing (' + ((e && e.message) || e) + ')'); return null; } }); },
      set: function (k, v) { GM_setValue(NS + pfx + k, JSON.stringify(v)); return Promise.resolve(true); },
      del: function (k) { GM_deleteValue(NS + pfx + k); return Promise.resolve(true); },
      listIndex: function () { return Promise.resolve(readIndex()); },
      // setIndex: UNION write — merges the supplied array with whatever is currently in GM so
      // concurrent ensureIndexed/addToIndex calls from other paths are never clobbered.
      setIndex: function (arr) {
        var cur = readIndex(); var merged = cur.slice(); var set = {};
        cur.forEach(function (id) { set[id] = true; });
        (arr || []).forEach(function (id) { if (id && !set[id]) { set[id] = true; merged.push(id); } });
        GM_setValue(INDEX_GM_KEY, JSON.stringify(merged)); return Promise.resolve(true);
      },
      // addToIndex: targeted add — only appends if not present; safe to call concurrently.
      addToIndex: function (id) {
        if (!id) return Promise.resolve();
        var cur = readIndex();
        if (cur.indexOf(id) >= 0) return Promise.resolve();
        cur.push(id); GM_setValue(INDEX_GM_KEY, JSON.stringify(cur)); return Promise.resolve(true);
      },
      // removeFromIndex: targeted remove — reads live value at call time, drops only the one id.
      removeFromIndex: function (id) {
        if (!id) return Promise.resolve();
        var cur = readIndex(); var next = cur.filter(function (x) { return x !== id; });
        if (next.length === cur.length) return Promise.resolve();   // wasn't there
        GM_setValue(INDEX_GM_KEY, JSON.stringify(next)); return Promise.resolve(true);
      }
    };
    return s;
  }
  var store = makeStore('');
  function primaryChannel() { return String(cfgGet('channelId', '') || '').trim(); }
  // DM sessions: once Chloe opens a DM channel (she gets the channel id back), that channel is
  // pollable like any other — Discord lets a bot read messages in a DM it's part of. We can't
  // DISCOVER a cold inbound DM (no Gateway), but any DM Chloe opens becomes two-way. Stored as
  // { dmChannelId: { user, name, openedAt } }.
  function dmSessions() { return cfgGet('dmSessions', {}) || {}; }
  function dmChannelIds() { return Object.keys(dmSessions()); }
  // Operator-DECLARED DM channels (the "private DMs" box). Discord's REST API gives us no per-message
  // signal of whether a channel is a DM, and with no Gateway we can't discover a cold inbound DM — so
  // the reliable answer is to let the operator list DM channel ids explicitly. A declared DM is polled
  // like any channel AND flagged isDM, which is what lets the public->DM memory merge actually run.
  function declaredDmChannels() { return (cfgGet('dmChannels', []) || []).map(function (c) { return String(c || '').trim(); }).filter(Boolean); }
  function isDMChannel(chId) { return declaredDmChannels().indexOf(chId) >= 0 || !!dmSessions()[chId]; }
  function recordDMSession(dmChannelId, userId, name) {
    if (!dmChannelId || !userId) return;
    var s = dmSessions();
    if (!s[dmChannelId]) { s[dmChannelId] = { user: String(userId), name: name || '', openedAt: Date.now() }; cfgSet('dmSessions', s); }
  }
  function channelList() {
    var seen = {}, out = [];
    // public primary + public extras + declared DMs (always polled — they're explicit) + session DMs (if enabled)
    [primaryChannel()].concat(cfgGet('channels', []) || []).concat(declaredDmChannels()).concat(cfgGet('dmReplies', true) ? dmChannelIds() : []).forEach(function (c) {
      c = String(c || '').trim();
      if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    return out;
  }
  function prefixFor(chId) { return chId === primaryChannel() ? '' : ('ch:' + chId + ':'); }
  function chKeyOf(args) { var c = String((args && args.channelId) || '').trim(); var list = channelList(); return (c && list.indexOf(c) >= 0) ? c : (list[0] || ''); }
  // Per-channel speak/read/remember gates (goldfish model): cfg key 'chanGate:<id>' holds ONLY
  // disabled gates, e.g. {speak:false}. Absent key/field = ON. Queen-side resolution; engines get
  // snapshots (chanSpeak/chanRead/chanRemember) at build + targeted updateConfig on change.
  function chanGate(chId, gate) { var g = cfgGet('chanGate:' + chId, null); if (!g || typeof g !== 'object') return true; return g[gate] !== false; }
  function chanGatesFor(chId) { return { speak: chanGate(chId, 'speak'), read: chanGate(chId, 'read'), remember: chanGate(chId, 'remember') }; }
  // A1: held autonomous actions per channel (bundle v12+), read defensively.
  function pendingActFor(ch) {
    var list = null;
    try {
      var pfx = prefixFor(ch);
      var v = GM_getValue(NS + pfx + 'pendingact:' + ch, null);
      if (Array.isArray(v)) list = v.filter(function (e) { return e && typeof e.id === 'string' && typeof e.class === 'string'; }).slice(0, 20);
    } catch (e) {}
    return list || [];
  }
  // A5: decision journal per channel (bundle v13+), read defensively.
  function actLogFor(ch) {
    var list = null;
    try {
      var pfx = prefixFor(ch);
      var v = GM_getValue(NS + pfx + 'actlog:' + ch, null);
      if (Array.isArray(v)) list = v.filter(function (e) { return e && typeof e.at === 'number' && typeof e.class === 'string' && typeof e.verdict === 'string'; }).slice(-30);
    } catch (e) {}
    return list || [];
  }
  // A6: undo stack top per channel (bundle v14+) — sync GM read like the act keys above
  // (the status builder is sync; old engines simply have no key).
  function undoTopFor(ch) {
    var list = null;
    try {
      var pfx = prefixFor(ch);
      var v = GM_getValue(NS + pfx + 'undostack:' + ch, null);
      if (Array.isArray(v)) list = v.filter(function (e) { return e && typeof e.at === 'number' && typeof e.summary === 'string' && e.summary; }).slice(-10);
    } catch (eU) {}
    if (!list || !list.length) return null;
    var top = list[list.length - 1];
    return { summary: top.summary, at: top.at };
  }
  // A7: mod-list validator (mirrors the import firewall at sanitizeImport — a planted
  // non-array/string modList makes isMod do substring matching = privilege escalation).
  function cleanModListIds(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(function (x) { return typeof x === 'string' && !!x; }).slice(0, 200);
  }
  // Games status per channel (bundle v9+): active game + today's wordle table,
  // read defensively straight from GM (the engine owns the shapes; old engines
  // simply have no keys, and validateIndex/validateState rebuild garbage).
  function gameStatusFor(ch) {
    var idx = null, st = null;
    try { idx = GM_getValue(NS + 'games:' + ch, null); } catch (eG) {}
    try { st = GM_getValue(NS + 'wordle:' + ch, null); } catch (eS) {}
    try {
      if (typeof ChloeWordle !== 'undefined' && ChloeWordle && ChloeWordle.statusFor) return ChloeWordle.statusFor(idx, st);
    } catch (eD) {}
    return { active: null, day: null, players: 0, solved: 0, finished: false, hard: false };
  }
  var speakGateLastLog = 0;
  function gateSpeak(chId, kind, fn) {
    return function () {
      if (!chanGate(chId, 'speak')) {
        var now = Date.now();
        if (now - speakGateLastLog > 300000) { speakGateLastLog = now; console.log('[chloe] channel ' + chId + ': speak gate is off — dropped ' + kind); }
        return Promise.resolve({ id: null, gated: true });
      }
      return fn.apply(null, arguments);
    };
  }
  // Goldfish store: drops every write except the operational keys (cursor must advance or she
  // re-reads forever; run-lock + pending-reply keep the queen handover safe). Reads pass through,
  // so each poll sees a fresh, unremembered room.
  function gateStore(st, chId) {
    if (chanGate(chId, 'remember')) return st;
    var allow = {};
    allow['cursor:' + chId] = 1; allow['runlock:' + chId] = 1; allow['pending-reply:' + chId] = 1;
    var noopW = function () { return Promise.resolve(true); };
    return {
      get: function (k) { return st.get(k); },
      listIndex: function () { return st.listIndex(); },
      set: function (k, v) { if (allow[k]) return st.set(k, v); return Promise.resolve(true); },
      del: function (k) { if (allow[k]) return st.del(k); return Promise.resolve(true); },
      setIndex: noopW, addToIndex: noopW, removeFromIndex: noopW
    };
  }

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
        timeout: (opts && opts.timeoutMs) || 25000,
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
      if (r.status < 200 || r.status >= 300) { trace('http', 'HTTP ' + r.status + ' on ' + method + ' ' + path); var err = new Error('HTTP ' + r.status + (body ? ' ' + errBrief(body) : '')); err.status = r.status; err.body = body; throw err; }   // err.message surfaces the status + Discord error CODE (errBrief), NOT the full body (which can carry user PII); err.body kept object-only for internal code-reads
      return body;
    });
  }
  // ---- output gates (mod-toggleable) ---------------------------------------------------
  // What Chloe is allowed to put in an outgoing message. PINGS use Discord's own input-sanitation
  // (the allowed_mentions object — the platform itself decides what resolves to a real ping);
  // EMOJI / LINKS / CHANNEL-LINKS have no such API for your own messages, so Chloe scrubs them
  // from her content before posting. Each gate is independently mod-toggleable. Safe defaults:
  // emoji on (harmless, expressive); pings / @everyone / links / channel-links off.
  function gate(k, d) { return !!cfgGet('gate:' + k, d); }
  function allowedMentions() {
    var parse = [];
    if (gate('pings', false)) { parse.push('users'); parse.push('roles'); }
    if (gate('everyone', false)) parse.push('everyone');
    return { parse: parse };   // parse:[] = Discord resolves NO mentions to real pings
  }
  function gateContent(text) {
    var t = String(text || '');
    if (!gate('emoji', true)) t = t.replace(/<a?:\w+:\d+>/g, '');           // custom/animated emoji
    if (!gate('channelLinks', false)) t = t.replace(/<#\d+>/g, '');          // channel mentions
    if (!gate('links', false)) t = t.replace(/https?:\/\/\S+/gi, '');        // URLs (also kills auto-embeds)
    return t.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?])/g, '$1').trim(); // tidy, preserve newlines
  }

  // ---- translation client (DESIGN-translate.md) ----------------------------------------------
  // Free/unofficial endpoint. NO key. CARDINAL RULE: failure is a NON-EVENT \u2014 on any error/timeout/
  // parse-failure we return the ORIGINAL text, so a message is never dropped or blocked. Mentions and
  // custom emoji are protected (pulled out, prose translated, reassembled) so a translated reply still
  // pings/renders. A bounded LRU cache avoids re-hitting the endpoint for repeated lines.
  var TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';
  var translateCache = new Map();           // key "src|tgt|text" -> { text, src } ; bounded below
  var TRANSLATE_CACHE_MAX = 300;
  function cacheGet(k) { return translateCache.has(k) ? translateCache.get(k) : null; }
  function cachePut(k, v) { translateCache.set(k, v); if (translateCache.size > TRANSLATE_CACHE_MAX) { var first = translateCache.keys().next().value; translateCache.delete(first); } }
  // Protect <@123> / <@!123> / <#123> / <@&123> mentions and <a:emoji:123> / :emoji: tokens by swapping
  // them for inert placeholders the translator won't touch, then restoring them after.
  function protectTokens(text) {
    var tokens = [], i = 0;
    var protectedText = String(text).replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|:[a-z0-9_]+:/gi, function (m) {
      var ph = '\uE000' + (i++) + '\uE001';   // private-use sentinels, unlikely to be altered
      tokens.push(m); return ph;
    });
    return { text: protectedText, restore: function (out) {
      return String(out).replace(/\uE000(\d+)\uE001/g, function (_, n) { return tokens[+n] != null ? tokens[+n] : ''; });
    } };
  }
  function parseTranslateResponse(responseText) {
    // shape: [ [ [translatedSeg, origSeg, ...], ... ], ..., detectedSourceLang(maybe) ]
    var data = JSON.parse(responseText);
    var out = '';
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (var i = 0; i < data[0].length; i++) { if (data[0][i] && data[0][i][0] != null) out += data[0][i][0]; }
    }
    var src = null;
    if (data && data[2]) src = data[2];                       // common slot for detected source
    else if (data && data[8] && data[8][0] && data[8][0][0]) src = data[8][0][0];
    return { text: out, src: src };
  }
  // translate(text, target, source?) -> Promise<{text, src}>. ALWAYS resolves; never rejects.
  function translate(text, target, source) {
    var input = String(text == null ? '' : text);
    if (!input.trim() || !target) return Promise.resolve({ text: input, src: source || null });
    var src = source || 'auto';
    var key = src + '|' + target + '|' + input;
    var hit = cacheGet(key); if (hit) return Promise.resolve(hit);
    var prot = protectTokens(input);
    var url = TRANSLATE_URL + '?client=gtx&sl=' + encodeURIComponent(src) + '&tl=' + encodeURIComponent(target) + '&dt=t&q=' + encodeURIComponent(prot.text);
    return new Promise(function (resolve) {
      var settled = false;
      function done(val) { if (settled) return; settled = true; resolve(val); }
      var to = setTimeout(function () { trace('translate', 'timeout -> original text'); done({ text: input, src: src }); }, 6000);
      try {
        GM_xmlhttpRequest({ method: 'GET', url: url, headers: { 'User-Agent': UA }, anonymous: true,
          onload: function (r) {
            clearTimeout(to);
            try {
              if (r.status < 200 || r.status >= 300) { trace('translate', 'HTTP ' + r.status + ' -> original'); return done({ text: input, src: src }); }
              var parsed = parseTranslateResponse(r.responseText);
              var restored = prot.restore(parsed.text) || input;
              var val = { text: restored, src: parsed.src || src };
              cachePut(key, val); done(val);
            } catch (e) { trace('translate', 'parse failed -> original'); done({ text: input, src: src }); }
          },
          onerror: function () { clearTimeout(to); trace('translate', 'error -> original'); done({ text: input, src: src }); },
          ontimeout: function () { clearTimeout(to); trace('translate', 'timeout -> original'); done({ text: input, src: src }); } });
      } catch (e) { clearTimeout(to); done({ text: input, src: src }); }
    });
  }

  // ---- web search client (model tool-loop, item 2: the QUERY tool) --------------------------
  // A privacy-friendly lookup: DuckDuckGo's instant-answer API (no key, no tracking cookie — anonymous).
  // Returns a SHORT results string (AbstractText + a few RelatedTopics), capped. CARDINAL RULE (like
  // translate): failure is a NON-EVENT — any network/parse/timeout error resolves { ok:false, reason }
  // so the ReAct loop can fail-open and post the original reply. The results are EXTERNAL UNTRUSTED
  // CONTENT — the PAGE frames them strictly as retrieved DATA (never instructions) when it feeds them back.
  var SEARCH_URL = 'https://api.duckduckgo.com/';
  function summariseDDG(data) {
    try {
      var parts = [];
      if (data && data.AbstractText) parts.push(String(data.Heading ? data.Heading + ': ' : '') + String(data.AbstractText));
      var rel = (data && Array.isArray(data.RelatedTopics)) ? data.RelatedTopics : [];
      for (var i = 0; i < rel.length && parts.length < 4; i++) {
        var t = rel[i];
        if (t && t.Text) parts.push(String(t.Text));
        else if (t && Array.isArray(t.Topics) && t.Topics[0] && t.Topics[0].Text) parts.push(String(t.Topics[0].Text));
      }
      var cleaned = parts.filter(Boolean).map(function (s) { return s.replace(/\s+/g, ' ').trim().slice(0, 240); });
      var out = cleaned.length ? ('- ' + cleaned.join('\n- ')) : '';
      return out.slice(0, 900);
    } catch (e) { return ''; }
  }
  // Wikipedia fallback (rook-ai pattern, no key): opensearch for titles, then the
  // REST summary for the top hit. Used when DDG instant answers come back empty —
  // DDG covers entities, Wikipedia covers everything else. Returns labeled text
  // WITH the article URL so the model can follow up with a fetch for detail.
  function wikiSearch(query) {
    var q = String(query == null ? '' : query).trim().slice(0, 300);
    if (!q) return Promise.resolve({ ok: false, reason: 'empty query' });
    function wget(url, ms) {
      return new Promise(function (resolve) {
        var settled = false;
        function wdone(v) { if (settled) return; settled = true; resolve(v); }
        var wto = setTimeout(function () { wdone({ ok: false }); }, ms || 8000);
        try {
          GM_xmlhttpRequest({ method: 'GET', url: url, headers: { 'User-Agent': UA }, anonymous: true,
            onload: function (r) { clearTimeout(wto); try { if (r.status < 200 || r.status >= 300) return wdone({ ok: false }); wdone({ ok: true, text: r.responseText }); } catch (e) { wdone({ ok: false }); } },
            onerror: function () { clearTimeout(wto); wdone({ ok: false }); },
            ontimeout: function () { clearTimeout(wto); wdone({ ok: false }); } });
        } catch (e) { clearTimeout(wto); wdone({ ok: false }); }
      });
    }
    var op = 'https://en.wikipedia.org/w/api.php?action=opensearch&search=' + encodeURIComponent(q) + '&limit=3&format=json&origin=*';
    return wget(op).then(function (r) {
      var titles = null;
      try { var j = JSON.parse(r && r.ok ? r.text : 'null'); if (j && Array.isArray(j[1])) titles = j[1]; } catch (e) {}
      if (!titles || !titles.length) return { ok: false, reason: 'no results' };
      var title = String(titles[0]);
      var sum = 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_'));
      return wget(sum).then(function (s) {
        try {
          var d = JSON.parse(s && s.ok ? s.text : 'null');
          var ext = d && d.extract ? String(d.extract).replace(/\s+/g, ' ').trim().slice(0, 700) : '';
          var url = (d && d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page) || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')));
          if (!ext) return { ok: false, reason: 'no results' };
          return { ok: true, value: '- ' + title + ': ' + ext + '\n(source: ' + url + ')' };
        } catch (e) { return { ok: false, reason: 'parse failed' }; }
      });
    });
  }
  // rollDice(spec) -> { ok, total, rolls, detail } | { ok:false, reason }. PURE (headless-testable).
  function rollDice(spec) {
    var m = String(spec == null ? '' : spec).trim().match(/^(\d{1,3})?d(\d{1,4})([+-]\d{1,5})?$/i);
    if (!m) return { ok: false, reason: 'roll dice like 2d6+3, d20, or 4d8' };
    var n = Math.min(100, Math.max(1, parseInt(m[1] || '1', 10)));
    var sides = Math.min(1000, Math.max(2, parseInt(m[2], 10)));
    var mod = m[3] ? parseInt(m[3], 10) : 0;
    var rolls = [], total = 0;
    for (var k = 0; k < n; k++) { var r = 1 + Math.floor(Math.random() * sides); rolls.push(r); total += r; }
    total += mod;
    var mtxt = mod ? (mod > 0 ? '+' + mod : '' + mod) : '';
    var detail = n <= 12 ? (' [' + rolls.join('+') + ']' + mtxt) : ' (' + n + 'd' + sides + mtxt + ')';
    return { ok: true, total: total, rolls: rolls, detail: detail };
  }
  // ---- almanac (rook-ai/book-maker pattern, all free no-key GET APIs) ----
  // One QUERY transport behind the `almanac` tool verb: { kind, query, extra }.
  // kinds: define | synonym | rhyme | soundslike | country | onthisday | quote | weather | translate.
  function almanacGet(url, ms) {
    return new Promise(function (resolve) {
      var settled = false;
      function adone(v) { if (settled) return; settled = true; resolve(v); }
      var ato = setTimeout(function () { adone({ ok: false }); }, ms || 8000);
      try {
        GM_xmlhttpRequest({ method: 'GET', url: url, headers: { 'User-Agent': UA }, anonymous: true,
          onload: function (r) { clearTimeout(ato); try { if (r.status < 200 || r.status >= 300) return adone({ ok: false }); adone({ ok: true, text: r.responseText }); } catch (e) { adone({ ok: false }); } },
          onerror: function () { clearTimeout(ato); adone({ ok: false }); },
          ontimeout: function () { clearTimeout(ato); adone({ ok: false }); } });
      } catch (e) { clearTimeout(ato); adone({ ok: false }); }
    });
  }
  function almanacJson(url, ms) {
    return almanacGet(url, ms).then(function (r) { if (!r.ok) return null; try { return JSON.parse(r.text); } catch (e) { return null; } });
  }
  var WMO = { 0: 'clear', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'rime fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 80: 'rain showers', 95: 'thunderstorm', 96: 'thunderstorm with hail' };
  function almanacLookup(job) {
    var kind = String(job && job.kind || '').toLowerCase().trim();
    var q = String(job && job.query || '').trim().slice(0, 200);
    var extra = String(job && job.extra || '').trim().slice(0, 80);
    function aNo(r) { return { ok: false, reason: 'no ' + kind + ' result' + (r ? ' (' + r + ')' : '') }; }
    function aOk(v) { return { ok: true, value: v }; }
    if (!q && kind !== 'onthisday' && kind !== 'quote') return Promise.resolve(aNo('empty query'));
    if (kind === 'define') {
      var w = q.toLowerCase().replace(/[^a-z'-]/g, '');
      if (!w) return Promise.resolve(aNo('empty word'));
      return almanacJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w)).then(function (j) {
        var e = Array.isArray(j) && j[0];
        if (!e) return aNo();
        var defs = [];
        (e.meanings || []).slice(0, 2).forEach(function (m) { var d = m.definitions && m.definitions[0]; if (d && d.definition) defs.push((m.partOfSpeech ? '(' + m.partOfSpeech + ') ' : '') + d.definition); });
        if (!defs.length) return aNo();
        return aOk('Define - ' + (e.word || w) + (e.phonetic ? ' ' + e.phonetic : '') + ': ' + defs.join(' | ').slice(0, 600));
      });
    }
    if (kind === 'synonym' || kind === 'rhyme' || kind === 'soundslike') {
      var p = kind === 'rhyme' ? 'rel_rhy' : kind === 'soundslike' ? 'sl' : 'ml';
      return almanacJson('https://api.datamuse.com/words?max=14&' + p + '=' + encodeURIComponent(q)).then(function (j) {
        if (!Array.isArray(j) || !j.length) return aNo();
        var lbl = kind === 'rhyme' ? 'rhyme with' : kind === 'soundslike' ? 'sound like' : 'mean like';
        return aOk('Words that ' + lbl + ' "' + q.slice(0, 60) + '": ' + j.map(function (x) { return x.word; }).filter(Boolean).slice(0, 12).join(', '));
      });
    }
    if (kind === 'country') {
      return almanacJson('https://restcountries.com/v3.1/name/' + encodeURIComponent(q) + '?fields=name,capital,currencies,languages,region,subregion').then(function (j) {
        var c = Array.isArray(j) && j[0];
        if (!c) return aNo();
        var langs = c.languages ? Object.keys(c.languages).map(function (k) { return c.languages[k]; }).join(', ') : '';
        var curr = c.currencies ? Object.keys(c.currencies).map(function (k) { return c.currencies[k].name; }).join(', ') : '';
        return aOk('Country - ' + ((c.name && c.name.common) || q) + ': ' + (c.subregion || c.region || '') + (c.capital ? ', capital ' + c.capital[0] : '') + (langs ? ', language ' + langs : '') + (curr ? ', currency ' + curr : '') + '.');
      });
    }
    if (kind === 'onthisday') {
      var mm = '', dd = '';
      var dm = q.match(/(\d{1,2})\D(\d{1,2})/);
      if (dm) { mm = dm[1]; dd = dm[2]; }
      else { var nowD = new Date(); mm = String(nowD.getMonth() + 1); dd = String(nowD.getDate()); }
      return almanacJson('https://byabbe.se/on-this-day/' + mm + '/' + dd + '/events.json').then(function (j) {
        var ev = j && j.events;
        if (!ev || !ev.length) return aNo();
        return aOk('On this day (' + mm + '/' + dd + '): ' + ev.slice(0, 3).map(function (e) { return e.year + ': ' + e.description; }).join(' | ').slice(0, 600));
      });
    }
    if (kind === 'quote') {
      var qu = (!q || /random/i.test(q)) ? 'https://api.quotable.io/quotes/random?limit=1' : 'https://api.quotable.io/search/quotes?limit=3&query=' + encodeURIComponent(q);
      return almanacJson(qu).then(function (j) {
        var arr = (j && j.results) || j;
        if (!Array.isArray(arr) || !arr.length || !arr[0] || !arr[0].content) return aNo();
        return aOk('Quote - "' + String(arr[0].content).slice(0, 400) + '" - ' + (arr[0].author || 'Unknown'));
      });
    }
    if (kind === 'weather') {
      return almanacJson('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(q)).then(function (g) {
        var r = g && g.results && g.results[0];
        if (!r) return aNo('place not found');
        return almanacJson('https://api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code,wind_speed_10m&latitude=' + encodeURIComponent(r.latitude) + '&longitude=' + encodeURIComponent(r.longitude)).then(function (f) {
          var c = f && f.current;
          if (!c) return aNo();
          return aOk('Weather - ' + r.name + (r.country ? ', ' + r.country : '') + ': ' + Math.round(c.temperature_2m) + ' C, ' + (WMO[c.weather_code] || '') + ', wind ' + Math.round(c.wind_speed_10m) + ' km/h.');
        });
      });
    }
    if (kind === 'translate') {
      var target = (extra || 'en').replace(/[^a-z-]/gi, '').slice(0, 10) || 'en';
      return translate(q, target).then(function (res) {
        if (!res || !res.text) return aNo();
        return aOk('Translation - "' + q.slice(0, 120) + '" = "' + String(res.text).slice(0, 300) + '"');
      });
    }
    return Promise.resolve({ ok: false, reason: 'unknown lookup kind "' + kind + '" (define/synonym/rhyme/soundslike/country/onthisday/quote/weather/translate)' });
  }
  // webSearch(query) -> Promise<{ ok:true, value } | { ok:false, reason }>. ALWAYS resolves; never rejects.
  // DDG instant answers first (fast, entity-shaped), Wikipedia fallback (broad coverage, with source
  // URL for fetch follow-ups). Failure is a NON-EVENT for the reply path (fail-open, logged).
  function webSearch(query) {
    var q = String(query == null ? '' : query).trim().slice(0, 300);
    if (!q) return Promise.resolve({ ok: false, reason: 'empty query' });
    var url = SEARCH_URL + '?q=' + encodeURIComponent(q) + '&format=json&no_html=1&skip_disambig=1';
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      function ddgFallback(reason) {
        wikiSearch(q).then(function (w) {
          if (w && w.ok) { log('[wire:search] wiki fallback ok "' + q.slice(0, 60) + '"'); done({ ok: true, value: w.value }); }
          else { log('[wire:search] no results for "' + q.slice(0, 60) + '" (' + reason + ')'); done({ ok: false, reason: 'no results' }); }
        }, function () { log('[wire:search] no results for "' + q.slice(0, 60) + '" (' + reason + ')'); done({ ok: false, reason: 'no results' }); });
      }
      var to = setTimeout(function () { log('[wire:search] DDG timeout, trying wiki'); ddgFallback('timeout'); }, 8000);
      try {
        GM_xmlhttpRequest({ method: 'GET', url: url, headers: { 'User-Agent': UA }, anonymous: true,
          onload: function (r) {
            clearTimeout(to);
            try {
              if (r.status < 200 || r.status >= 300) { log('[wire:search] HTTP ' + r.status + ', trying wiki'); return ddgFallback('HTTP ' + r.status); }
              var data = JSON.parse(r.responseText);
              var val = summariseDDG(data);
              if (!val) { log('[wire:search] DDG empty, trying wiki'); return ddgFallback('empty'); }
              log('[wire:search] ok "' + q.slice(0, 60) + '" -> ' + val.length + ' chars');
              done({ ok: true, value: val });
            } catch (e) { console.error('[wire:search] parse error', e); log('[wire:search] parse failed, trying wiki'); ddgFallback('parse failed'); }
          },
          onerror: function () { clearTimeout(to); console.error('[wire:search] network error'); log('[wire:search] network error, trying wiki'); ddgFallback('network error'); },
          ontimeout: function () { clearTimeout(to); log('[wire:search] timeout, trying wiki'); ddgFallback('timeout'); } });
      } catch (e) { clearTimeout(to); console.error('[wire:search] threw', e); ddgFallback(String((e && e.message) || e)); }
    });
  }
  // htmlToText(html) -> plain text. PURE (headless-testable): strips scripts/styles/tags,
  // decodes the common entities, collapses whitespace. No DOM needed (the engine has none).
  function htmlToText(html) {
    var s = String(html == null ? '' : html);
    s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, ' ').replace(/<style[\s\S]*?<\/style\s*>/gi, ' ');
    s = s.replace(/<(br|p|div|h[1-6]|li|tr)\b[^>]*>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
    s = s.replace(/[ \t\xa0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
    return s.slice(0, 6000);
  }
  // Fetch-allowlist (v0.90.19): the model may read Wikipedia articles only. A tight
  // host list keeps prompt-injected URLs from becoming an open proxy / exfil channel.
  var FETCH_HOSTS = { 'en.wikipedia.org': 1, 'wikipedia.org': 1, 'www.wikipedia.org': 1 };
  // webFetch(url) -> Promise<{ ok:true, value:text } | { ok:false, reason }>. ALWAYS resolves.
  function webFetch(url) {
    var u = String(url == null ? '' : url).trim().slice(0, 500);
    var host = '';
    try { host = String(u.match(/^https?:\/\/([^\/:?#]+)/i)[1]).toLowerCase(); } catch (e) {}
    if (!/^https?:\/\//i.test(u) || !FETCH_HOSTS[host]) return Promise.resolve({ ok: false, reason: 'fetch allowlist is Wikipedia only' });
    return new Promise(function (resolve) {
      var settled = false;
      function fdone(v) { if (settled) return; settled = true; resolve(v); }
      var fto = setTimeout(function () { log('[wire:fetch] timeout -> fail-open'); fdone({ ok: false, reason: 'timeout' }); }, 10000);
      try {
        GM_xmlhttpRequest({ method: 'GET', url: u, headers: { 'User-Agent': UA }, anonymous: true,
          onload: function (r) {
            clearTimeout(fto);
            try {
              if (r.status < 200 || r.status >= 300) { log('[wire:fetch] HTTP ' + r.status + ' -> fail-open'); return fdone({ ok: false, reason: 'HTTP ' + r.status }); }
              var ftext = htmlToText(r.responseText);
              if (!ftext) { log('[wire:fetch] empty after strip -> fail-open'); return fdone({ ok: false, reason: 'empty page' }); }
              log('[wire:fetch] ok "' + u.slice(0, 60) + '" -> ' + ftext.length + ' chars');
              fdone({ ok: true, value: ftext });
            } catch (e) { console.error('[wire:fetch] parse error', e); log('[wire:fetch] strip failed -> fail-open'); fdone({ ok: false, reason: 'parse failed' }); }
          },
          onerror: function () { clearTimeout(fto); console.error('[wire:fetch] network error'); log('[wire:fetch] network error -> fail-open'); fdone({ ok: false, reason: 'network error' }); },
          ontimeout: function () { clearTimeout(fto); log('[wire:fetch] timeout -> fail-open'); fdone({ ok: false, reason: 'timeout' }); } });
      } catch (e) { clearTimeout(fto); console.error('[wire:fetch] threw', e); fdone({ ok: false, reason: String((e && e.message) || e) }); }
    });
  }
  // Translate inbound messages from a non-English-preference author into English for the engine. Only
  // touches messages whose author has a set lang != 'en'; everyone else passes through untouched and
  // free. Failure (per translate()) leaves the original text. Replaces content in place.
  function translateInbound(channelId, msgs) {
    if (!cfgGet('translate', true) || !Array.isArray(msgs) || !msgs.length) return Promise.resolve(msgs);
    var eng = engineFor(channelId);
    if (!eng || typeof eng.getUserLang !== 'function') return Promise.resolve(msgs);
    var chDef = cfgGet('channelLang:' + channelId, null);   // v0.90.21: read once per batch, not per message
    var langCache = {};
    function langOf(uid) { if (uid in langCache) return Promise.resolve(langCache[uid]); return Promise.resolve(eng.getUserLang(uid)).then(function (l) { langCache[uid] = l || chDef || null; return langCache[uid]; }); }
    var chain = Promise.resolve();
    msgs.forEach(function (m) {
      if (!m || !m.author || !m.content) return;
      chain = chain.then(function () {
        return langOf(m.author.id).then(function (lang) {
          if (!lang || lang === 'en') return;
          return translate(m.content, 'en', lang).then(function (res) { if (res && res.text) m.content = res.text; });
        });
      });
    });
    return chain.then(function () { return msgs; });
  }

  var transport = {
    getMe: function () { return requestJSON('GET', '/users/@me'); },
    getMessagesAfter: function (channelId, afterId, limit) {
      return requestJSON('GET', '/channels/' + channelId + '/messages?limit=' + (limit || 50) + (afterId ? '&after=' + afterId : ''))
        .then(function (msgs) { return translateInbound(channelId, msgs); });
    },
    getRecentMessages: function (channelId, limit) {
      return requestJSON('GET', '/channels/' + channelId + '/messages?limit=' + (limit || 30));   // newest window, no cursor — catches reactions added after a message scrolled past
    },
    sendMessage: function (channelId, text, opts) {
      var body = { content: gateContent(text).slice(0, 1900), allowed_mentions: allowedMentions() };
      if (opts && opts.replyTo) {
        // Native reply threading: visually attaches her answer to the message it answers.
        // fail_if_not_exists:false -> if the target was deleted, the send still goes through plain.
        body.message_reference = { message_id: String(opts.replyTo), fail_if_not_exists: false };
        body.allowed_mentions = Object.assign({}, body.allowed_mentions, { replied_user: false });   // never ping via the reply itself
      }
      return requestJSON('POST', '/channels/' + channelId + '/messages', { json: true, body: body });
    },
    getMessage: function (channelId, messageId) {
      return requestJSON('GET', '/channels/' + channelId + '/messages/' + messageId, {});
    },
    sendEmbed: function (channelId, embed) {
      // v0.58 gate parity: embed text gets the same scrub as plain content. Pings already can't
      // fire (allowed_mentions rides every send), but the link/channel-link/emoji gates only ran
      // on .content — an AI-written URL inside an embed description walked straight past them.
      var g = Object.assign({}, embed);
      if (g.title) g.title = gateContent(String(g.title)).slice(0, 256);
      if (g.description) g.description = gateContent(String(g.description)).slice(0, 4000);
      if (Array.isArray(g.fields)) g.fields = g.fields.map(function (f) { return Object.assign({}, f, { name: gateContent(String(f.name || '')).slice(0, 256), value: gateContent(String(f.value || '')).slice(0, 1024) }); });
      return requestJSON('POST', '/channels/' + channelId + '/messages', { json: true, body: { embeds: [g], allowed_mentions: allowedMentions() } });
    },
    addReaction: function (channelId, messageId, emoji) {
      return requestJSON('PUT', '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me', {});
    },
    removeReaction: function (channelId, messageId, emoji) {
      return requestJSON('DELETE', '/channels/' + channelId + '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji) + '/@me', {});
    },
    editMessage: function (channelId, messageId, text) {
      return requestJSON('PATCH', '/channels/' + channelId + '/messages/' + messageId, { json: true, body: { content: gateContent(text).slice(0, 1900), allowed_mentions: allowedMentions() } });
    },
    pinMessage: function (channelId, messageId) {
      return requestJSON('PUT', '/channels/' + channelId + '/pins/' + messageId, {});   // needs Manage Messages; 204 on success
    },
    startTyping: function (channelId) { return requestJSON('POST', '/channels/' + channelId + '/typing', { json: true, body: {} }); },
    getChannel: function (channelId) { return requestJSON('GET', '/channels/' + channelId, {}); },
    getGuildMemberCount: function (guildId) {
      return requestJSON('GET', '/guilds/' + guildId + '?with_counts=true').then(function (g) {
        return (g && (g.approximate_member_count || g.member_count)) || 0;
      });
    },
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
      fd.append('payload_json', JSON.stringify({ content: gateContent(caption).slice(0, 1900), allowed_mentions: allowedMentions() }));
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

  // ---- exact token counting (DESIGN-tokens.md) ------------------------------------------------
  // Lazy-load the SAME DeepSeek-R1 tokenizer Perchance's AI broker uses, so token budgets become exact
  // instead of a chars/4 guess. The engine's estimateTokens is SYNCHRONOUS (hot path), so we never
  // await in it: we load in the background and expose a synchronous countSync that returns null until
  // the model is ready, at which point the engine's existing cfg.countTokens hook starts using it.
  // PIN the transformers version (a long-running bot shouldn't silently pull a breaking tokenizer).
  // All failures are swallowed -> countSync stays null -> chars/4 fallback. The bot never breaks on this.
  var TOKENIZER_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2/+esm';
  var tokLoader = (function () {
    var tok = null, state = 'idle', promise = null, lastErr = null;
    function load() {
      if (promise) return promise;
      state = 'loading';
      promise = Promise.resolve().then(function () {
        // import() must run in the page realm (Perchance origin); LINKWIN is that window.
        var imp = (LINKWIN && LINKWIN.eval) ? LINKWIN.eval('(u)=>import(u)') : function (u) { return import(u); };
        return imp(TOKENIZER_CDN);
      }).then(function (mod) {
        return mod.AutoTokenizer.from_pretrained('deepseek-ai/DeepSeek-R1-0528');
      }).then(function (t) {
        tok = t; state = 'ready'; log('[chloe.tok] exact tokenizer ready'); return t;
      }).catch(function (err) {
        lastErr = err; state = 'fallback'; log('[chloe.tok] tokenizer load failed (' + ((err && err.message) || err) + ') \u2014 using chars/4'); return null;
      });
      return promise;
    }
    return {
      preload: function () { try { return load(); } catch (e) { state = 'fallback'; return Promise.resolve(null); } },
      countSync: function (str) { try { return tok ? tok.encode(String(str)).length : null; } catch (e) { return null; } },
      state: function () { return state; }
    };
  })();
  // The hook handed to every engine: exact when warm, null (-> chars/4) when cold/failed/off.
  function countTokensHook(str) {
    if (!cfgGet('exactTokens', true)) return null;   // off -> engine falls through to chars/4
    return tokLoader.countSync(str);
  }
  // Local embeddings (DESIGN-semantic) for semantic recall — the SAME transformers.js path the exact
  // tokenizer uses (imported into the page realm), so no extra plumbing. Loads a small bge model lazily
  // on first use; inference is async and batched. Every failure resolves to null so the engine falls
  // back to keyword overlap and never stalls. This is the one heavy download, gated behind semanticRecall.
  var embedLoader = (function () {
    var pipe = null, state = 'idle', promise = null;
    function load(model) {
      if (promise) return promise;
      state = 'loading';
      promise = Promise.resolve().then(function () {
        var imp = (LINKWIN && LINKWIN.eval) ? LINKWIN.eval('(u)=>import(u)') : function (u) { return import(u); };
        return imp(TOKENIZER_CDN);   // same pinned @huggingface/transformers build as the tokenizer
      }).then(function (mod) {
        return mod.pipeline('feature-extraction', model || 'Xenova/bge-small-en-v1.5');
      }).then(function (p) { pipe = p; state = 'ready'; log('[chloe.embed] local embedder ready'); return p; })
        .catch(function (err) { state = 'fallback'; log('[chloe.embed] embedder load failed (' + ((err && err.message) || err) + ') \u2014 keyword recall'); return null; });
      return promise;
    }
    return {
      preload: function (model) { try { return load(model); } catch (e) { state = 'fallback'; return Promise.resolve(null); } },
      embed: function (texts) {
        return load(cfgGet('embedModel', 'Xenova/bge-small-en-v1.5')).then(function (p) {
          if (!p) return null;
          return Promise.resolve(p(texts, { pooling: 'mean', normalize: true })).then(function (out) {
            try { return out.tolist(); } catch (e) { return null; }
          }, function () { return null; });
        }).catch(function () { return null; });
      },
      state: function () { return state; }
    };
  })();
  function embedHook(texts) {
    if (!cfgGet('semanticRecall', true)) return Promise.resolve(null);
    if (!texts || !texts.length) return Promise.resolve(null);
    return embedLoader.embed(texts);
  }
  // #15: a sandboxed frame can report origin 'null'; posting back to targetOrigin 'null' is dropped,
  // so fall back to '*' in that one case (responses are nonce-matched, so this stays safe).
  function replyTarget(o) { return (o && o !== 'null') ? o : '*'; }
  var callPending = new Map(); var callSeq = 0;
  // The shell (v1.x) only forwards kind:'req' to onPanelEvent, so brain-call answers
  // (kind:'callres') would never resolve a pending call — every reply the page computes
  // would end as a 'page timeout'. Listen for them here too: same origin gate, same
  // handler, and nonce-matching makes a future shell forward harmless (first match wins).
  try {
    LINKWIN.addEventListener('message', function (ev) {
      var d = null;
      try { d = ev.data; } catch (eD) { return; }
      if (!d || d.__chloe !== 1 || d.kind !== 'callres') return;
      try { onPanelEvent(ev); } catch (eC) {}
    });
  } catch (eL) { trace('link', 'callres listener failed (' + ((eL && eL.message) || eL) + ') — brain calls cannot resolve'); }
  var seenReqNonces = new Set();   // de-dupe fanned-out page requests so a config command applies once
  // v0.90.2: control-link observability + reply hardening (hang diagnosis).
  // lastCmd/At/Ms/Outcome always describe the last COMPLETED reply (never the in-flight
  // command itself, which made status report pending/null about itself); inflight tracks live.
  var linkStats = { lastCmd: null, lastAt: 0, lastMs: null, lastOutcome: null, counts: {}, inflight: null };
  function linkSnapshot() { var s = { lastCmd: linkStats.lastCmd, lastAt: linkStats.lastAt, lastMs: linkStats.lastMs, lastOutcome: linkStats.lastOutcome }; if (linkStats.inflight) s.inflight = linkStats.inflight; return s; }
  function linkTraceSlow(cmd, ms, outcome) { try { if (ms != null && ms > 10000) trace('link', 'slow reply: ' + cmd + ' took ' + ms + 'ms (' + outcome + ')'); } catch (e) {} }
  function sendRes(source, origin, obj) {
    var payload = obj;
    try { payload = JSON.parse(JSON.stringify(obj)); } catch (e) { payload = { __chloe: 1, kind: 'res', nonce: (obj && obj.nonce), ok: false, reason: 'unserializable response' }; }
    try { source.postMessage(payload, replyTarget(origin)); }
    catch (e) { try { source.postMessage({ __chloe: 1, kind: 'res', nonce: (obj && obj.nonce), ok: false, reason: 'reply post failed' }, '*'); } catch (e2) { try { console.log('[chloe.link] reply post failed twice, dropping response'); } catch (e3) {} } }
  }
  var pollInflight = {};
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
  var pageFails = 0;   // consecutive transport-level brain failures (link health, not brain quality)
  function isTransportFailure(res) {
    var r = String((res && (res.reason || res.message)) || '');
    return /page timeout|no control page|post failed|request timed out|worker (lost|has no)|circuit open|no idle workers|brain circuit|^timeout$/i.test(r);
  }
  function notePageFailure(res) {
    var r = String((res && (res.reason || res.message)) || res || '');
    if (!/page timeout|no control page|post failed/i.test(r)) { pageFails = 0; return; }
    pageFails++;
    // The captured page window is the usual suspect after a reload/navigation: postMessage to a
    // dead window never throws, it just never answers. After 3 straight link failures, drop the
    // stale handle so calls fail fast (and worker routing re-evaluates) until the next inbound
    // page message re-links us — that re-link is the self-rescue.
    if (pageFails >= 3 && pageSource) {
      trace('link', 'dropping stale control-page handle after ' + pageFails + ' straight link failures (' + r.slice(0, 120) + ') — next page message re-links');
      pageSource = null; pageOrigin = null; pageFails = 0;
    }
  }
  var brainMeter = ChloeT0.createBrainMeter({});   // per-kind latency (Jacobson) + circuit breaker
  // ---- local brain lines: one running local call per backend, the rest wait in a FIFO line
  // The control page lines incoming brain calls up the same way (textLine/imageLine), and the
  // Perchance backend serves one generation per slot — so firing N locals concurrently just piled
  // them behind waiting_for_prev with every timeout burning from dispatch. Instead each local call
  // starts the moment the previous one on its line settles, and its timeout covers the run only,
  // not the queue wait. Worker-offloaded jobs keep their own parallelism (one broker per worker
  // tab) and never touch these lines. Pure promise chaining (no timers): Node-testable.
  function makeLocalLine() {
    var line = [];
    var running = false;
    function settle() { running = false; pump(); }
    function pump() {
      if (running) return;
      var next = line.shift();
      if (!next) return;
      running = true;
      try { Promise.resolve().then(next.run).then(settle, settle); }
      catch (e) { traceErr('brain', 'local line threw synchronously, dropping one queued brain call (' + ((e && e.message) || e) + ')'); settle(); }
    }
    return {
      push: function (run) { line.push({ run: run }); pump(); }
    };
  }
  var localTextLine = makeLocalLine();
  var localImageLine = makeLocalLine();
  function brainCall(kind, args, timeoutMs) {
    // Breaker first: while the brain is down, calls fail INSTANTLY (with one probe per window)
    // instead of each burning a full timeout — the poll loop stays snappy through an outage.
    var gateRes = brainMeter.gate(kind);
    if (!gateRes.allow) { trace('brain', gateRes.reason); return Promise.resolve({ ok: false, reason: gateRes.reason }); }
    timeoutMs = timeoutMs || gateRes.timeoutMs || 40000;   // adaptive: srtt + 4*rttvar, clamped 10-90s
    if (kind !== 'paint') {
      var dials = cfgGet('personality', null);
      if (dials) args = Object.assign({}, args || {}, { personality: dials });
      var character = cfgGet('character', null);
      if (character) args = Object.assign({}, args || {}, { character: character });
    }
    function local() {
      // Down the line: callPage (and its timeout) starts only when the previous local on this
      // backend's line settles — the timeout covers the run, never the queue wait. Resolves
      // exactly as callPage would (it never rejects); the breaker accounts the round trip.
      return new Promise(function (resolve) {
        var line = (kind === 'paint') ? localImageLine : localTextLine;
        line.push(function () {
          var r = null;
          try { r = callPage(kind, args, timeoutMs); } catch (e) { r = { ok: false, reason: String((e && e.message) || e) }; }
          return Promise.resolve(r).then(resolve, resolve);
        });
      });
    }
    var t0 = Date.now();
    var p = (tabBridge && TAB_ROLE === 'queen')
      ? tabBridge.dispatchJob('brain', { kind: kind, args: args, timeoutMs: timeoutMs }, timeoutMs + 5000, local)
      : local();
    return Promise.resolve(p).then(function (res) {
      // Account honestly: an ANSWER (even {ok:false, declined}) means the wire works — breaker
      // success. A transport failure (page timeout, lost page, dead worker) must count as failure,
      // or the breaker never opens and timeouts just inflate srtt toward the 90s ceiling.
      if (res && res.ok) { pageFails = 0; brainMeter.record(kind, Date.now() - t0, true); }
      else if (isTransportFailure(res)) { notePageFailure(res); brainMeter.record(kind, null, false); }
      else { pageFails = 0; brainMeter.record(kind, Date.now() - t0, true); }
      return res;
    }, function (err) {
      notePageFailure(err);
      brainMeter.record(kind, null, false);   // rejection/timeout = transport-level failure
      throw err;
    });
  }

  // Fan an ARRAY of independent jobs out concurrently — the map step of the deliberation loop's
  // map-reduce. Each job rides brainCall (so each leases a distinct idle worker via dispatchJob's
  // round-robin busy/idle gating; the genuinely parallel resource is one broker PER worker tab).
  // Jobs that fall back to local run one at a time down the local line (each starts as soon as the
  // previous settles, with its timeout covering the run only); with K=0 (single-tab) the whole batch
  // degrades to sequential-local, identical results, just slower. Resolves an
  // array of {ok,value} in input order. A single job's failure doesn't sink the batch.
  function brainCallBatch(kind, argsList, timeoutMs) {
    if (!Array.isArray(argsList) || !argsList.length) return Promise.resolve([]);
    return Promise.all(argsList.map(function (a) {
      return brainCall(kind, a, timeoutMs).then(function (r) { return r; }, function (err) { return { ok: false, reason: String((err && err.message) || err) }; });
    }));
  }

  // ---- engine wiring ------------------------------------------------------------------
  var engines = {};   // D3: channelId -> engine (each with its own namespaced store)
  var lastPoll = null;
  var gatedLogged = {};   // read-gate transitions: one trace line per off/on flip, never per-poll
  // ---- global send budget (cross-engine, "one voice, many eyes") -----------------------
  // Observation is per-channel and always runs; SENDS are globally rationed. One text slot and one
  // image slot, each with a `sendBudgetMs` window (default 60s) shared across EVERY channel's
  // engine. canSend(kind) reports whether the slot is free; noteSend(kind) claims it (stamped at
  // the START of generation so two channels can't both pass during a multi-second brain call);
  // releaseSend(kind) hands it back if the work produced nothing. This is what makes a multi-bot
  // room safe: even five channels share one mouth.
  var sendBudget = { text: 0, image: 0 };   // monotonic-ish claim timestamps per kind
  var sendBudgetPri = { text: 0, image: 0 }; // priority of the current claim (lets a DM preempt a channel)
  function budgetWindow() { return Math.max(0, cfgGet('sendBudgetMs', 60000)); }
  function canSend(kind, priority) {
    var win = budgetWindow();
    if (win === 0) return true;
    var last = sendBudget[kind] || 0;
    if ((Date.now() - last) >= win) return true;
    // The slot is held — but a strictly higher-priority sender (e.g. a DM, priority>=1000) may preempt
    // a regular-channel claim so DMs are answered before in-channel chatter. Equal priority waits.
    var pri = priority || 0;
    return pri > (sendBudgetPri[kind] || 0);
  }
  function noteSend(kind, priority) { sendBudget[kind] = Date.now(); sendBudgetPri[kind] = priority || 0; }
  function releaseSend(kind) { sendBudget[kind] = 0; sendBudgetPri[kind] = 0; }   // give the slot back (generation was empty/failed)

  function buildEngine(chId) {
    var channelId = String(chId || primaryChannel() || '').trim();
    if (!channelId) return null;
    var eng = ChloeT0.createEngine({
      transport: transport, store: gateStore(makeStore(prefixFor(channelId)), channelId), globalStore: makeStore(''),
      config: {
        channelId: channelId,
        bridgeVersion: VERSION,
        isDM: isDMChannel(channelId),
        botUserId: cfgGet('botUserId', ''),
        botName: cfgGet('botName', ''),
        botAliases: cfgGet('botAliases', []),
        botRoleIds: cfgGet('botRoleIds', []),   // v0.90.17: role ids whose <@&id> ping summons her (Behavior -> summon roles)
        addressMode: isDMChannel(channelId) ? 'always' : cfgGet('addressMode', 'both'),
        volunteer: !!cfgGet('volunteer', false),
        greet: !!cfgGet('greet', true),
        backfill: !!cfgGet('backfill', false),
        image: !!cfgGet('image', false),
        imageQueueMax: cfgGet('imageQueueMax', 8),
        imageCooldownMs: cfgGet('imageCooldownMs', 2000),
        imageMemory: !!cfgGet('imageMemory', false),
        imageEnhanceOffer: !!cfgGet('imageEnhanceOffer', false),
        // Optional AI prompt-rewrite for natural-language image edits ("make it bigger", "same but
        // at night"). The page runs ai-text once to fold the change into the previous prompt; the
        // engine falls back to a deterministic rewrite if this declines or isn't available.
        editPrompt: function (ctx) { return brainCall('editimage', ctx); },
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
        channelLang: cfgGet('channelLang:' + channelId, null),   // v0.90.21: per-channel reply default (null = English)
        chanSpeak: chanGate(channelId, 'speak'), chanRead: chanGate(channelId, 'read'), chanRemember: chanGate(channelId, 'remember'),
        beats: cfgGet('beats', []),
        beatMinGapMs: cfgGet('beatMinGapMs', 600000),   // global min gap between beats (mirrors the lull-timing precedent; engine default 10 min)
        actPolicy: (function () { var p = cfgGet('actPolicy', 'allow'); return (p === 'ask' || p === 'deny') ? p : 'allow'; })(),   // A1: persisted policy loads at build (panel/chat both converge here)
        actGrants: (function () { var g = cfgGet('actGrants', []); return (typeof ChloeModAudit !== 'undefined' && ChloeModAudit.validateGrants && Array.isArray(g)) ? ChloeModAudit.validateGrants(g) : []; })(),   // A4: persisted always-grants load at build
        beatFn: function (b) { return brainCall('beat', b); },
        lullFn: function (ctx) { return brainCall('lull', ctx); },
        lullFiller: cfgGet('lullFiller', false),
        checkinFn: function (ctx) { return brainCall('checkin', ctx); },
        checkins: cfgGet('checkins', false),
        factFn: function (ctx) { return brainCall('facts', ctx); },
        summaryFn: function (ctx) { return brainCall('channelSummary', ctx); },
        channelSummary: cfgGet('channelSummary', true),
        reflectFn: function (ctx) { return brainCall('reflect', ctx); },
        reflection: cfgGet('reflection', true),
        episodeFn: function (ctx) { return brainCall('episodes', ctx); },
        episodicMemory: cfgGet('episodicMemory', true),
        episodeGraph: cfgGet('episodeGraph', true),
        consolidateFn: function (ctx) { return brainCall('consolidate', ctx); },   // the “sleep” semantic pass (adaptive timeout, like every other text brainCall)
        // deliberation map-reduce: decompose/reduce are single calls; mapFn fans the independent
        // sub-questions across worker tabs (parallel when a pool exists, sequential-local otherwise).
        decomposeFn: function (ctx) { return brainCall('decompose', ctx); },
        subAnswerFn: function (ctx) { return brainCall('subanswer', ctx); },
        reduceFn: function (ctx) { return brainCall('reduce', ctx); },
        mapFn: function (list) { return brainCallBatch('subanswer', list); },
        character: cfgGet('character', null),
        idleConsolidation: cfgGet('idleConsolidation', true),
        goalObjects: cfgGet('goalObjects', true),
        factMemory: cfgGet('factMemory', true),
        contradictionAware: cfgGet('contradictionAware', true),
        conversationMemory: cfgGet('conversationMemory', true),
        feedbackLearning: cfgGet('feedbackLearning', true),
        timeAware: cfgGet('timeAware', true),
        timezoneOffsetMins: cfgGet('timezoneOffsetMins', 0),
        moodAware: cfgGet('moodAware', true),
        archiveStale: cfgGet('archiveStale', true),
        greetFn: function (ctx) { return brainCall('greet', ctx); },
        modList: cfgGet('modList', []),
        commandPrefix: '!chloe', ackCommands: true,
        backgroundText: true,
        commandPrefixes: cfgGet('commandPrefixes', []),
        pollIntervalMs: 6000, cooldownMs: 8000, debounceMs: 2500, contextLines: cfgGet('contextLines', 24),
        adaptivePace: cfgGet('adaptivePace', true),
        workingMemory: cfgGet('workingMemory', true),
        cleanOutput: cfgGet('cleanOutput', true),
        semanticInjections: semInjectList(),
        deviceTime: cfgGet('deviceTime', true),
        translate: cfgGet('translate', true),
        deviceClock: GM_getValue(NS + 'deviceClock', null),
        countTokens: countTokensHook,   // exact tokenizer when warm; returns null -> engine's chars/4 fallback
        embedFn: embedHook,             // local embeddings when semanticRecall is on + warm; null -> keyword recall
        semanticRecall: cfgGet('semanticRecall', true),
        userModeling: cfgGet('userModeling', true),
        botVersion: VERSION,
        embedModel: cfgGet('embedModel', 'Xenova/bge-small-en-v1.5'),
        idleDeliberation: cfgGet('idleDeliberation', false),
        deferredIntents: cfgGet('deferredIntents', false),
        attentionManager: cfgGet('attentionManager', true),
        selfKnowledge: cfgGet('selfKnowledge', true),
        attentionStaleWindowMs: cfgGet('attentionStaleWindowMs', 600000),
        pollBusyCeilMs: cfgGet('pollBusyCeilMs', 12000),
        volunteerCooldownMs: 45000, judgeMinConfidence: 0.6,
        respond: function (ctx) { return brainCall('respond', ctx); },   // timeout now ADAPTIVE (the meter: srtt+4var, 10-90s; hardcoded values had been silently bypassing it since v0.54)
        judge: function (ctx) { return brainCall('judge', ctx); },
        recapFn: function (ctx) { return brainCall('recap', ctx); },
        search: function (q) { return webSearch(q); },   // model tool-loop item 2: the QUERY tool (outer scope owns the network; the engine stays pure)
        fetch: function (url) { return webFetch(url); },   // v0.90.19 second QUERY tool (same fail-open contract)
        almanac: function (job) { return almanacLookup(job); },   // v0.90.20 third QUERY tool
        typing: gateSpeak(channelId, 'typing', function (cid) { return transport.startTyping(cid); }),
        react: gateSpeak(channelId, 'react', function (cid, mid, emoji) { return transport.addReaction(cid, mid, emoji); }),
        unreact: gateSpeak(channelId, 'unreact', function (cid, mid, emoji) { return transport.removeReaction(cid, mid, emoji); }),
        ackReactions: cfgGet('ackReactions', true),
        singleParagraph: cfgGet('singleParagraph', false),
        toolsEnabled: !!cfgGet('toolsEnabled', false),
        converseEngine: cfgGet('converseEngine', true) !== false,
        trustHardening: cfgGet('trustHardening', true) !== false,
        bondLadder: cfgGet('bondLadder', true) !== false,
        reactionTracking: cfgGet('reactionTracking', true),
        serverMemberCount: cfgGet('serverMemberCount', 0),
        reactionAutoHighlight: cfgGet('reactionAutoHighlight', true),
        recentFetch: function (n) { return transport.getRecentMessages(channelId, n); },
        reactionUsers: function (messageId, emoji) { return transport.getReactions(channelId, messageId, emoji); },   // bounded (limit 10): her messages + positive set only
        fetchMessage: function (messageId) { return transport.getMessage(channelId, messageId); },
        reactionSummon: cfgGet('reactionSummon', false),
        defer: function (fn, ms) { return setTimeout(fn, ms); },   // completion-driven dispatch + typing keep-alive (DESIGN-roundtrip.md)
        typingRefreshMs: cfgGet('typingRefreshMs', 8000),
        relationshipTrust: cfgGet('relationshipTrust', true),
        ownAffect: cfgGet('ownAffect', true),
        proceduralModes: cfgGet('proceduralModes', true),
        procRules: cfgGet('procRules', []),
        requestTokenBudget: cfgGet('requestTokenBudget', 5000),
        ackWorkingEmoji: cfgGet('ackWorkingEmoji', '\ud83d\udde3\ufe0f'),   // speaking head: generating your reply
        ackImageEmoji: cfgGet('ackImageEmoji', '\ud83d\uddbc\ufe0f'),   // picture frame: painting
        paint: function (req) { return brainCall('paint', { prompt: req.prompt, resolution: req.resolution }, 120000); },
        sendImage: gateSpeak(channelId, 'sendImage', function (cid, dataUrl, caption) { return transport.sendImage(cid, dataUrl, caption); }),
        openDM: function (uid) { return transport.openDM(uid).then(function (dmId) { if (dmId) recordDMSession(dmId, uid, ''); return dmId; }); },
        onChannelGone: function (chId) {
          if (isDMChannel(chId)) {
            var s = dmSessions(); if (s[chId]) { delete s[chId]; cfgSet('dmSessions', s); }
            trace('poll', 'DM channel ' + chId + ' is gone (recipient closed it) \u2014 dropped from polling');
          } else {
            trace('poll', 'channel ' + chId + ' returned Unknown Channel (404) \u2014 paused. Check the channel id / bot permissions, then Start again.');
            console.warn('[chloe] channel ' + chId + ' is unreachable (404 Unknown Channel). Polling for it is paused; verify the channel id and that the bot can see it.');
          }
          delete engines[chId];
          pushEvent('channelGone', { channelId: chId });
        },
        send: gateSpeak(channelId, 'send', function (cid, text, opts) {
          var toUser = opts && opts.toUser;
          if (!cfgGet('translate', true) || !toUser) return transport.sendMessage(cid, text, opts);
          var eng = engineFor(cid);
          var langP = (eng && typeof eng.getUserLang === 'function') ? eng.getUserLang(toUser) : Promise.resolve(null);
          return Promise.resolve(langP).then(function (lang) {
            var eff = lang || cfgGet('channelLang:' + cid, null);   // v0.90.21: user override wins, else the channel default
            if (!eff || eff === 'en') return transport.sendMessage(cid, text, opts);
            return translate(text, eff, 'en').then(function (res) { return transport.sendMessage(cid, res.text, opts); });
          });
        }),
        canSend: canSend, noteSend: noteSend, releaseSend: releaseSend,
        sendBudgetMs: cfgGet('sendBudgetMs', 60000),
        botLoopGrace: cfgGet('botLoopGrace', 2),
        botLoopFloor: cfgGet('botLoopFloor', 0.05),
        botLoopHardStop: cfgGet('botLoopHardStop', 12),
        sendEmbed: gateSpeak(channelId, 'sendEmbed', function (cid, embed) { return transport.sendEmbed(cid, embed); }),
        onPoll: function (summary) {
          lastPoll = summary; pushEvent('poll', summary);
          if (summary && summary.gated) {
            if (!gatedLogged[channelId]) { gatedLogged[channelId] = true; trace('poll', 'channel ' + channelId + ' read gate is off — skipping polls (no fetch, no replies, no memory)'); }
          } else if (gatedLogged[channelId]) gatedLogged[channelId] = false;
          if (summary && (summary.ingested || summary.replied || summary.imageJob || summary.greeted || summary.volunteered || summary.commands)) {
            trace('poll', 'in ' + (summary.ingested || 0) + (summary.replied ? ' reply' : '') + (summary.imageJob ? ' image' : '') + (summary.greeted ? ' greet' : '') + (summary.volunteered ? ' vol' : '') + (summary.commands ? ' cmd' : '') + ' [' + (summary.engageMode || 'normal') + ']');
          }
          if (summary && summary.engageMode && summary.engageMode !== cfgGet('engageMode:' + channelId, cfgGet('engageMode', 'normal'))) cfgSet('engageMode:' + channelId, summary.engageMode);  // a !chloe lockdown/unlock/open command changed it
          if (summary && summary.channelLangTouched) {   // v0.90.21: a !chloe lang default command changed it
            if (summary.channelLang) cfgSet('channelLang:' + channelId, summary.channelLang);
            else GM_deleteValue(NS + 'cfg:channelLang:' + channelId);
            var __ce = engines[channelId];   // targeted, never broadcast (see setChannelLang)
            if (__ce && typeof __ce.updateConfig === 'function') { try { __ce.updateConfig({ channelLang: summary.channelLang || null }); } catch (eCL) {} }
          }
          if (summary && summary.actPolicyTouched) {   // A1: a !chloe policy command changed it (clamped to the enum)
            var __pol = (summary.actPolicy === 'ask' || summary.actPolicy === 'deny') ? summary.actPolicy : 'allow';
            cfgSet('actPolicy', __pol); patchEngines({ actPolicy: __pol });
          }
          if (summary && summary.actGrantsTouched && Array.isArray(summary.actGrants) && summary.actGrants.length) {   // A4: a !chloe approve ... always command granted some
            var __cur = cfgGet('actGrants', []); if (!Array.isArray(__cur)) __cur = [];
            var __add = (typeof ChloeModAudit !== 'undefined' && ChloeModAudit.validateGrants) ? ChloeModAudit.validateGrants(summary.actGrants) : [];
            __add.forEach(function (g) {
              if (!__cur.some(function (e) { return e && e.action === g.action && e.resource === g.resource && e.scope === g.scope; })) __cur.push(g);
            });
            cfgSet('actGrants', __cur); patchEngines({ actGrants: __cur });
          }
          if (summary && summary.modListTouched && Array.isArray(summary.modList)) {   // A7: a !chloe elevate/demote/undo changed it
            var __ml = cleanModListIds(summary.modList);
            cfgSet('modList', __ml); patchEngines({ modList: __ml });
          }
          // A8: a !chloe undo reverted a quarantine release — restore the live
          // sets it overwrote (prior-or-null; null deletes back to absent).
          ['beats', 'autoModRules', 'procRules'].forEach(function (qk) {
            var tk = qk + 'Touched';
            if (summary && summary[tk] && (summary[qk] === null || Array.isArray(summary[qk]))) {
              if (summary[qk] == null) { try { GM_deleteValue(NS + 'cfg:' + qk); } catch (eQD) {} }
              else cfgSet(qk, summary[qk]);
              var __pe = {}; __pe[qk] = summary[qk]; patchEngines(__pe);
            }
          });
          if (summary && summary.quarantineTouched) {   // A8: re-hold released/dropped sets
            restashQuarantine(summary.quarantine);
          }
          // A lock-skip poll means another engine instance owns this channel right now (queen handover
          // / split-brain). Maintenance writes the DB (backfill checkpoint + partitions, departure
          // sweeps, anchor notes), so the skipping instance must NOT run it — only the lock-holder.
          if (summary && summary.lockSkip) return Promise.resolve();
          return presenceMaintenance(channelId);
        }
      },
      log: function () { console.log.apply(console, arguments); try { var m7065 = Array.prototype.join.call(arguments, ' '); if (/error|fail|exception|denied|forbidden|unauthori|rate[ .]?limit|timed[ ]?out|too many|invalid|missing|corrupt|mismatch|expired|dropp|queue full|abandon|not sent|code=10003|unknown channel| 404| 403| 429| 500|reply failed/i.test(m7065)) { var mm7065 = String(m7065).slice(0, 500); traceErr('engine', mm7065); pushEvent('log', mm7065); } else if (/throttl|tool-only|dropped injection|no reply to|empty generation|skipped/i.test(m7065)) { try { traceErr('engine', String(m7065).slice(0, 500)); } catch (e77) {} } } catch (e7065) {} }
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
    if (!chanGate(chId, 'read')) return Promise.resolve();   // blind channel: no reads of any kind
    var memOn = chanGate(chId, 'remember');   // goldfish channel: nothing to write to, so no history/member/anchor reads
    var jobs = Promise.resolve();
    if (memOn && cfgGet('backfill', false) && !cfgGet('backfillDone:' + chId, false)) {
      jobs = jobs.then(function () {
        return eng.backfillStep(function (before, limit) { return transport.getMessagesBefore(chId, before, limit); })
          .then(function (r) { if (r) { if (!r.done) pushEvent('backfill', r); else { cfgSet('backfillDone:' + chId, true); var allDone = channelList().every(function (c) { return cfgGet('backfillDone:' + c, false); }); if (allDone) cfgSet('backfill', false); console.log('[chloe.T5] backfill complete (' + chId + '): ' + r.ingested + ' msgs over ' + r.pages + ' page(s)'); pushEvent('backfill', r); } } }, function () {});
      });
    }
    maintTick++;
    if (memOn && cfgGet('memberCheck', false) && (maintTick % 10 === 0)) {
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
        }).catch(function (e) { traceErr('maint', 'member-check sweep failed (' + ((e && e.message) || e) + ')'); });
      });
    }
    if (memOn && cfgGet('personaAnchor', false) && (maintTick % 10 === 3)) {
      jobs = jobs.then(function () {
        return eng.anchorSweep(
          function () { return transport.getMessagesAfter(chId, null, 20); },
          function (mid, emoji) { return transport.getReactions(chId, mid, emoji); }
        ).then(function (r) { if (r && r.changed) { trace('persona', 'new anchored note (' + chId + ')'); pushEvent('persona', r); } }, function (e) { traceErr('persona', 'anchor sweep failed (' + chId + '): ' + ((e && e.message) || e)); });
      });
    }
    return jobs;
  }
  function ensureEngines() { return channelList().map(function (c) { return engines[c] || buildEngine(c); }).filter(Boolean); }
  function engineFor(chId) { var c = chKeyOf({ channelId: chId }); if (!c) return null; return engines[c] || buildEngine(c); }
  function eachEngine(fn) { Object.keys(engines).forEach(function (c) { try { fn(engines[c], c); } catch (e) { traceErr('engine', 'eachEngine op failed (' + ((e && e.message) || e) + ')'); } }); }

  var guildIdCache = {};
  function resolveGuildId(chId) {
    var cid = String(chId || primaryChannel() || '').trim();
    if (!cid) return Promise.resolve(null);
    // In-memory cache (survives the session)
    if (guildIdCache[cid]) return Promise.resolve(guildIdCache[cid]);
    // GM-persisted cache (survives engine restarts)
    var gmKey = NS + 'guildId:' + cid;
    var stored = GM_getValue(gmKey, null);
    if (stored) { guildIdCache[cid] = stored; return Promise.resolve(stored); }
    return transport.getChannel(cid).then(function (ch) {
      var gid = (ch && ch.guild_id) || null;
      if (gid) { guildIdCache[cid] = gid; GM_setValue(gmKey, gid); }
      return gid;
    }, function () { return null; });
  }
  // config changes must not run on a stale instance: stop, rebuild, and restart if it was live
  // Push a config patch to all LIVE engines in-place (no rebuild, no restart).
  // Only for values in LIVE_PATCHABLE (read at call-time by the engine, not captured at startup).
  function patchEngines(patch) {
    Object.keys(engines).forEach(function (c) {
      var eng = engines[c];
      if (eng && typeof eng.updateConfig === 'function') eng.updateConfig(patch);
    });
  }

  function applyConfigChange() {
    var wasRunning = Object.keys(engines).some(function (c) { return engines[c] && engines[c].isRunning && engines[c].isRunning(); });
    eachEngine(function (e) { e.stop(); });
    engines = {};
    guildIdCache = {};
    if (wasRunning) ensureEngines().forEach(function (e) { e.start(); });
  }

  // Auto-detect the server's member count once, so reaction significance scales correctly out of the
  // box. Channel -> guild_id -> guild approximate_member_count. Only if not already set by the operator.
  function maybeDetectMemberCount() {
    if (cfgGet('serverMemberCount', 0) > 0) return Promise.resolve(0);
    var ch = primaryChannel();
    if (!ch) return Promise.resolve(0);
    return Promise.resolve(transport.getChannel(ch)).then(function (c) {
      var gid = c && c.guild_id;
      if (gid) { guildIdCache[ch] = gid; GM_setValue(NS + 'guildId:' + ch, gid); }   // cache for permaban
      if (!gid) return 0;
      return transport.getGuildMemberCount(gid).then(function (n) {
        if (n > 0) { cfgSet('serverMemberCount', n); patchEngines({ serverMemberCount: n }); bLog('[chloe] detected ~' + n + ' members; reaction significance scaled accordingly'); }
        return n;
      });
    }).catch(function (e) { trace('server', 'membercount detect failed (' + ((e && e.message) || e) + ')'); return 0; });
  }

  function validate() {
    return transport.getMe().then(function (me) {
      if (!me || !me.id) return { ok: false, reason: 'no identity returned (check the token)' };
      cfgSet('botUserId', me.id); cfgSet('botName', me.username || '');
      applyConfigChange();  // rebuild (and restart if live) with the fresh identity
      maybeDetectMemberCount();   // fire-and-forget: scale reaction significance to the server
      return { ok: true, value: { id: me.id, username: me.username, bot: me.bot } };
    }).catch(function (e) { return { ok: false, reason: 'HTTP ' + (e.status || '?'), body: errBrief(e.body) || null }; });   // surface the error code, not the PII-bearing raw body
  }
  function statusSnapshot() {
    try { return statusSnapshotCore(); } catch (e) { return { version: VERSION, snapshotError: String((e && e.message) || e), channelId: cfgGet('channelId', ''), running: false }; }
  }
  function statusSnapshotCore() {
    return {
      version: VERSION, hasToken: hasToken(),
      channelId: cfgGet('channelId', ''), botUserId: cfgGet('botUserId', ''), botName: cfgGet('botName', ''),
      botRoleIds: cfgGet('botRoleIds', []), addressMode: cfgGet('addressMode', 'both'), volunteer: !!cfgGet('volunteer', false),
      greet: !!cfgGet('greet', true), memberCheck: !!cfgGet('memberCheck', false), backfill: !!cfgGet('backfill', false),
      dmReplies: !!cfgGet('dmReplies', true),
      publicChannels: [primaryChannel()].concat(cfgGet('channels', []) || []).filter(Boolean),
      dmChannels: declaredDmChannels(),
      ackReactions: cfgGet('ackReactions', true),
      singleParagraph: !!cfgGet('singleParagraph', false),
      toolsEnabled: !!cfgGet('toolsEnabled', false),
      converseEngine: cfgGet('converseEngine', true) !== false,
      trustHardening: cfgGet('trustHardening', true) !== false,
      bondLadder: cfgGet('bondLadder', true) !== false,
      lullFiller: !!cfgGet('lullFiller', false),
      lullPatienceMs: cfgGet('lullPatienceMs', 86400000),
      lullMinGapMs: cfgGet('lullMinGapMs', 86400000),
      checkins: !!cfgGet('checkins', false),
      checkinMinInteractions: cfgGet('checkinMinInteractions', 8),
      checkinAbsenceMs: cfgGet('checkinAbsenceMs', 259200000),
      checkinPerUserGapMs: cfgGet('checkinPerUserGapMs', 1209600000),
      checkinGapMs: cfgGet('checkinGapMs', 86400000),
      checkinFavorites: cfgGet('checkinFavorites', []),
      checkinBlacklist: cfgGet('checkinBlacklist', []),
      factMemory: !!cfgGet('factMemory', true),
      contradictionAware: !!cfgGet('contradictionAware', true),
      conversationMemory: cfgGet('conversationMemory', true) !== false,
      feedbackLearning: !!cfgGet('feedbackLearning', true),
      timeAware: !!cfgGet('timeAware', true),
      deviceTime: !!cfgGet('deviceTime', true),
      operatorNote: (function () { var m = semInjectMap(); return (m['opnote'] && m['opnote'].text) ? String(m['opnote'].text) : ''; })(),
      timezoneOffsetMins: cfgGet('timezoneOffsetMins', 0),
      moodAware: !!cfgGet('moodAware', true),
      channelSummary: !!cfgGet('channelSummary', true),
      reflection: !!cfgGet('reflection', true),
      episodicMemory: !!cfgGet('episodicMemory', true),
      episodeGraph: cfgGet('episodeGraph', true) !== false,
      adaptivePace: cfgGet('adaptivePace', true) !== false,
      workingMemory: cfgGet('workingMemory', true) !== false,
      exactTokens: cfgGet('exactTokens', true) !== false,
      cleanOutput: cfgGet('cleanOutput', true) !== false,
      translate: cfgGet('translate', true) !== false,
      tokenizer: tokLoader.state(),
      semanticRecall: !!cfgGet('semanticRecall', true),
      userModeling: !!cfgGet('userModeling', true),
      embedder: embedLoader.state(),
      idleDeliberation: cfgGet('idleDeliberation', false) !== false,
      deferredIntents: !!cfgGet('deferredIntents', false),
      attentionManager: cfgGet('attentionManager', true) !== false,
      selfKnowledge: cfgGet('selfKnowledge', true) !== false,
      goalObjects: cfgGet('goalObjects', true) !== false,
      idleConsolidation: cfgGet('idleConsolidation', true) !== false,
      relationshipTrust: !!cfgGet('relationshipTrust', true),
      ownAffect: !!cfgGet('ownAffect', true),
      proceduralModes: !!cfgGet('proceduralModes', true), procRules: cfgGet('procRules', []),
      hamRadio: !!cfgGet('hamRadio', false),
      reactionSummon: !!cfgGet('reactionSummon', false),
      brain: brainMeter.snapshot(),
      image: !!cfgGet('image', false),
      imageQueueMax: cfgGet('imageQueueMax', 8),
      imageMemory: !!cfgGet('imageMemory', false),
      imageEnhanceOffer: !!cfgGet('imageEnhanceOffer', false),
      autoMod: !!cfgGet('autoMod', false), autoModRules: cfgGet('autoModRules', []),
      engageMode: cfgGet('engageMode:' + primaryChannel(), cfgGet('engageMode', 'normal')),
      channelLang: cfgGet('channelLang:' + primaryChannel(), null),
      channels: channelList(),
      channelLangs: (function () { var m = {}; channelList().forEach(function (c) { m[c] = cfgGet('channelLang:' + c, null); }); return m; })(),
      engageModes: (function () { var m = {}; channelList().forEach(function (c) { m[c] = cfgGet('engageMode:' + c, cfgGet('engageMode', 'normal')); }); return m; })(),
      chanGates: (function () { var m = {}; channelList().forEach(function (c) { m[c] = chanGatesFor(c); }); return m; })(),
      games: (function () { var m = {}; channelList().forEach(function (c) { m[c] = gameStatusFor(c); }); return m; })(),
      quarantine: quarantineSummary(),
      actPolicy: cfgGet('actPolicy', 'allow'),
      actGrants: (function () { var g = cfgGet('actGrants', []); return Array.isArray(g) ? g : []; })(),
      pendingAct: (function () { var m = {}; channelList().forEach(function (c) { m[c] = pendingActFor(c); }); return m; })(),
      actLog: (function () { var m = {}; channelList().forEach(function (c) { m[c] = actLogFor(c); }); return m; })(),
      undoTop: (function () { var m = {}; channelList().forEach(function (c) { m[c] = undoTopFor(c); }); return m; })(),
      runningByChannel: (function () { var m = {}; channelList().forEach(function (c) { m[c] = !!(engines[c] && engines[c].isRunning && engines[c].isRunning()); }); return m; })(),
      beats: cfgGet('beats', []),
      commandPrefixes: cfgGet('commandPrefixes', []),
      noticePinned: !!cfgGet('noticePinned', false), noticeText: cfgGet('noticeText', ''),
      personality: cfgGet('personality', null), personaAnchor: !!cfgGet('personaAnchor', false),
      character: cfgGet('character', null),
      gates: { emoji: gate('emoji', true), pings: gate('pings', false), everyone: gate('everyone', false), links: gate('links', false), channelLinks: gate('channelLinks', false) },
      pageLinked: !!pageSource,
      link: linkSnapshot(),
      running: Object.keys(engines).some(function (c) { return engines[c] && engines[c].isRunning && engines[c].isRunning(); }),
      lastPoll: lastPoll
    };
  }

  // ---- control link: page (generator HTML panel) -> userscript (trusted surface) ------
  // Mirrors the skybridge trust shape: origin-checked, nonce-matched, scoped commands,
  // secrets never cross (the bot token is never returned to the page).
  // Perchance serves the control generator from a perchance.org origin OR, when the embed is
  // sandboxed (no allow-same-origin), from origin "null". Both are legitimate same-tab embeds; the
  // real protection is the same-tab link + nonce matching + the bot token never crossing to the page.
  // Rejecting "null" was a false-negative that broke detection inside sandboxed embeds while real
  // brain traffic (userscript-initiated, replied via the captured page handle) still flowed.
  var ORIGIN_OK = /^(null|https:\/\/([a-z0-9]{32}\.)?perchance\.org)$/;
  // v0.90.4 consolidation: the single-flag toggles shared one shape (cfgSet + optional
  // patch/restart + {key: value} reply) across ~37 cases — now a table, not cases. Specials
  // with extra work (setMode enum, setTimeAware offset, setDeviceTime drop, setSemanticRecall
  // + setExactTokens preloads) keep their own cases below. Mode: 'patch' | 'store' | 'config'.
  var FLAG_TOGGLES = [
    ['config.setVolunteer', 'volunteer', 'patch'], ['config.setGreet', 'greet', 'patch'],
    ['config.setMemberCheck', 'memberCheck', 'store'], ['config.setBackfill', 'backfill', 'patch'],
    ['config.setImage', 'image', 'patch'], ['config.setImageMemory', 'imageMemory', 'patch'],
    ['config.setImageEnhanceOffer', 'imageEnhanceOffer', 'patch'], ['config.setAutoMod', 'autoMod', 'patch'],
    ['config.setPersonaAnchor', 'personaAnchor', 'store'], ['config.setDMReplies', 'dmReplies', 'config'],
    ['config.setAckReactions', 'ackReactions', 'patch'], ['config.setSingleParagraph', 'singleParagraph', 'patch'],
    ['config.setToolsEnabled', 'toolsEnabled', 'patch'],
    ['config.setConverseEngine', 'converseEngine', 'patch'],
    ['config.setTrustHardening', 'trustHardening', 'patch'],
    ['config.setBondLadder', 'bondLadder', 'patch'],
    ['config.setLullFiller', 'lullFiller', 'patch'], ['config.setCheckins', 'checkins', 'patch'],
    ['config.setFeedbackLearning', 'feedbackLearning', 'patch'], ['config.setConversationMemory', 'conversationMemory', 'patch'],
    ['config.setContradictionAware', 'contradictionAware', 'patch'], ['config.setFactMemory', 'factMemory', 'patch'],
    ['config.setMoodAware', 'moodAware', 'patch'], ['config.setChannelSummary', 'channelSummary', 'patch'],
    ['config.setAdaptivePace', 'adaptivePace', 'patch'], ['config.setWorkingMemory', 'workingMemory', 'patch'],
    ['config.setIdleDeliberation', 'idleDeliberation', 'patch'], ['config.setDeferredIntents', 'deferredIntents', 'patch'],
    ['config.setAttentionManager', 'attentionManager', 'patch'], ['config.setSelfKnowledge', 'selfKnowledge', 'patch'],
    ['config.setCleanOutput', 'cleanOutput', 'patch'], ['config.setTranslate', 'translate', 'patch'],
    ['config.setUserModeling', 'userModeling', 'patch'], ['config.setEpisodeGraph', 'episodeGraph', 'patch'],
    ['config.setIdleConsolidation', 'idleConsolidation', 'patch'], ['config.setGoalObjects', 'goalObjects', 'patch'],
    ['config.setReflection', 'reflection', 'patch'], ['config.setEpisodicMemory', 'episodicMemory', 'patch'],
    ['config.setRelationshipTrust', 'relationshipTrust', 'patch'], ['config.setOwnAffect', 'ownAffect', 'patch'],
    ['config.setProceduralModes', 'proceduralModes', 'patch'], ['config.setReactionSummon', 'reactionSummon', 'patch'],
    ['config.setHamRadio', 'hamRadio', 'patch']
  ];
  function dispatchFlagToggle(cmd, args) {
    for (var i = 0; i < FLAG_TOGGLES.length; i++) {
      var t = FLAG_TOGGLES[i]; if (t[0] !== cmd) continue;
      var v = !!(args && args.on); cfgSet(t[1], v);
      if (t[2] === 'config') applyConfigChange();
      else if (t[2] !== 'store') { var pe = {}; pe[t[1]] = v; patchEngines(pe); }
      var out = {}; out[t[1]] = v; return Promise.resolve({ ok: true, value: out });
    }
    return null;
  }
  function dispatch(cmd, args) {
    var flagRes = dispatchFlagToggle(cmd, args); if (flagRes) return flagRes;
    switch (cmd) {
      case 'ping':            return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'status':          return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'config.setChannel':
        cfgSet('channelId', String((args && args.channelId) || '').trim()); applyConfigChange();
        return Promise.resolve({ ok: true, value: { channelId: cfgGet('channelId', '') } });
      case 'config.setMode':
        { var mode = String((args && args.mode) || 'both'); if (mode !== 'mention' && mode !== 'name' && mode !== 'both') mode = 'both'; cfgSet('addressMode', mode); applyConfigChange(); return Promise.resolve({ ok: true, value: { addressMode: mode } }); }
      case 'config.setPrefixes': {
        var list = (args && args.prefixes);
        if (!Array.isArray(list)) return Promise.resolve({ ok: false, reason: 'prefixes must be an array' });
        var clean = [];
        list.forEach(function (p) { p = String(p || '').trim().slice(0, 64); if (p && p !== '!chloe' && clean.indexOf(p) < 0 && clean.length < 64) clean.push(p); });   // re-validate: per-prefix + count caps
        cfgSet('commandPrefixes', clean); patchEngines({ commandPrefixes: clean });
        return Promise.resolve({ ok: true, value: { commandPrefixes: clean } });
      }
      case 'config.setSummonRoles': {   // v0.90.17: role ids whose <@&id> ping summons her (a role ping carries no name, so only listed ids match)
        var rl = (args && args.roleIds);
        if (!Array.isArray(rl)) return Promise.resolve({ ok: false, reason: 'roleIds must be an array' });
        var cleanR = [];
        for (var ri = 0; ri < rl.length && cleanR.length < 16; ri++) {
          var rid = String(rl[ri] || '').trim();
          if (!/^\d{8,32}$/.test(rid)) continue;   // re-validate: Discord snowflakes are digits only
          if (cleanR.indexOf(rid) < 0) cleanR.push(rid);
        }
        cfgSet('botRoleIds', cleanR); patchEngines({ botRoleIds: cleanR });   // LIVE_PATCHABLE: applies without restart
        return Promise.resolve({ ok: true, value: { botRoleIds: cleanR } });
      }
      case 'config.setLullTiming': {   // Reach out card: silence-filler pace (Discord time — clamps keep it sane, client caps are bypassable)
        var lullP = Math.round(Number(args && args.patienceMs) || 86400000);
        if (!isFinite(lullP)) lullP = 86400000;
        lullP = Math.max(3600000, Math.min(604800000, lullP));          // 1h .. 7d
        var lullG = Math.round(Number(args && args.minGapMs) || 86400000);
        if (!isFinite(lullG)) lullG = 86400000;
        lullG = Math.max(3600000, Math.min(1209600000, lullG));         // 1h .. 14d
        cfgSet('lullPatienceMs', lullP); cfgSet('lullMinGapMs', lullG);
        patchEngines({ lullPatienceMs: lullP, lullMinGapMs: lullG });
        return Promise.resolve({ ok: true, value: { lullPatienceMs: lullP, lullMinGapMs: lullG } });
      }
      case 'config.setCheckinTiming': {   // Reach out card: check-in pace + favorite threshold
        var ciA = Math.round(Number(args && args.absenceMs) || 259200000);
        if (!isFinite(ciA)) ciA = 259200000;
        ciA = Math.max(21600000, Math.min(2592000000, ciA));            // 6h .. 30d
        var ciG = Math.round(Number(args && args.gapMs) || 86400000);
        if (!isFinite(ciG)) ciG = 86400000;
        ciG = Math.max(3600000, Math.min(1209600000, ciG));             // 1h .. 14d
        var ciP = Math.round(Number(args && args.perUserGapMs) || 1209600000);
        if (!isFinite(ciP)) ciP = 1209600000;
        ciP = Math.max(86400000, Math.min(7776000000, ciP));           // 1d .. 90d
        var ciM = Math.round(Number(args && args.minInteractions));
        if (!isFinite(ciM)) ciM = 8;
        ciM = Math.max(1, Math.min(100, ciM));
        cfgSet('checkinAbsenceMs', ciA); cfgSet('checkinGapMs', ciG);
        cfgSet('checkinPerUserGapMs', ciP); cfgSet('checkinMinInteractions', ciM);
        patchEngines({ checkinAbsenceMs: ciA, checkinGapMs: ciG, checkinPerUserGapMs: ciP, checkinMinInteractions: ciM });
        return Promise.resolve({ ok: true, value: { checkinAbsenceMs: ciA, checkinGapMs: ciG, checkinPerUserGapMs: ciP, checkinMinInteractions: ciM } });
      }
      case 'config.setCheckinLists': {   // Reach out card: pinned favorites + proactive blacklist (ids only; moderation untouched)
        var favIn = (args && args.favorites), blkIn = (args && args.blacklist);
        if (favIn != null && !Array.isArray(favIn)) return Promise.resolve({ ok: false, reason: 'favorites must be an array' });
        if (blkIn != null && !Array.isArray(blkIn)) return Promise.resolve({ ok: false, reason: 'blacklist must be an array' });
        function cleanIds(list, fb) {
          var src = Array.isArray(list) ? list : fb, out = [];
          for (var li = 0; li < src.length && out.length < 200; li++) {
            var lid = String(src[li] || '').trim();
            if (!/^\d{8,32}$/.test(lid)) continue;   // re-validate: Discord snowflakes are digits only
            if (out.indexOf(lid) < 0) out.push(lid);
          }
          return out;
        }
        var favClean = cleanIds(favIn, cfgGet('checkinFavorites', []) || []);
        var blkClean = cleanIds(blkIn, cfgGet('checkinBlacklist', []) || []);
        cfgSet('checkinFavorites', favClean); cfgSet('checkinBlacklist', blkClean);
        patchEngines({ checkinFavorites: favClean, checkinBlacklist: blkClean });
        return Promise.resolve({ ok: true, value: { checkinFavorites: favClean, checkinBlacklist: blkClean } });
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
          if (cleanB.length >= 200) return;   // re-validate: array-length cap (client cap is bypassable)
          if (!b || !b.id || !b.intervalMs) return;
          var o = { id: String(b.id).slice(0, 80), intervalMs: Number(b.intervalMs) || 0 };
          if (!o.intervalMs) return;
          if (Array.isArray(b.texts) && b.texts.length) o.texts = b.texts.slice(0, 20).map(function (t) { return String(t).slice(0, 2000); });
          else if (b.text) o.text = String(b.text).slice(0, 2000);
          else if (b.prompt) o.prompt = String(b.prompt).slice(0, 2000);
          else return;   // a beat with nothing to say is dropped
          if (b.activeWithinMs != null) o.activeWithinMs = Number(b.activeWithinMs) || 0;
          cleanB.push(o);
        });
        cfgSet('beats', cleanB); patchEngines({ beats: cleanB });
        return Promise.resolve({ ok: true, value: { count: cleanB.length, beats: cleanB } });
      }
      case 'config.setPersonality': {
        var rawP = (args && args.personality);
        if (rawP == null) { cfgSet('personality', null); return Promise.resolve({ ok: true, value: { personality: null } }); }
        if (typeof rawP !== 'object') return Promise.resolve({ ok: false, reason: 'personality must be an object of 0..1 dials' });
        var DIALS = ['kindness', 'sarcasm', 'curiosity', 'playfulness', 'formality', 'verbosity'];
        var cleanP = {};
        DIALS.forEach(function (k) { if (rawP[k] != null && isFinite(rawP[k])) cleanP[k] = Math.max(0, Math.min(1, Number(rawP[k]))); });
        var prevP = cfgGet('personality', null) || {}; DIALS.forEach(function (k) { if (cleanP[k] == null && prevP[k] != null && isFinite(prevP[k])) cleanP[k] = Math.max(0, Math.min(1, Number(prevP[k]))); });
        cfgSet('personality', cleanP);
        return Promise.resolve({ ok: true, value: { personality: cleanP } });
      }
      case 'config.setCharacter': {
        var nm = (args && args.name != null) ? String(args.name).trim() : null;
        if (!nm) { cfgSet('character', null); applyConfigChange(); return Promise.resolve({ ok: true, value: { character: null } }); }
        var rawAv = String((args && args.avatar) || '').slice(0, 2000);
        var avLow = rawAv.toLowerCase().replace(/^\s+/, '');
        var avOk = rawAv && (avLow.indexOf('http://') === 0 || avLow.indexOf('https://') === 0 || avLow.indexOf('blob:') === 0 || avLow.indexOf('data:image/') === 0) && avLow.indexOf('javascript:') !== 0 && avLow.indexOf('vbscript:') !== 0 && avLow.indexOf('data:text/html') !== 0;
        var ch = { name: nm.slice(0, 80), instruction: String((args && args.instruction) || '').slice(0, 8000), avatar: avOk ? rawAv : '' };   // re-validate: avatar scheme allowlist (a forged setCharacter could carry javascript:/data:text/html)
        cfgSet('character', ch); applyConfigChange();
        return Promise.resolve({ ok: true, value: { character: { name: ch.name } } });
      }
      case 'character.seedMemories': {
        var eS = engineFor(args && args.channelId); if (!eS) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var mems = (args && Array.isArray(args.memories)) ? args.memories : [];
        var who = String((args && args.name) || 'this character');
        if (!mems.length) return Promise.resolve({ ok: true, value: { seeded: 0 } });
        return eS.seedCharacterMemories(who, mems).then(function (n) { return { ok: true, value: { seeded: n } }; });
      }
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
        rawC.forEach(function (c) { c = String(c || '').trim(); if (/^\d{15,25}$/.test(c) && c !== primaryChannel() && !seenC[c] && cleanC.length < 64) { seenC[c] = 1; cleanC.push(c); } });   // re-validate: Discord snowflake range + count cap (client caps are bypassable via direct postMessage)
        cfgSet('channels', cleanC); applyConfigChange();
        return Promise.resolve({ ok: true, value: { channels: channelList() } });
      }
      case 'config.setAllChannels': {
        // One unified list (UI: a single textarea). First valid id = primary, the rest = extras.
        var rawA = (args && args.channels);
        if (!Array.isArray(rawA)) return Promise.resolve({ ok: false, reason: 'channels must be an array of channel ids' });
        var cleanA = [], seenA = {};
        var dmsetA = {}; declaredDmChannels().forEach(function (d) { dmsetA[d] = 1; });
        rawA.forEach(function (c) { c = String(c || '').trim(); if (/^\d{15,25}$/.test(c) && !seenA[c] && !dmsetA[c] && cleanA.length < 64) { seenA[c] = 1; cleanA.push(c); } });   // snowflake range + count cap; never let a declared DM sit in the public list
        var primary = cleanA[0] || '';
        cfgSet('channelId', primary);
        cfgSet('channels', cleanA.slice(1));
        applyConfigChange();
        return Promise.resolve({ ok: true, value: { channels: channelList(), primary: primary } });
      }
      case 'config.setDmChannels': {
        // The "private DMs" box: channel ids to poll AND treat as DMs (isDM -> the public->DM merge runs).
        var rawD = (args && args.channels);
        if (!Array.isArray(rawD)) return Promise.resolve({ ok: false, reason: 'dmChannels must be an array of channel ids' });
        var cleanD = [], seenD = {};
        rawD.forEach(function (c) { c = String(c || '').trim(); if (/^\d{15,25}$/.test(c) && c !== primaryChannel() && !seenD[c] && cleanD.length < 64) { seenD[c] = 1; cleanD.push(c); } });   // snowflake range + count cap
        cfgSet('dmChannels', cleanD);
        // keep the two boxes mutually exclusive: drop any newly-declared DM from the public extras
        var dmsetD = {}; cleanD.forEach(function (d) { dmsetD[d] = 1; });
        var pub = (cfgGet('channels', []) || []).filter(function (c) { return !dmsetD[String(c).trim()]; });
        cfgSet('channels', pub);
        applyConfigChange();
        return Promise.resolve({ ok: true, value: { dmChannels: cleanD, channels: channelList() } });
      }
      case 'config.setEngageMode': {
        var mode = (args && args.mode);
        if (mode !== 'locked' && mode !== 'normal' && mode !== 'open') return Promise.resolve({ ok: false, reason: 'mode must be locked|normal|open' });
        var emCh = chKeyOf(args);
        if (!emCh) return Promise.resolve({ ok: false, reason: 'no channel set' });
        cfgSet('engageMode:' + emCh, mode); patchEngines({ engageMode: mode });
        return Promise.resolve({ ok: true, value: { engageMode: mode, channelId: emCh } });
      }
      case 'config.setChannelLang': {   // v0.90.21: per-channel reply default (null clears to English)
        var chL = chKeyOf(args);
        if (!chL) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var rawL = (args && args.lang != null) ? String(args.lang).trim().toLowerCase() : '';
        if (!rawL || rawL === 'off' || rawL === 'en' || rawL === 'english' || rawL === 'default') {
          GM_deleteValue(NS + 'cfg:channelLang:' + chL);
          var __e0 = engines[chL]; if (__e0 && typeof __e0.updateConfig === 'function') { try { __e0.updateConfig({ channelLang: null }); } catch (e0) {} }
          return Promise.resolve({ ok: true, value: { lang: null, channelId: chL } });
        }
        var __ln = (typeof ChloeT0 !== 'undefined' && ChloeT0.LANG_NAMES) || {};
        if (!__ln[rawL]) return Promise.resolve({ ok: false, reason: 'unknown language code' });
        cfgSet('channelLang:' + chL, rawL);
        // Targeted single-engine patch, NOT patchEngines: a broadcast would leak one channel's
        // language into every channel (the setEngageMode broadcast flaw, deliberately not repeated).
        var __e1 = engines[chL]; if (__e1 && typeof __e1.updateConfig === 'function') { try { __e1.updateConfig({ channelLang: rawL }); } catch (e1) {} }
        return Promise.resolve({ ok: true, value: { lang: rawL, channelId: chL } });
      }
      case 'config.setChannelGate': {   // per-channel speak/read/remember gates (goldfish model)
        var chG = chKeyOf(args);
        if (!chG) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var gt = String((args && args.gate) || '');
        if (gt !== 'speak' && gt !== 'read' && gt !== 'remember') return Promise.resolve({ ok: false, reason: 'gate must be speak|read|remember' });
        var on = !!(args && args.on);
        var gk = 'chanGate:' + chG;
        var cur = cfgGet(gk, null);
        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) cur = {};
        if (on) delete cur[gt]; else cur[gt] = false;
        var left = Object.keys(cur).filter(function (k) { return cur[k] === false; });
        if (!left.length) GM_deleteValue(NS + 'cfg:' + gk); else cfgSet(gk, cur);
        // Targeted single-engine patch, NOT patchEngines (the setEngageMode broadcast flaw).
        var ge = engines[chG];
        if (ge && typeof ge.updateConfig === 'function') {
          try {
            var gp = {};
            gp.chanSpeak = chanGate(chG, 'speak'); gp.chanRead = chanGate(chG, 'read'); gp.chanRemember = chanGate(chG, 'remember');
            ge.updateConfig(gp);
          } catch (eG) {}
        }
        return Promise.resolve({ ok: true, value: { channelId: chG, gates: chanGatesFor(chG) } });
      }
      case 'config.setImageQueue': {
        var n = Math.max(1, Math.min(20, parseInt((args && args.max), 10) || 8));
        cfgSet('imageQueueMax', n); patchEngines({ imageQueueMax: n });
        return Promise.resolve({ ok: true, value: { imageQueueMax: n } });
      }
      case 'config.setAutoModRules': {
        var rules = (args && args.rules);
        if (!Array.isArray(rules)) return Promise.resolve({ ok: false, reason: 'rules must be an array' });
        var clean = [];
        rules.forEach(function (r) {
          if (clean.length >= 200) return;   // re-validate: array-length cap
          if (!r || !r.pattern) return;
          var type = (r.type === 'regex' || r.type === 'confusables' || r.type === 'link') ? r.type : 'text';
          var action = (r.action === 'timeout' || r.action === 'softban' || r.action === 'clear' || r.action === 'warn') ? r.action : 'ignore';  // reversible only ('warn' = escalate)
          var o = { pattern: String(r.pattern).slice(0, 500), type: type, action: action };
          if (r.durationMs) o.durationMs = Number(r.durationMs) || undefined;
          if (r.reason) o.reason = String(r.reason).slice(0, 500);
          clean.push(o);
        });
        cfgSet('autoModRules', clean); patchEngines({ autoModRules: clean });
        return Promise.resolve({ ok: true, value: { count: clean.length, rules: clean } });
      }
      case 'bridge.status':
        return Promise.resolve({ ok: true, value: { role: TAB_ROLE, tabId: tabBridge ? tabBridge.tabId : null, bus: !!tabBus, poolSize: cfgGet('poolSize', 0), workers: (tabBridge && TAB_ROLE === 'queen') ? tabBridge.workers() : {} } });
      case 'config.setGate': {
        var GKEYS = { emoji: true, pings: false, everyone: false, links: false, channelLinks: false };
        var gk = String((args && args.key) || '');
        if (!(gk in GKEYS)) return Promise.resolve({ ok: false, reason: 'unknown gate "' + gk + '" (emoji, pings, everyone, links, channelLinks)' });
        cfgSet('gate:' + gk, !!(args && args.on));
        return Promise.resolve({ ok: true, value: { key: gk, on: !!(args && args.on) } });
      }
      case 'config.setTimeAware':
        { var ta = !!(args && args.on); cfgSet('timeAware', ta);
          if (args && args.offsetMins != null && isFinite(args.offsetMins)) cfgSet('timezoneOffsetMins', Math.max(-840, Math.min(840, Math.round(args.offsetMins))));
          patchEngines({ timeAware: ta, timezoneOffsetMins: cfgGet('timezoneOffsetMins', 0) }); return Promise.resolve({ ok: true, value: { timeAware: ta, timezoneOffsetMins: cfgGet('timezoneOffsetMins', 0) } }); }
      case 'config.setUserLang':
        { var ulE = engineFor(args && args.channelId); if (!ulE) return Promise.resolve({ ok: false, reason: 'no channel' }); return ulE.setUserLang(args && args.id, (args && args.lang) || null).then(function (v) { return { ok: true, value: { lang: v } }; }); }
      case 'config.setDeviceTime':
        { var dtn = !!(args && args.on); cfgSet('deviceTime', dtn); if (!dtn) semInjectDrop('devicetime'); return Promise.resolve({ ok: true, value: { deviceTime: dtn } }); }   // not in LIVE_PATCHABLE: read fresh at use; the real effect is the 'devicetime' injection + deviceClock
      case 'config.setDeviceClock':
        { var dc = (args && args.clock) ? args.clock : null; var dcVal = dc ? { time: String(dc.time || ''), date: String(dc.date || ''), tz: String(dc.tz || ''), at: Date.now() } : null; if (dcVal) GM_setValue(NS + 'deviceClock', dcVal); else GM_deleteValue(NS + 'deviceClock'); patchEngines({ deviceClock: dcVal }); return Promise.resolve({ ok: true, value: { set: !!dc } }); }
      case 'config.setSemanticInjection':
        { var sid = String((args && args.id) || '').trim(); if (!sid) return Promise.resolve({ ok: false, reason: 'id required' });
          var txt = String((args && args.text) || '').trim().slice(0, 4000); if (!txt) { semInjectDrop(sid); patchEngines({ semanticInjections: semInjectList() }); return Promise.resolve({ ok: true, value: { id: sid, cleared: true } }); }   // re-validate: cap opNote/injection length (prompt-injection surface, client cap bypassable)
          semInjectUpsert({ id: sid, text: txt, priority: (args && args.priority) || null, ttlMs: ((args && args.ttlMs) > 0 ? args.ttlMs : null), at: Date.now() });
          patchEngines({ semanticInjections: semInjectList() }); return Promise.resolve({ ok: true, value: { id: sid } }); }
      case 'config.clearSemanticInjection':
        { var cid = String((args && args.id) || '').trim(); if (cid) semInjectDrop(cid); patchEngines({ semanticInjections: semInjectList() }); return Promise.resolve({ ok: true, value: { id: cid, cleared: true } }); }
      case 'config.setSemanticRecall':
        { var srn = !!(args && args.on); cfgSet('semanticRecall', srn); if (srn) embedLoader.preload(cfgGet('embedModel','Xenova/bge-small-en-v1.5')); patchEngines({ semanticRecall: srn }); return Promise.resolve({ ok: true, value: { semanticRecall: srn, embedder: embedLoader.state() } }); }
      case 'config.setExactTokens':
        { var etn = !!(args && args.on); cfgSet('exactTokens', etn); if (etn) tokLoader.preload(); patchEngines({ exactTokens: etn }); return Promise.resolve({ ok: true, value: { exactTokens: etn, tokenizer: tokLoader.state() } }); }
      case 'work.get':
        { var ew = engineFor(args && args.channelId); if (!ew) return Promise.resolve({ ok: true, value: null }); return ew.workLoad().then(function (w) { return { ok: true, value: w }; }); }
      case 'config.setProcRules': {
        // Validate + clean: [{ emoji, mode, minutes }] -> [{ emoji, mode (sanitized later by the
        // engine), durationMs }]. Hard caps here so malformed panel input can't smuggle anything in.
        var raw = (args && Array.isArray(args.rules)) ? args.rules : null;
        if (!raw) return Promise.resolve({ ok: false, reason: 'rules must be a JSON array' });
        var cleanPR = [];
        for (var pi = 0; pi < raw.length && cleanPR.length < 12; pi++) {
          var o = raw[pi]; if (!o || typeof o !== 'object') continue;
          var em = String(o.emoji || '').trim();
          var mode = String(o.mode || '').replace(/\s+/g, ' ').trim().slice(0, 100);
          var mins = Math.round(Number(o.minutes != null ? o.minutes : 60));
          if (!em || em.length > 8 || !mode) continue;            // a unicode emoji, not custom <:name:id>
          if (!(mins >= 1)) mins = 60;
          cleanPR.push({ emoji: em, mode: mode, durationMs: Math.min(mins, 1440) * 60000 });
        }
        cfgSet('procRules', cleanPR); patchEngines({ procRules: cleanPR });
        return Promise.resolve({ ok: true, value: { count: cleanPR.length, rules: cleanPR.map(function (r) { return { emoji: r.emoji, mode: r.mode, minutes: Math.round(r.durationMs / 60000) }; }) } });
      }
      case 'dm.open': {
        var duid = String((args && args.userId) || '').trim();
        if (!/^\d+$/.test(duid)) return Promise.resolve({ ok: false, reason: 'a numeric user id is required' });
        return transport.openDM(duid).then(function (dmId) {
          if (!dmId) return { ok: false, reason: 'could not open a DM (the bot must share a server with the user, and the user must allow DMs)' };
          recordDMSession(dmId, duid, (args && args.name) || '');
          if (cfgGet('dmReplies', true)) applyConfigChange();   // start polling the new DM
          var greeting = (args && args.message);
          if (greeting) return transport.sendMessage(dmId, String(greeting)).then(function () { return { ok: true, value: { dmChannelId: dmId, sent: true } }; });
          return { ok: true, value: { dmChannelId: dmId } };
        }, function (e) { return { ok: false, reason: 'openDM failed: ' + (e && e.message) }; });
      }
      case 'dm.list':
        return Promise.resolve({ ok: true, value: { dmReplies: !!cfgGet('dmReplies', true), sessions: dmSessions() } });
      case 'dm.forget': {
        var fch = String((args && args.dmChannelId) || '').trim();
        var s = dmSessions(); if (fch && s[fch]) { delete s[fch]; cfgSet('dmSessions', s); applyConfigChange(); }
        return Promise.resolve({ ok: true, value: { sessions: dmSessions() } });
      }
      case 'config.setPoolSize':
        { var ps = Math.max(0, Math.min(10, parseInt((args && args.size), 10) || 0)); cfgSet('poolSize', ps); return Promise.resolve({ ok: true, value: { poolSize: ps } }); }
      case 'bridge.spawn':
        { if (TAB_ROLE !== 'queen') return Promise.resolve({ ok: false, reason: 'only the queen spawns workers' }); return Promise.resolve(spawnWorker()); }
      case 'bridge.shutdown':
        { if (!tabBridge || TAB_ROLE !== 'queen') return Promise.resolve({ ok: false, reason: 'no bridge / not the queen' }); tabBridge.shutdownWorker(String((args && args.id) || '')); return Promise.resolve({ ok: true, value: { id: (args && args.id) || null } }); }
      case 'diag':
        { var snap = statusSnapshot(); try { if (snap && snap.operatorNote) snap.operatorNote = scrubPII(snap.operatorNote); } catch (e) {} console.log('[chloe] diag', snap); return Promise.resolve({ ok: true, value: snap }); }   // scrub any PII the operator may have pasted into the note
      case 'diag.trace':
        { var tr = traceRing.slice().concat([{ t: Date.now(), tag: 'link', msg: 'control-link: last=' + (linkStats.lastCmd || 'none') + ' ' + (linkStats.lastOutcome || '') + (linkStats.lastMs != null ? ' ' + linkStats.lastMs + 'ms' : '') + (linkStats.inflight ? (' | inflight=' + linkStats.inflight.cmd) : '') + ' | counts=' + JSON.stringify(linkStats.counts) }]);
          // Defense-in-depth: redact PII from every trace line before it leaves the engine (errBrief already keeps HTTP
          // bodies code-only, but a future trace could carry an IP/email/locale — this is the last gate before clipboard).
          var scrubbed = tr.map(function (e) { return { t: e.t, tag: e.tag, msg: scrubPII(e.msg) }; });
          return Promise.resolve({ ok: true, value: scrubbed }); }
      case 'diag.errors':
        { var errs7065 = errRing.slice().concat([{ t: Date.now(), tag: 'link', msg: 'control-link: last=' + (linkStats.lastCmd || 'none') + ' ' + (linkStats.lastOutcome || '') + (linkStats.lastMs != null ? ' ' + linkStats.lastMs + 'ms' : '') + (linkStats.inflight ? (' | inflight=' + linkStats.inflight.cmd) : '') + ' | counts=' + JSON.stringify(linkStats.counts) }]);
          var scrubbedErrs = errs7065.map(function (e) { return { t: e.t, tag: e.tag, msg: scrubPII(e.msg) }; });
          return Promise.resolve({ ok: true, value: scrubbedErrs }); }
      case 'token.prompt':    promptToken(); return Promise.resolve({ ok: true, value: { hasToken: hasToken() } });
      case 'token.validate':  return validate();
      case 'start':           { if (TAB_ROLE === 'worker') return Promise.resolve({ ok: false, reason: 'this tab is a worker \u2014 the engine (and the Discord transport) runs only in the queen tab' }); var es1 = ensureEngines(); if (!es1.length) return Promise.resolve({ ok: false, reason: 'no channel set' }); es1.forEach(function (e) { e.start(); }); cfgSet('autoResume', true); return Promise.resolve({ ok: true, value: statusSnapshot() }); }
      case 'stop':            eachEngine(function (e) { e.stop(); }); cfgSet('autoResume', false); return Promise.resolve({ ok: true, value: statusSnapshot() });
      case 'poll.once':       { var e2 = engineFor(args && args.channelId); if (!e2) return Promise.resolve({ ok: false, reason: 'no channel set' }); var pk = 'poll:' + (args && args.channelId); if (pollInflight[pk]) return pollInflight[pk].then(function (s) { return { ok: true, value: s, coalesced: true }; }); var pp = e2.pollOnce(); pollInflight[pk] = pp; return pp.then(function (s) { delete pollInflight[pk]; return { ok: true, value: s }; }, function (err) { delete pollInflight[pk]; return { ok: false, reason: (err && err.message) || 'poll failed' }; }); }
      case 'roster.get':      { var e3 = engineFor(args && args.channelId); if (!e3) return Promise.resolve({ ok: true, value: [] }); return e3.getRoster().then(function (r) { return { ok: true, value: r }; }); }
      case 'memory.get':        { var em1 = engineFor(args && args.channelId); if (!em1) return Promise.resolve({ ok: false, reason: 'no channel' }); return em1.getMemory(args && args.id).then(function (v) { return { ok: true, value: v }; }); }
      case 'memory.editFact':   { var em2 = engineFor(args && args.channelId); if (!em2) return Promise.resolve({ ok: false, reason: 'no channel' }); return em2.editFact(args && args.id, args && args.factId, { text: args && args.text, importance: args && args.importance }).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'not found' }; }); }
      case 'memory.deleteFact': { var em3 = engineFor(args && args.channelId); if (!em3) return Promise.resolve({ ok: false, reason: 'no channel' }); return em3.deleteFact(args && args.id, args && args.factId).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'not found' }; }); }
      case 'memory.addFact':    { var em4 = engineFor(args && args.channelId); if (!em4) return Promise.resolve({ ok: false, reason: 'no channel' }); return em4.addUserFact(args && args.id, args && args.text, args && args.importance, args && args.name).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'empty or failed' }; }); }
      case 'memory.editInsight':{ var em5 = engineFor(args && args.channelId); if (!em5) return Promise.resolve({ ok: false, reason: 'no channel' }); return em5.editInsight(args && args.id, args && args.insId, args && args.text).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'not found' }; }); }
      case 'memory.deleteInsight':{ var em6 = engineFor(args && args.channelId); if (!em6) return Promise.resolve({ ok: false, reason: 'no channel' }); return em6.deleteInsight(args && args.id, args && args.insId).then(function (v) { return v ? { ok: true, value: v } : { ok: false, reason: 'not found' }; }); }
      case 'context.excise':    { var ex1 = engineFor(args && args.channelId); if (!ex1) return Promise.resolve({ ok: false, reason: 'no channel' }); return ex1.exciseMessage(args && args.msgId).then(function (v) { return { ok: true, value: v }; }); }
      case 'context.exciseLast':{ var ex2 = engineFor(args && args.channelId); if (!ex2) return Promise.resolve({ ok: false, reason: 'no channel' }); return ex2.exciseLastFromUser(args && args.id, args && args.n).then(function (v) { return { ok: true, value: v }; }); }
      case 'ring.get':        { var e4 = engineFor(args && args.channelId); if (!e4) return Promise.resolve({ ok: true, value: [] }); return e4.getSpeakerRing().then(function (r) { return { ok: true, value: r }; }); }
      case 'reset':           return resetState(true).then(function () { return { ok: true }; });
      case 'factory-reset':   return factoryReset();
      case 'export-state':    return Promise.resolve({ ok: true, value: exportState() });
      case 'import-state':    return importState(args && args.data);
      // ---- T3 moderation: trusted (panel) actions + mod-list management ----
      case 'mod.action': {
        var act = String((args && args.action) || '');
        if (act === 'permaban') return Promise.resolve({ ok: false, reason: 'unimplemented (T4; irreversible purge requires a confirm in the trusted surface)' });
        var e5 = engineFor(args && args.channelId); if (!e5) return Promise.resolve({ ok: false, reason: 'no channel set' });
        return e5.applyModAction(act, String((args && args.id) || ''), { durationMs: args && args.durationMs, reason: args && args.reason, byModId: 'panel' });
      }
      case 'mod.listMods': return Promise.resolve({ ok: true, value: cfgGet('modList', []) });
      case 'mod.listBanned': {
        // Merge banned users across ALL channel engines (blocklist is per-store).
        var lbEngs = ensureEngines();
        if (!lbEngs.length) return Promise.resolve({ ok: true, value: [] });
        return Promise.all(lbEngs.map(function (eng) { return eng.listBlocked(); })).then(function (allBl) {
          var seen = {}, rows = [];
          allBl.forEach(function (bl) {
            Object.keys((bl && bl.ids) || {}).forEach(function (id) {
              if (!seen[id]) {
                seen[id] = true;
                var meta = bl.ids[id] || {};
                rows.push({ id: id, name: meta.name || id, reason: meta.reason || '', at: meta.at || null, by: meta.by || null });
              }
            });
          });
          rows.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
          return { ok: true, value: rows };
        });
      }
      case 'mod.unban': {
        var ubId = String((args && args.id) || '').trim();
        var ubName = String((args && args.name) || ubId);
        if (!ubId) return Promise.resolve({ ok: false, reason: 'no target id' });
        // Unblock across ALL channel engines — the blocklist is per-store (per channel),
        // so a ban on any channel must be lifted everywhere to fully unblock the user.
        var ubEngs = ensureEngines(); if (!ubEngs.length) return Promise.resolve({ ok: false, reason: 'no channels' });
        return Promise.all(ubEngs.map(function (eng) {
          return eng.unblockUser({ id: ubId, name: ubName });
        })).then(function (results) {
          var any = results.some(function (r) { return r && r.ok; });
          var e9 = engineFor(args && args.channelId) || ubEngs[0];
          if (any) e9.appendModLog({ action: 'unban', targetId: ubId, name: ubName, byModId: 'panel', reason: 'panel unban', at: Date.now() }).catch(function (e) { traceErr('mod', 'unban modlog append failed (' + ((e && e.message) || e) + ')'); });
          return { ok: true, value: { id: ubId, name: ubName, removedFrom: results.filter(function(r){return r&&r.ok;}).length } };
        });
      }
      case 'mod.addMod': {
        var idA = String((args && args.id) || '').trim(); if (!idA) return Promise.resolve({ ok: false, reason: 'no id' });
        var listA0 = cfgGet('modList', []); if (!Array.isArray(listA0)) listA0 = [];
        var isNewA = listA0.indexOf(idA) < 0;
        var listA = listA0.slice(); if (isNewA) listA.push(idA); cfgSet('modList', listA); patchEngines({ modList: listA });
        if (!isNewA) return Promise.resolve({ ok: true, value: listA });   // no mutation, nothing to undo
        // A8: record the add so undo can mechanically remove exactly this id.
        // A failed/absent undo target never fails the add itself.
        var addDone = Promise.resolve({ ok: true, value: listA });
        try {
          var eMA = engineFor((args && args.channelId) || primaryChannel());
          if (eMA && typeof eMA.pushUndoEntry === 'function') addDone = eMA.pushUndoEntry({ kind: 'modlist-add', targetId: idA.slice(0, 32), name: idA.slice(0, 64), by: 'panel', summary: 'added mod ' + idA.slice(0, 64), inverse: { id: idA } }).then(function () { return { ok: true, value: listA }; }, function () { return { ok: true, value: listA }; });
        } catch (eMAU) {}
        return addDone;
      }
      case 'mod.removeMod': {
        var idR = String((args && args.id) || '').trim();
        var listR0 = cfgGet('modList', []); if (!Array.isArray(listR0)) listR0 = [];
        var wasThereR = listR0.indexOf(idR) >= 0;
        var listR = listR0.filter(function (x) { return x !== idR; }); cfgSet('modList', listR); patchEngines({ modList: listR });
        if (!wasThereR) return Promise.resolve({ ok: true, value: listR });   // no mutation, nothing to undo
        // A8: record the removal so undo can mechanically restore exactly this id.
        var remDone = Promise.resolve({ ok: true, value: listR });
        try {
          var eMR = engineFor((args && args.channelId) || primaryChannel());
          if (eMR && typeof eMR.pushUndoEntry === 'function') remDone = eMR.pushUndoEntry({ kind: 'modlist-remove', targetId: idR.slice(0, 32), name: idR.slice(0, 64), by: 'panel', summary: 'removed mod ' + idR.slice(0, 64), inverse: { id: idR } }).then(function () { return { ok: true, value: listR }; }, function () { return { ok: true, value: listR }; });
        } catch (eMRU) {}
        return remDone;
      }
      case 'mod.modlog': {
        var e6 = engineFor(args && args.channelId); if (!e6) return Promise.resolve({ ok: true, value: [] });
        return e6.getModLog().then(function (l) { return { ok: true, value: l }; });
      }
      case 'mod.verifyLog': {
        // A3: tamper-evident check over the channel modlog (read-only).
        var eV = engineFor(args && args.channelId); if (!eV) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eV.verifyModLog !== 'function') return Promise.resolve({ ok: true, value: { ok: true, chained: 0, preChain: 0, legacy: true } });
        return eV.verifyModLog().then(function (v) { return { ok: true, value: v }; });
      }
      // ---- A2: import dry-run + quarantine ----------------------------------
      // Rule/behavior sets (beats, autoModRules, procRules) never direct-write
      // on import — they ride the quarantine stash until a mod releases them.
      case 'import-preview': {
        return Promise.resolve(previewImport(args && args.data));
      }
      case 'quarantine-release': {
        var qkind = String((args && args.kind) || 'all').toLowerCase();
        var stash = quarantineStash();
        if (!stash) return Promise.resolve({ ok: false, reason: 'nothing held for review' });
        var qks = (qkind === 'all' || qkind === 'kind') ? ['beats', 'autoModRules', 'procRules']
          : (['beats', 'autoModRules', 'procRules'].indexOf(qkind) >= 0 ? [qkind] : null);
        if (!qks) return Promise.resolve({ ok: false, reason: 'unknown set "' + qkind + '" (beats, autoModRules, procRules, all)' });
        // A8: snapshot priors + released sets BEFORE the setters overwrite live cfg.
        var qPriors = {}, qRelSnap = {};
        qks.forEach(function (k) {
          if (!Array.isArray(stash[k]) || !stash[k].length) return;
          qRelSnap[k] = stash[k].slice();
          var qpv = cfgGet(k, null);
          qPriors[k] = Array.isArray(qpv) ? qpv.slice() : null;
        });
        var chainQR = Promise.resolve({ released: [], failed: [] });
        qks.forEach(function (k) {
          if (!Array.isArray(stash[k]) || !stash[k].length) return;
          chainQR = chainQR.then(function (acc) {
            var cmd = k === 'beats' ? 'config.setBeats' : (k === 'autoModRules' ? 'config.setAutoModRules' : 'config.setProcRules');
            var a = {}; a[k === 'beats' ? 'beats' : 'rules'] = stash[k];
            return dispatch(cmd, a).then(function (r) {
              if (r && r.ok) { delete stash[k]; acc.released.push(k); }
              else acc.failed.push(k);
              return acc;
            });
          });
        });
        return chainQR.then(function (acc) {
          try {
            var left = ['beats', 'autoModRules', 'procRules'].filter(function (k) { return Array.isArray(stash[k]); });
            if (left.length) GM_setValue(NS + QUARANTINE_STORE_KEY, stash);
            else GM_deleteValue(NS + QUARANTINE_STORE_KEY);
          } catch (eQ) {}
          if (acc.failed.length) return { ok: false, reason: 'release failed validation for: ' + acc.failed.join(', ') };
          bLog('[chloe] quarantine released: ' + (acc.released.join(', ') || 'nothing held'));
          var qRes = { ok: true, value: { released: acc.released, remaining: quarantineSummary() } };
          if (!acc.released.length) return qRes;
          // A8: record the release so undo can restore priors + re-hold the sets.
          // A failed/absent undo target never fails the release itself.
          var qRel = {}, qBef = {};
          acc.released.forEach(function (k) { if (qRelSnap[k]) qRel[k] = qRelSnap[k]; if (Object.prototype.hasOwnProperty.call(qPriors, k)) qBef[k] = qPriors[k]; });
          try {
            var eQR = engineFor(primaryChannel());
            if (eQR && typeof eQR.pushUndoEntry === 'function') return eQR.pushUndoEntry({ kind: 'quarantine-release', by: 'panel', summary: 'released ' + acc.released.join(', ') + ' from quarantine', inverse: { released: qRel, before: qBef } }).then(function () { return qRes; }, function () { return qRes; });
          } catch (eQRP) {}
          return qRes;
        });
      }
      case 'quarantine-drop': {
        var qd = String((args && args.kind) || 'all').toLowerCase();
        var stashD = quarantineStash();
        if (!stashD) return Promise.resolve({ ok: false, reason: 'nothing held for review' });
        if (qd !== 'all' && ['beats', 'autoModRules', 'procRules'].indexOf(qd) < 0) return Promise.resolve({ ok: false, reason: 'unknown set "' + qd + '" (beats, autoModRules, procRules, all)' });
        var droppedQ = [];
        // A8: snapshot the condemned sets BEFORE deleting (undo re-holds them).
        var qDropSnap = {};
        (qd === 'all' ? ['beats', 'autoModRules', 'procRules'] : [qd]).forEach(function (k) {
          if (Array.isArray(stashD[k])) { droppedQ.push(k + ' (' + stashD[k].length + ')'); qDropSnap[k] = stashD[k].slice(); delete stashD[k]; }
        });
        try {
          var leftD = ['beats', 'autoModRules', 'procRules'].filter(function (k) { return Array.isArray(stashD[k]); });
          if (leftD.length) GM_setValue(NS + QUARANTINE_STORE_KEY, stashD);
          else GM_deleteValue(NS + QUARANTINE_STORE_KEY);
        } catch (eQD) {}
        bLog('[chloe] quarantine dropped: ' + (droppedQ.join(', ') || 'nothing held'));
        var qdRes = Promise.resolve({ ok: true, value: { dropped: droppedQ, remaining: quarantineSummary() } });
        if (!droppedQ.length) return qdRes;
        // A8: record the drop so undo can re-hold the destroyed sets.
        try {
          var eQD2 = engineFor(primaryChannel());
          if (eQD2 && typeof eQD2.pushUndoEntry === 'function') qdRes = eQD2.pushUndoEntry({ kind: 'quarantine-drop', by: 'panel', summary: 'dropped ' + droppedQ.join(', ') + ' from quarantine', inverse: { dropped: qDropSnap } }).then(function () { return { ok: true, value: { dropped: droppedQ, remaining: quarantineSummary() } }; }, function () { return { ok: true, value: { dropped: droppedQ, remaining: quarantineSummary() } }; });
        } catch (eQDP) {}
        return qdRes;
      }
      // ---- A1/A4: actuation policy + approvals --------------------------------
      case 'config.setActPolicy': {
        var pol = String((args && args.policy) || '').toLowerCase();
        if (pol !== 'allow' && pol !== 'ask' && pol !== 'deny') return Promise.resolve({ ok: false, reason: 'policy must be allow|ask|deny' });
        var polBefore = cfgGet('actPolicy', 'allow');
        polBefore = (polBefore === 'ask' || polBefore === 'deny') ? polBefore : 'allow';
        cfgSet('actPolicy', pol); patchEngines({ actPolicy: pol });
        // A6: the panel path records its own undo entry (the engine can't see wiring-side cfgSets).
        try {
          var eP = engineFor((args && args.channelId) || primaryChannel());
          if (eP && typeof eP.pushUndoEntry === 'function') eP.pushUndoEntry({ kind: 'policy', by: 'panel', summary: 'policy ' + polBefore + ' -> ' + pol, inverse: { before: polBefore, after: pol } });
        } catch (ePU) {}
        bLog('[chloe] actuation policy: ' + pol + (pol === 'ask' ? ' (autonomous beats/check-ins/lull will hold for approval)' : pol === 'deny' ? ' (no proactive output)' : ' (proactive output fires freely)'));
        return Promise.resolve({ ok: true, value: { actPolicy: pol } });
      }
      case 'act.approve': {
        var eA = engineFor(args && args.channelId); if (!eA) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eA.approveAct !== 'function') return Promise.resolve({ ok: false, reason: 'approvals need the latest engine — reload the panel and Stop+Start the bot' });
        var alwaysA = !!(args && args.always);
        return eA.approveAct((args && args.id) || 'all', alwaysA, 'panel').then(function (r) {
          if (!r.approved.length) return { ok: false, reason: 'nothing held' + ((args && args.id && args.id !== 'all') ? ' with that id' : '') };
          // merge always-grants into cfg (dedupe identical action+resource+scope)
          if (r.grants && r.grants.length) {
            var cur = cfgGet('actGrants', []); if (!Array.isArray(cur)) cur = [];
            r.grants.forEach(function (g) {
              if (!cur.some(function (e) { return e && e.action === g.action && e.resource === g.resource && e.scope === g.scope; })) cur.push(g);
            });
            cfgSet('actGrants', cur); patchEngines({ actGrants: cur });
          }
          return { ok: true, value: { approved: r.approved, classes: r.classes, granted: (r.grants || []).length } };
        });
      }
      case 'act.dismiss': {
        var eD = engineFor(args && args.channelId); if (!eD) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eD.dismissAct !== 'function') return Promise.resolve({ ok: false, reason: 'approvals need the latest engine — reload the panel and Stop+Start the bot' });
        return eD.dismissAct((args && args.id) || 'all', 'panel').then(function (r) {
          if (!r.dismissed.length) return { ok: false, reason: 'nothing held' };
          return { ok: true, value: { dismissed: r.dismissed } };
        });
      }
      case 'act.revokeGrant': {
        var ra = String((args && args.action) || '').toLowerCase();
        var rr = String((args && args.resource) || '');
        var curG = cfgGet('actGrants', []); if (!Array.isArray(curG)) curG = [];
        var kept = curG.filter(function (g) { return !(g && g.action === ra && (rr === '*' || g.resource === rr)); });
        if (kept.length === curG.length) return Promise.resolve({ ok: false, reason: 'no matching grant' });
        var removed = curG.filter(function (g) { return g && g.action === ra && (rr === '*' || g.resource === rr); });
        cfgSet('actGrants', kept); patchEngines({ actGrants: kept });
        // A6: record the revocation so undo can restore the exact grants.
        try {
          var eR = engineFor((args && args.channelId) || primaryChannel());
          if (eR && typeof eR.pushUndoEntry === 'function') eR.pushUndoEntry({ kind: 'grant-remove', by: 'panel', summary: 'revoked ' + removed.length + ' grant(s) (' + ra + ' @ ' + rr + ')', inverse: { grants: removed } });
        } catch (eRU) {}
        bLog('[chloe] grant revoked: ' + ra + ' @ ' + rr);
        return Promise.resolve({ ok: true, value: { revoked: curG.length - kept.length } });
      }
      case 'act.why': {
        var eW = engineFor(args && args.channelId); if (!eW) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eW.actWhy !== 'function') return Promise.resolve({ ok: false, reason: 'why-silent needs the latest engine — reload the panel and Stop+Start the bot' });
        return eW.actWhy().then(function (w) { return { ok: true, value: w }; });
      }
      case 'act.whatif': {
        var pW = String((args && args.policy) || '').toLowerCase();
        if (pW !== 'allow' && pW !== 'ask' && pW !== 'deny') return Promise.resolve({ ok: false, reason: 'policy must be allow|ask|deny' });
        var eX = engineFor(args && args.channelId); if (!eX) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eX.actWhatIf !== 'function') return Promise.resolve({ ok: false, reason: 'what-if needs the latest engine — reload the panel and Stop+Start the bot' });
        return eX.actWhatIf(pW).then(function (r) { return { ok: r.ok !== false, value: r }; });
      }
      // ---- A6/A7: undo + clearance ----------------------------------------------
      // Undo pops the channel stack engine-side; global side-effects (policy/grants/
      // modList) come back as persist descriptors the queen applies here.
      case 'act.undo': {
        var eU = engineFor(args && args.channelId); if (!eU) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eU.undoLastApplied !== 'function') return Promise.resolve({ ok: false, reason: 'undo needs the latest engine — reload the panel and Stop+Start the bot' });
        return eU.undoLastApplied().then(function (r) {
          if (!r.ok) return { ok: false, reason: r.reason };
          if (r.persist) {
            if (r.persist.actPolicy !== undefined) { var __up = (r.persist.actPolicy === 'ask' || r.persist.actPolicy === 'deny') ? r.persist.actPolicy : 'allow'; cfgSet('actPolicy', __up); patchEngines({ actPolicy: __up }); }
            if (r.persist.actGrants !== undefined) { cfgSet('actGrants', r.persist.actGrants); patchEngines({ actGrants: r.persist.actGrants }); }
            if (r.persist.modList !== undefined) { var __um = cleanModListIds(r.persist.modList); cfgSet('modList', __um); patchEngines({ modList: __um }); }
            // A8: quarantine-release undo — restore live sets + re-hold the released ones.
            ['beats', 'autoModRules', 'procRules'].forEach(function (qk) {
              if (r.persist[qk] !== undefined) {
                if (r.persist[qk] == null) { try { GM_deleteValue(NS + 'cfg:' + qk); } catch (eQB) {} }
                else cfgSet(qk, r.persist[qk]);
                var __pe = {}; __pe[qk] = r.persist[qk]; patchEngines(__pe);
              }
            });
            if (r.persist.restash !== undefined) restashQuarantine(r.persist.restash);
          }
          bLog('[chloe] undid: ' + r.summary);
          return { ok: true, value: { undone: r.summary } };
        });
      }
      case 'clearance.get': {
        var eC = engineFor(args && args.channelId); if (!eC) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eC.clearanceOf !== 'function') return Promise.resolve({ ok: false, reason: 'clearance needs the latest engine — reload the panel and Stop+Start the bot' });
        return eC.clearanceOf(String((args && args.id) || '')).then(function (t) { return { ok: true, value: t }; });
      }
      case 'clearance.elevate': {
        var eE = engineFor(args && args.channelId); if (!eE) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eE.elevateUser !== 'function') return Promise.resolve({ ok: false, reason: 'clearance needs the latest engine — reload the panel and Stop+Start the bot' });
        return eE.elevateUser(String((args && args.id) || ''), String((args && args.name) || ''), 'panel', {}).then(function (r) {
          if (!r.ok) return { ok: false, reason: r.reason };
          if (r.persist && r.persist.modList !== undefined) { var __em = cleanModListIds(r.persist.modList); cfgSet('modList', __em); patchEngines({ modList: __em }); }
          bLog('[chloe] elevated ' + (String((args && args.name) || '') || String((args && args.id) || '')) + ' to ' + r.tier);
          return { ok: true, value: { tier: r.tier } };
        });
      }
      case 'clearance.demote': {
        var eM = engineFor(args && args.channelId); if (!eM) return Promise.resolve({ ok: false, reason: 'no channel set' });
        if (typeof eM.demoteUser !== 'function') return Promise.resolve({ ok: false, reason: 'clearance needs the latest engine — reload the panel and Stop+Start the bot' });
        return eM.demoteUser(String((args && args.id) || ''), 'panel', {}).then(function (r) {
          if (!r.ok) return { ok: false, reason: r.reason };
          if (r.persist && r.persist.modList !== undefined) { var __dm = cleanModListIds(r.persist.modList); cfgSet('modList', __dm); patchEngines({ modList: __dm }); }
          bLog('[chloe] demoted ' + (String((args && args.name) || '') || String((args && args.id) || '')) + ' to ' + r.tier);
          return { ok: true, value: { tier: r.tier } };
        });
      }
      // T4 logging helper: console.log + pushEvent so messages appear in BOTH the browser console
      // and the panel feed (classified as MODERATION by the [chloe.T4] prefix).
      // T4: Discord ban + local prune. Local prune (block + purge) always runs whether or not the
      // Discord server ban succeeds — so the operator always gets a clean local state. A failed or
      // unavailable Discord ban is logged but never blocks the purge.
      case 'mod.permaban': {
        var pid = String((args && args.id) || '').trim();
        var pname = String((args && args.name) || pid);
        var preason = (args && args.reason) || 'Chloe permaban';
        if (!pid) return Promise.resolve({ ok: false, reason: 'no target' });
        var e7 = engineFor(args && args.channelId); if (!e7) return Promise.resolve({ ok: false, reason: 'no channel set' });
        var sure = false;
        try { sure = window.confirm('PRUNE "' + pname + '"?\n\nThis permanently blocks their user ID and deletes everything Chloe remembers about them. This cannot be undone.'); } catch (e) { sure = false; }
        if (!sure) { bLog('[chloe.T4] prune of ' + pname + ' cancelled'); return Promise.resolve({ ok: false, reason: 'cancelled' }); }
        // Local prune only: block the user ID + purge memory.
        // Discord server-level ban intentionally disabled. To re-enable, see ROADMAP.md v0.76.9.
        return e7.blockUser({ id: pid, name: pname, reason: preason, byModId: 'panel' }).then(function () {
          return e7.purge(pid, { targetName: pname });
        }).then(function (pr) {
          if (!pr || !pr.ok) { bLog('[chloe.T4] PURGE NOT VERIFIED for ' + pname + ': ' + (pr && pr.reason)); return { ok: false, reason: (pr && pr.reason) || 'purge failed' }; }
          return e7.appendModLog({ action: 'local-prune', targetId: pid, name: pname, byModId: 'panel', reason: preason, at: Date.now() }).then(function () {
            bLog('[chloe.T4] prune complete for ' + pname + ' (blocked + purged)');
            return { ok: true, value: { purged: true, verified: true, name: pname } };
          });
        });
      }
      case 'rescue':
        { brainMeter.reset(); var rN = 0; eachEngine(function (e) { try { if (e && typeof e.rescueStuck === 'function') { e.rescueStuck('manual rescue from the panel'); rN++; } } catch (rE) { traceErr('rescue', 'engine rescue failed (' + ((rE && rE.message) || rE) + ')'); } });
          trace('rescue', 'manual rescue: brain breaker reset, ' + rN + ' engine(s) cleared');
          return Promise.resolve({ ok: true, value: { engines: rN } }); }
      default:                return Promise.resolve({ ok: false, reason: 'unknown command: ' + cmd });
    }
  }
  function onPanelEvent(ev) {
    var d = ev.data;
    if (!d || d.__chloe !== 1) return;
    if (!ORIGIN_OK.test(ev.origin)) { trace('link', 'rejected chloe-shaped message from disallowed origin ' + ev.origin); return; }
    // capture/refresh the control page window so the engine can call its brain
    if (!pageSource) trace('link', 'control page connected from ' + ev.origin);
    pageSource = ev.source; pageOrigin = ev.origin;
    // Self-heal a mis-captured tab: receiving a page message means THIS tab hosts a generator panel a
    // user is actively using — a real control surface, not a background-spawned worker. If it somehow
    // booted as a worker (e.g. a stale '#chloe-worker' left in the URL by an older build), shed that
    // role: strip the hash and stand for the queen election so the engine can actually run here.
    if (TAB_ROLE === 'worker' && !workerSelfHealTried) {
      workerSelfHealTried = true;
      try { if (/chloe-worker/.test(location.hash || '')) history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
      // Contest the election. onPromote flips TAB_ROLE to 'queen' if this tab wins (no live queen);
      // if a real queen exists this stays a worker, but at least the stale URL hash is cleaned so a
      // future reload doesn't boot as a worker again.
      try {
        if (tabBridge && typeof tabBridge.standForQueen === 'function') tabBridge.standForQueen();
        else { TAB_ROLE = 'queen'; }   // no bus/bridge (single-tab) — just reclaim
      } catch (e) {}
      trace('bridge', 'a panel is attached to a worker-roled tab — cleaned stale worker hash and contested the queen election');
      bLog('[chloe-bridge] this tab hosts the control panel but had a stale worker role; reclaiming.');
    }
    if (d.kind === 'callres') { var cb = callPending.get(d.nonce); if (cb) { callPending.delete(d.nonce); cb(d); } return; }
    if (d.kind !== 'req') return;
    var nonce = d.nonce, source = ev.source, origin = ev.origin;
    // The page now fans a request out to several candidate frames so it reaches us regardless of
    // embed topology. If more than one copy reaches this listener, handle the FIRST and drop the
    // rest SILENTLY — sending a second (e.g. {ok:true,value:null}) reply could win the race on the
    // page and clobber the real result (this broke Validate Token: res.value was null).
    if (nonce) {
      if (seenReqNonces.has(nonce)) return;   // duplicate fan-out copy: ignore, the first copy replies
      seenReqNonces.add(nonce);
      if (seenReqNonces.size > 400) { var it = seenReqNonces.values().next(); if (!it.done) seenReqNonces.delete(it.value); }
    }
    var linkAt = Date.now(); linkStats.inflight = { cmd: d.cmd, at: linkAt };
    linkStats.counts[d.cmd] = (linkStats.counts[d.cmd] || 0) + 1;
    Promise.resolve().then(function () { return dispatch(d.cmd, d.args); })
      .then(function (res) { res = res || { ok: false, reason: 'no result' }; res.__chloe = 1; res.kind = 'res'; res.nonce = nonce; var ms = Date.now() - linkAt; var out = (res && res.ok) ? 'replied-ok' : 'replied-fail'; linkStats.lastCmd = d.cmd; linkStats.lastAt = linkAt; linkStats.lastMs = ms; linkStats.lastOutcome = out; linkStats.inflight = null; linkTraceSlow(d.cmd, ms, out); sendRes(source, origin, res); })
      .catch(function (err) { var ms2 = Date.now() - linkAt; linkStats.lastCmd = d.cmd; linkStats.lastAt = linkAt; linkStats.lastMs = ms2; linkStats.lastOutcome = 'replied-error'; linkStats.inflight = null; linkTraceSlow(d.cmd, ms2, 'replied-error'); traceErr('dispatch', '"' + d.cmd + '" failed: ' + String(err && err.message || err)); sendRes(source, origin, { __chloe: 1, kind: 'res', nonce: nonce, ok: false, reason: String(err && err.message || err) }); });
  }

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
      poolTarget: function () { return cfgGet('poolSize', 0) | 0; },   // D7: 0 = manual-only (default)
      doSpawn: function () { var r = spawnWorker(); return !!(r && r.ok); },
      capable: function () { return !!pageSource; },   // can this tab actually run a brain job (has a linked control page)?
      spawnBackoffMs: cfgGet('spawnBackoffMs', 20000),
      log: function (m) { trace('bridge', m); },
      onWorkerJoin: function (id) { trace('bridge', 'worker joined: ' + id); },
      onWorkerLost: function (id, why) { trace('bridge', 'worker lost: ' + id + ' (' + why + ')'); },
      onShutdown: function () { try { window.close(); } catch (e) { trace('bridge', 'self-close blocked'); } },
      // D6: this tab won the election after the queen tab died.
      onPromote: function () {
        TAB_ROLE = 'queen';
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
        trace('bridge', 'PROMOTED to queen' + (cfgGet('autoResume', false) ? ' \u2014 resuming the engine(s)' : ''));
        bLog('[chloe-bridge] this tab was promoted to QUEEN (the previous queen tab went silent).');
        if (cfgGet('autoResume', false)) { try { ensureEngines().forEach(function (e) { e.start(); }); } catch (e) { trace('bridge', 'auto-resume failed: ' + (e && e.message)); } }
      },
      // D6: a lease conflict said another tab is queen — stand down completely.
      onDemote: function () {
        TAB_ROLE = 'worker';
        eachEngine(function (e) { e.stop(); });
        // NOTE: we deliberately do NOT write location.hash here. Role is in-memory state. Stamping
        // '#chloe-worker' into the URL is sticky (TAB_ROLE is read from the hash at load), so it would
        // permanently convert an ordinary perchance tab — or the Chloe generator itself — into a worker
        // that can never start the engine. That mis-capture made the bot look dead/"not detected".
        trace('bridge', 'demoted to worker (another queen holds the lease); engines stopped');
      }
    });
    // Every tab registers job handlers: a worker serves them now; a queen may be demoted later
    // (sleep/wake revival) and must be able to serve them then.
    tabBridge.onJob('echo', function (args) { return Promise.resolve(args == null ? null : args); });
    tabBridge.onJob('brain', function (p) {
      p = p || {};
      // If this worker has no control page, REJECT so the queen's dispatchJob fallback runs the call
      // on a page-having tab. Resolving {ok:false} here would look like a successful empty answer and
      // the reply/paint would be silently dropped.
      if (!pageSource) return Promise.reject(new Error('worker has no control page'));
      return callPage(String(p.kind || 'respond'), p.args || {}, p.timeoutMs || 40000).then(function (res) {
        if (res && res.ok === false && /no control page/.test(String(res.reason || ''))) throw new Error('worker lost its control page');
        return res;
      });
    });
    tabBridge.start();
    tickTimer = setInterval(function () { tabBridge.tick(); }, 5000);   // host-driven time; the queen tab is the foreground tab
  } else {
    trace('bridge', 'no bus available (BroadcastChannel + GM listener both missing) \u2014 single-tab mode');
  }
  helloTimer = setInterval(function () { try { pushEvent('hello', { version: VERSION, role: TAB_ROLE, at: Date.now(), running: (function () { try { var es = ensureEngines(); for (var i = 0; i < es.length; i++) { if (es[i].isRunning && es[i].isRunning()) return true; } return false; } catch (e) { return null; } })(), link: linkSnapshot() }); } catch (e) {} }, 15000);
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
    var s = tokenShape(t); bLog('[chloe] token saved — shape: ' + JSON.stringify(s));
    if (s.placeholder || s.parts !== 3) bLog('[chloe] WARNING: does not look like a bot token (expect ~70+ chars, 3 dot-parts).');
  }
  function resetState(silent) {
    if (!silent && !confirm('Reset state (cursor, roster, ring) for ALL channels? Token is NOT touched.')) return Promise.resolve();
    var chain = Promise.resolve();
    channelList().forEach(function (ch) {
      var pfx = prefixFor(ch), st = makeStore(pfx);
      chain = chain.then(function () {
        return st.listIndex().then(function (ids) {
          (ids || []).forEach(function (id) { GM_deleteValue(NS + pfx + 'u:' + id); });
          // clear archived ("historical friend") users too, via their index
          var archIdx = []; try { var aj = JSON.parse(GM_getValue(NS + pfx + 'arch:index:' + ch, '[]')) || []; archIdx = Array.isArray(aj) ? aj : []; } catch (e) {}
          archIdx.forEach(function (id) { GM_deleteValue(NS + pfx + 'arch:' + ch + ':u:' + id); });
          // every per-channel state key (kept in sync with the engine's *_KEY set) so a reset is a true clean slate
          ['cursor:' + ch, 'roster:index', 'speaker:ring:' + ch, 'rhythm:' + ch, 'mood:' + ch,
           'intent:' + ch, 'reminders:' + ch, 'afk:' + ch, 'highlights:' + ch, 'reacttally:' + ch,
           'lull:' + ch, 'checkins:' + ch, 'beats:lastrun:' + ch, 'selfintents:' + ch, 'ownlines:' + ch, 'feedback:' + ch, 'todos:' + ch, 'skills:' + ch, 'arch:index:' + ch,
           'games:' + ch, 'wordle:' + ch, 'wordlestats:' + ch,
           'pendingact:' + ch, 'approveonce:' + ch, 'actsnooze:' + ch, 'actlog:' + ch,
           'undostack:' + ch,
           'modlog', 'backfill:' + ch, 'blocklist'].forEach(function (k) { GM_deleteValue(NS + pfx + k); });
          GM_deleteValue(NS + 'cfg:backfillDone:' + ch);
        });
      });
    });
    return chain.then(function () { eachEngine(function (e) { e.stop(); }); engines = {}; lastPoll = null; bLog('[chloe] state reset for all channels.'); });
  }
  // ---- factory reset (wipes EVERYTHING including cfg, keeps token by default) ----------
  function factoryReset() {
    // First do the standard state reset (partitions, cursors, rings...)
    return resetState(true).then(function () {
      // Then wipe all cfg keys except the token (keeps the bot connected)
      var keep = ['token'];
      var allCfg = [
        'botUserId','botName','botAliases','botRoleIds','channelId','channels','dmChannels','addressMode','engageMode',
        'volunteer','greet','backfill','memberCheck','image','imageQueueMax','imageMemory','imageEnhanceOffer','ackReactions','singleParagraph','toolsEnabled','converseEngine','trustHardening','bondLadder',
        'lullFiller','checkins','lullPatienceMs','lullMinGapMs','checkinMinInteractions',
        'checkinAbsenceMs','checkinPerUserGapMs','checkinGapMs','checkinFavorites','checkinBlacklist',
        'factMemory','moodAware','channelSummary','adaptivePace',
        'workingMemory','idleDeliberation','attentionManager','selfKnowledge','cleanOutput',
        'translate','deviceTime','exactTokens','episodeGraph','idleConsolidation','goalObjects',
        'reflection','episodicMemory','relationshipTrust','ownAffect','proceduralModes',
        'reactionSummon','hamRadio','autoMod','autoModRules','commandPrefixes','beats','procRules',
        'actPolicy','actGrants',
        'modList','serverMemberCount','timeAware','timezoneOffsetMins','personality',
        'character','personaAnchor','noticeText','noticeMsgId','noticePinned','dmReplies','dmSessions','poolSize',
        'sendBudgetMs','sendMinGapMs','requestTokenBudget','typingRefreshMs','pollBusyCeilMs',
        'spawnBackoffMs','strikeDecayMs','strikeLadder','queenDeadAfterMs','archiveStale',
        'reactionTracking','reactionAutoHighlight','gateEmoji','gatePings','gateEveryone',
        'gateLinks','gateChannelLinks','autoResume','gate:emoji','gate:pings','gate:everyone',
        'gate:links','gate:channelLinks','todoMaxPerUser','todoTextMax'
      ];
      allCfg.forEach(function (k) {
        if (keep.indexOf(k) < 0) GM_deleteValue(NS + 'cfg:' + k);
      });
      // Wipe top-level non-cfg keys (seminject, deviceClock, guildId cache, bus token, queen lease)
      GM_deleteValue(NS + 'seminject:map');
      GM_deleteValue(NS + 'deviceClock');
      GM_deleteValue(NS + 'blocklist');   // primary channel blocklist (prefix '')
      // guildId: keys are per-channel — wipe them all via known channels
      channelList().forEach(function (ch) { GM_deleteValue(NS + 'guildId:' + ch); });
      // Per-channel keys (v0.90.21 — same hole as export: exact-name lists can't enumerate
      // per-channel suffixes, so a reset left stale engageMode:<id> behind).
      channelList().forEach(function (ch) { GM_deleteValue(NS + 'cfg:engageMode:' + ch); GM_deleteValue(NS + 'cfg:channelLang:' + ch); GM_deleteValue(NS + 'cfg:chanGate:' + ch); });
      eachEngine(function (e) { e.stop(); }); engines = {}; lastPoll = null;
      bLog('[chloe] factory reset complete — all state and config cleared (token kept).');
      return { ok: true };
    });
  }

  // ---- export: collect all known GM keys into a snapshot object ----------------------
  // v0.90.18: single source of truth for which cfg keys may cross the backup boundary.
  // exportState writes exactly these; sanitizeImport (below) accepts exactly these —
  // nothing else, notably never the token. One list so the two can never drift apart.
  var BACKUP_CFG_KEYS = [
      'botUserId','botName','botAliases','botRoleIds','channelId','channels','dmChannels','addressMode','engageMode',
      'volunteer','greet','backfill','memberCheck','image','imageQueueMax','imageMemory','imageEnhanceOffer','ackReactions','singleParagraph','toolsEnabled','converseEngine','trustHardening','bondLadder',
      'lullFiller','checkins','lullPatienceMs','lullMinGapMs','checkinMinInteractions',
      'checkinAbsenceMs','checkinPerUserGapMs','checkinGapMs','checkinFavorites','checkinBlacklist',
      'factMemory','moodAware','channelSummary','adaptivePace',
      'workingMemory','idleDeliberation','attentionManager','selfKnowledge','cleanOutput',
      'translate','deviceTime','exactTokens','episodeGraph','idleConsolidation','goalObjects',
      'reflection','episodicMemory','relationshipTrust','ownAffect','proceduralModes',
      'reactionSummon','hamRadio','autoMod','autoModRules','commandPrefixes','beats','procRules',
      'actPolicy','actGrants',
      'modList','serverMemberCount','timeAware','timezoneOffsetMins','personality',
      'character','personaAnchor','noticeText','dmReplies','dmSessions','poolSize',
      'sendBudgetMs','sendMinGapMs','requestTokenBudget','typingRefreshMs','pollBusyCeilMs',
      'spawnBackoffMs','strikeDecayMs','strikeLadder','queenDeadAfterMs','archiveStale',
      'reactionTracking','reactionAutoHighlight','gate:emoji','gate:pings','gate:everyone',
      'gate:links','gate:channelLinks','autoResume','todoMaxPerUser','todoTextMax'
    ];
  function exportState() {
    var snap = { _version: VERSION, _exported: new Date().toISOString(), _note: 'Chloe-bot state backup. Token is NOT included. Import via the panel System tab.' };
    // cfg keys (BACKUP_CFG_KEYS — everything except the token, which is never listed there)
    var cfgKeys = BACKUP_CFG_KEYS;
    var cfg = {};
    cfgKeys.forEach(function (k) { var v = GM_getValue(NS + 'cfg:' + k, null); if (v != null) cfg[k] = v; });
    // Per-channel keys (v0.90.21 — fixes the pre-existing hole where engageMode:<id> never
    // survived backup: exact-name allowlists can't enumerate per-channel suffixes, so snapshot
    // them dynamically for the known channels).
    channelList().forEach(function (ch) {
      ['engageMode:', 'channelLang:'].forEach(function (p) {
        var v = GM_getValue(NS + 'cfg:' + p + ch, null);
        if (v != null) cfg[p + ch] = v;
      });
      var cg = GM_getValue(NS + 'cfg:chanGate:' + ch, null);
      if (cg && typeof cg === 'object' && !Array.isArray(cg) && (cg.speak === false || cg.read === false || cg.remember === false)) cfg['chanGate:' + ch] = cg;
    });
    snap.cfg = cfg;
    // top-level keys
    var tl = {};
    var tlKeys = ['seminject:map','deviceClock'];
    tlKeys.forEach(function (k) { var v = GM_getValue(NS + k, null); if (v != null) tl[k] = v; });
    channelList().forEach(function (ch) { var v = GM_getValue(NS + 'guildId:' + ch, null); if (v != null) tl['guildId:' + ch] = v; });
    snap.topLevel = tl;
    // per-channel store data
    var channels = {};
    channelList().forEach(function (ch) {
      var pfx = prefixFor(ch);
      var chData = {};
      // roster index + all user partitions
      var idx = []; try { var pj = JSON.parse(GM_getValue(NS + pfx + 'roster:index', '[]')) || []; idx = Array.isArray(pj) ? pj : []; } catch (e) {}
      chData['roster:index'] = idx;
      idx.forEach(function (id) { var v = GM_getValue(NS + pfx + 'u:' + id, null); if (v != null) chData['u:' + id] = v; });
      // archive index + archive partitions
      var archIdx = []; try { archIdx = JSON.parse(GM_getValue(NS + pfx + 'arch:index:' + ch, '[]')) || []; } catch (e) {}
      if (archIdx.length) {
        chData['arch:index:' + ch] = archIdx;
        archIdx.forEach(function (id) { var v = GM_getValue(NS + pfx + 'arch:' + ch + ':u:' + id, null); if (v != null) chData['arch:' + ch + ':u:' + id] = v; });
      }
      // per-channel state keys
      ['cursor:'+ch,'speaker:ring:'+ch,'rhythm:'+ch,'mood:'+ch,'intent:'+ch,'reminders:'+ch,
       'afk:'+ch,'highlights:'+ch,'reacttally:'+ch,'lull:'+ch,'checkins:'+ch,
       'beats:lastrun:'+ch,'modlog','chansum:'+ch,'epi:'+ch,'affect:'+ch,'work:'+ch,
       'delib:'+ch,'procmode:'+ch,'charmem','goals','consolidate:'+ch,'backfill:'+ch,'selfintents:'+ch,'ownlines:'+ch,'feedback:'+ch,'todos:'+ch,'skills:'+ch,
       'games:'+ch,'wordle:'+ch,'wordlestats:'+ch,'actlog:'+ch
      ].forEach(function (k) { var v = GM_getValue(NS + pfx + k, null); if (v != null) chData[k] = v; });
      channels[ch] = chData;
    });
    snap.channels = channels;
    return snap;
  }

  // ---- import firewall (v0.90.18) -------------------------------------------------------
  // Backups are operator-handled files (downloaded, shared, re-imported months later),
  // so the import boundary is untrusted input. importState used to write every key raw:
  // a crafted or stale file could overwrite the token (via cfg.token, topLevel
  // 'cfg:token', or the channels primary-prefix alias), plant a modList string (isMod
  // does substring matching on non-arrays — privilege escalation), or time-travel
  // enums. This pure function (headless-tested) returns only safe data + a drop list.
  var IMPORT_ENGAGE = ['normal', 'open', 'locked'];
  var IMPORT_ADDR = ['mention', 'name', 'both'];
  var IMPORT_CH_EXACT = ['roster:index', 'modlog', 'charmem', 'goals'];
  var IMPORT_CH_PREFIX = ['cursor:', 'speaker:ring:', 'rhythm:', 'mood:', 'intent:', 'reminders:',
    'afk:', 'highlights:', 'reacttally:', 'lull:', 'checkins:', 'beats:lastrun:', 'chansum:',
    'epi:', 'affect:', 'work:', 'delib:', 'procmode:', 'consolidate:', 'backfill:',
    'selfintents:', 'ownlines:', 'feedback:', 'todos:', 'skills:',
    'games:', 'wordle:', 'wordlestats:', 'actlog:'];
  function importKeyOk(k) {
    if (IMPORT_CH_EXACT.indexOf(k) >= 0) return true;
    for (var i = 0; i < IMPORT_CH_PREFIX.length; i++) { if (k.indexOf(IMPORT_CH_PREFIX[i]) === 0) return true; }
    if (/^u:\d+$/.test(k) || /^arch:index:\d+$/.test(k) || /^arch:\d+:u:\d+$/.test(k)) return true;
    return false;
  }
  function sanitizeImport(data) {
    var dropped = [];
    var allowed = {};
    BACKUP_CFG_KEYS.forEach(function (k) { allowed[k] = true; });
    var cfg = {}, src = (data && data.cfg && typeof data.cfg === 'object') ? data.cfg : {};
    Object.keys(src).forEach(function (k) {
      var mG = k.match(/^chanGate:(\d{15,25})$/);
      if (mG) {
        var gv = src[k];
        if (gv && typeof gv === 'object' && !Array.isArray(gv)) {
          var cleanG = {};
          ['speak', 'read', 'remember'].forEach(function (gt) { if (gv[gt] === false) cleanG[gt] = false; });
          if (Object.keys(cleanG).length) { cfg[k] = cleanG; return; }
        }
        dropped.push('cfg:' + k); return;
      }
      var mPC = k.match(/^(engageMode|channelLang):(\d{15,25})$/);   // per-channel keys (v0.90.21 —
      if (mPC) {                                                      // exact-name allowlists can't enumerate these)
        if (mPC[1] === 'engageMode') { if (IMPORT_ENGAGE.indexOf(src[k]) >= 0) cfg[k] = src[k]; else dropped.push('cfg:' + k); return; }
        var __ln = (typeof ChloeT0 !== 'undefined' && ChloeT0.LANG_NAMES) || {};
        if (__ln[src[k]]) cfg[k] = src[k]; else dropped.push('cfg:' + k); return;
      }
      if (k === 'token' || !allowed[k]) { dropped.push('cfg:' + k); return; }   // never the token, never unknown keys
      var v = src[k];
      if (k === 'addressMode') { if (IMPORT_ADDR.indexOf(v) >= 0) cfg[k] = v; else dropped.push('cfg:' + k); return; }
      if (k === 'engageMode' || k.indexOf('engageMode:') === 0) { if (IMPORT_ENGAGE.indexOf(v) >= 0) cfg[k] = v; else dropped.push('cfg:' + k); return; }
      if (k === 'modList') { if (Array.isArray(v)) cfg[k] = v.filter(function (x) { return typeof x === 'string' && x; }); else dropped.push('cfg:' + k); return; }
      if (k === 'botRoleIds') { if (Array.isArray(v)) cfg[k] = v.filter(function (x) { return /^\d{8,32}$/.test(String(x)); }).map(String); else dropped.push('cfg:' + k); return; }
      if (k === 'checkinFavorites' || k === 'checkinBlacklist') { if (Array.isArray(v)) cfg[k] = v.filter(function (x) { return /^\d{8,32}$/.test(String(x).trim()); }).map(function (x) { return String(x).trim(); }).slice(0, 200); else dropped.push('cfg:' + k); return; }
      if (k === 'actPolicy') { if (v === 'allow' || v === 'ask' || v === 'deny') cfg[k] = v; else dropped.push('cfg:' + k); return; }
      if (k === 'actGrants') {
        if (typeof ChloeModAudit !== 'undefined' && ChloeModAudit.validateGrants && Array.isArray(v)) cfg[k] = ChloeModAudit.validateGrants(v);
        else if (Array.isArray(v)) cfg[k] = [];
        else dropped.push('cfg:' + k);
        return;
      }
      // Reach-out timing knobs: finite numbers inside the dispatch clamps, else the entry is dropped.
      var REACH_BOUNDS = { lullPatienceMs: [3600000, 604800000], lullMinGapMs: [3600000, 1209600000], checkinAbsenceMs: [21600000, 2592000000], checkinGapMs: [3600000, 1209600000], checkinPerUserGapMs: [86400000, 7776000000], checkinMinInteractions: [1, 100] };
      if (k in REACH_BOUNDS) { var rb = REACH_BOUNDS[k]; if (typeof v === 'number' && isFinite(v) && v >= rb[0] && v <= rb[1]) cfg[k] = v; else dropped.push('cfg:' + k); return; }
      if (k === 'commandPrefixes') { if (Array.isArray(v)) cfg[k] = v.filter(function (x) { return typeof x === 'string' && x; }); else dropped.push('cfg:' + k); return; }
      if (k === 'autoModRules' || k === 'beats' || k === 'procRules') { if (Array.isArray(v)) cfg[k] = v; else dropped.push('cfg:' + k); return; }
      cfg[k] = v;
    });
    var topLevel = {}, tls = (data && data.topLevel && typeof data.topLevel === 'object') ? data.topLevel : {};
    Object.keys(tls).forEach(function (k) {
      if (k === 'seminject:map') { if (tls[k] && typeof tls[k] === 'object') topLevel[k] = tls[k]; else dropped.push('top:' + k); return; }
      if (k === 'deviceClock' || /^guildId:\d+$/.test(k)) { topLevel[k] = tls[k]; return; }
      dropped.push('top:' + k);
    });
    var channels = {}, chs = (data && data.channels && typeof data.channels === 'object') ? data.channels : {};
    Object.keys(chs).forEach(function (ch) {
      if (!/^\d+$/.test(ch) || !chs[ch] || typeof chs[ch] !== 'object') { dropped.push('ch:' + ch); return; }
      var clean = {};
      Object.keys(chs[ch]).forEach(function (k) { if (importKeyOk(k)) clean[k] = chs[ch][k]; else dropped.push(ch + ':' + k); });
      channels[ch] = clean;
    });
    return { cfg: cfg, topLevel: topLevel, channels: channels, dropped: dropped };
  }

  // ---- A2: import dry-run + admission quarantine -------------------------------
  var QUARANTINE_STORE_KEY = 'import-quarantine';
  function quarantineStash() {
    var q = null;
    try { q = GM_getValue(NS + QUARANTINE_STORE_KEY, null); } catch (e) {}
    if (!q || typeof q !== 'object' || Array.isArray(q)) return null;
    var out = { at: Number(q.at) || 0 };
    ['beats', 'autoModRules', 'procRules'].forEach(function (k) {
      if (Array.isArray(q[k])) out[k] = q[k];
    });
    if (!out.beats && !out.autoModRules && !out.procRules) return null;
    return out;
  }
  function quarantineSummary() {
    var q = quarantineStash();
    if (!q) return null;
    var o = { at: q.at };
    ['beats', 'autoModRules', 'procRules'].forEach(function (k) { o[k] = Array.isArray(q[k]) ? q[k].length : 0; });
    return o;
  }
  // A8: undo of a quarantine release/drop re-holds sets. Merges VALIDATED arrays
  // only (Rule R — the undo stack is self-written, still validated on the way
  // back in); creates the stash if none. Shared by the onPoll touched consumer
  // and wiring act.undo. Returns true when anything was re-held.
  function restashQuarantine(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    var kinds = ['beats', 'autoModRules', 'procRules'].filter(function (k) { return Array.isArray(obj[k]); });
    if (!kinds.length) return false;
    var stash = quarantineStash() || { at: Date.now() };
    kinds.forEach(function (k) { stash[k] = obj[k].slice(); });
    if (!stash.at) stash.at = Date.now();
    try { GM_setValue(NS + QUARANTINE_STORE_KEY, stash); return true; } catch (eRS) { return false; }
  }
  // Dry-run: the exact classification a real import would apply, nothing written.
  function previewImport(data) {
    if (!data || typeof data !== 'object') return { ok: false, reason: 'invalid backup data' };
    var clean = sanitizeImport(data);
    var cur = {};
    Object.keys(clean.cfg).forEach(function (k) { try { var v = GM_getValue(NS + 'cfg:' + k, null); if (v != null) cur[k] = v; } catch (e) {} });
    var cls = (typeof ChloeModAudit !== 'undefined' && ChloeModAudit.classifyImport)
      ? ChloeModAudit.classifyImport(clean, cur)
      : { writes: [], quarantine: {}, skipped: [], dropped: clean.dropped, channels: Object.keys(clean.channels), topLevel: Object.keys(clean.topLevel) };
    function qn(k) { return (cls.quarantine && cls.quarantine[k]) ? cls.quarantine[k].length : 0; }
    return { ok: true, value: {
      version: data._version || null, exported: data._exported || null,
      writes: cls.writes.length,
      writeKeys: cls.writes.slice(0, 12).map(function (w) { return w.k; }),
      quarantined: { beats: qn('beats'), autoModRules: qn('autoModRules'), procRules: qn('procRules') },
      skipped: cls.skipped, dropped: cls.dropped.length,
      channels: cls.channels.length, topLevel: cls.topLevel.length
    } };
  }

  // ---- import: restore a snapshot (merges cfg, restores channel data) -----------------
  function importState(data) {
    if (!data || typeof data !== 'object') return Promise.resolve({ ok: false, reason: 'invalid backup data' });
    try {
      var clean = sanitizeImport(data);   // firewall: allowlisted keys, typed enums, no token
      var cur2 = {};
      Object.keys(clean.cfg).forEach(function (k) { try { var v = GM_getValue(NS + 'cfg:' + k, null); if (v != null) cur2[k] = v; } catch (e2) {} });
      var cls2 = (typeof ChloeModAudit !== 'undefined' && ChloeModAudit.classifyImport)
        ? ChloeModAudit.classifyImport(clean, cur2)
        : { writes: Object.keys(clean.cfg).map(function (k) { return { k: k }; }), quarantine: {}, skipped: [], dropped: clean.dropped, channels: Object.keys(clean.channels), topLevel: [] };
      // Real cfg writes — never the quarantined rule/behavior sets.
      cls2.writes.forEach(function (w) { GM_setValue(NS + 'cfg:' + w.k, clean.cfg[w.k]); });
      // Admission quarantine: stash incoming rule sets for review, keep prior holds.
      var qkinds = Object.keys(cls2.quarantine || {});
      if (qkinds.length) {
        var prevQ = quarantineStash() || { at: Date.now() };
        var nextQ = { at: Date.now() };
        ['beats', 'autoModRules', 'procRules'].forEach(function (k) {
          if (cls2.quarantine[k]) nextQ[k] = cls2.quarantine[k];
          else if (Array.isArray(prevQ[k])) nextQ[k] = prevQ[k];
        });
        try { GM_setValue(NS + QUARANTINE_STORE_KEY, nextQ); } catch (eQ) {}
      }
      // top-level keys
      var tl = clean.topLevel;
      Object.keys(tl).forEach(function (k) { GM_setValue(NS + k, tl[k]); });
      // per-channel data
      var channels = clean.channels;
      Object.keys(channels).forEach(function (ch) {
        var pfx = prefixFor(ch);
        var chData = channels[ch];
        Object.keys(chData).forEach(function (k) { GM_setValue(NS + pfx + k, chData[k]); });
      });
      eachEngine(function (e) { e.stop(); }); engines = {}; lastPoll = null;
      if (clean.dropped.length) bLog('[chloe] import: dropped ' + clean.dropped.length + ' unrecognized/unsafe key(s): ' + clean.dropped.slice(0, 10).join(', '));
      if (qkinds.length) bLog('[chloe] import: held ' + qkinds.join(', ') + ' for review — release in the System tab (quarantine) or drop them');
      if (data._version && data._version !== VERSION) bLog('[chloe] import: backup is v' + data._version + ', bridge is v' + VERSION + ' — proceeding with sanitized data; re-check settings if anything looks off');
      bLog('[chloe] state imported from backup (v' + (data._version || '?') + ', exported ' + (data._exported || '?') + '). Restart to apply.');
      return Promise.resolve({ ok: true, value: { version: data._version, exported: data._exported, dropped: clean.dropped.length, quarantined: qkinds, quarantine: quarantineSummary() } });
    } catch (err) {
      return Promise.resolve({ ok: false, reason: 'import failed: ' + (err && err.message) });
    }
  }

  // Warm the exact tokenizer in the background so the first reply is already precise.
  if (cfgGet('exactTokens', true)) { try { tokLoader.preload(); } catch (e) {} }

  console.log('[chloe-wiring ' + VERSION + '] wired as ' + TAB_ROLE + '. token set:', hasToken(),
    '| channel set:', !!cfgGet('channelId', ''));

  function shutdown() {
    try { if (tickTimer) clearInterval(tickTimer); } catch (e) {}
    try { if (helloTimer) clearInterval(helloTimer); } catch (e) {}
    try { eachEngine(function (e) { e.stop(); }); } catch (e) {}
  }
  return {
    onPanelEvent: onPanelEvent,
    shutdown: shutdown,
    getRole: function () { return TAB_ROLE; },
    getVersion: function () { return VERSION; },
    promptToken: promptToken,
    resetState: resetState,
    dispatch: dispatch
  };
}
