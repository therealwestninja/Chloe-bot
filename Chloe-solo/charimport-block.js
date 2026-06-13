  // Pure in-browser: decompress -> decode (CBOR/JSON/scavenge) -> extract characters + their
  // thread memories. No upload, no network except the CBOR decoder CDN on first .cbor.gz.
  var CHARCBOR = null;
  function charLoadCBOR() {
    if (CHARCBOR) return Promise.resolve(CHARCBOR);
    return import('https://cdn.jsdelivr.net/npm/cbor-x@1.6.0/dist/index.js')
      .then(function (m) { CHARCBOR = (m && m.default) ? m.default : m; return CHARCBOR; })
      .catch(function () { return null; });
  }
  function charGunzip(arrayBuffer) {
    if (typeof DecompressionStream === 'undefined') return Promise.resolve(new Uint8Array(arrayBuffer));
    try {
      var ds = new DecompressionStream('gzip');
      var blobParts = []; blobParts.push(arrayBuffer);
      return new Response(new Blob(blobParts).stream().pipeThrough(ds)).arrayBuffer()
        .then(function (buf) { return new Uint8Array(buf); })
        .catch(function () { return new Uint8Array(arrayBuffer); });
    } catch (e) { return Promise.resolve(new Uint8Array(arrayBuffer)); }
  }
  function charScavenge(text) {
    var open = String.fromCharCode(123), close = String.fromCharCode(125);
    var start = text.indexOf(open); if (start < 0) return null;
    var depth = 0, inStr = false, esc = false;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
      else { if (ch === '"') inStr = true; else if (ch === open) depth++; else if (ch === close) { depth--; if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; } } } }
    }
    return null;
  }
  function charDecode(bytes) {
    if (CHARCBOR && typeof CHARCBOR.decode === 'function') { try { return CHARCBOR.decode(bytes); } catch (e) {} }
    var text = ''; try { text = new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) {}
    if (text) { try { return JSON.parse(text); } catch (e) {} var s = charScavenge(text); if (s) return s; }
    return null;
  }
  function charExtractStores(obj) {
    var out = { characters: [], threads: [], messages: [] };
    if (!obj || typeof obj !== 'object') return out;
    // Dexie DB export — AI Character Chat's NATIVE "export characters" format (a .json.gz whose
    // formatName is "dexie"). The tables live under data.data[] as { tableName, rows }; pull the
    // character/thread/message rows straight out. This is the common AICC export and must come first.
    var dx = obj.data && obj.data.data;
    if (obj.formatName === 'dexie' || Array.isArray(dx)) {
      if (Array.isArray(dx)) dx.forEach(function (blk) {
        if (!blk || !Array.isArray(blk.rows)) return;
        if (blk.tableName === 'characters') out.characters = blk.rows;
        else if (blk.tableName === 'threads') out.threads = blk.rows;
        else if (blk.tableName === 'messages') out.messages = blk.rows;
      });
      if (out.characters.length || out.threads.length || out.messages.length) return out;
    }
    if (obj.stores && typeof obj.stores === 'object') {
      ['characters', 'threads', 'messages'].forEach(function (k) { if (Array.isArray(obj.stores[k])) out[k] = obj.stores[k]; });
      return out;
    }
    if (obj.addCharacter) { var addList = []; addList.push(obj.addCharacter); out.characters = addList; return out; }
    if (Array.isArray(obj.characters)) { ['characters', 'threads', 'messages'].forEach(function (k) { if (Array.isArray(obj[k])) out[k] = obj[k]; }); return out; }
    if (obj.name || obj.roleInstruction || obj.systemMessage) { var oneChar = []; oneChar.push(obj); out.characters = oneChar; return out; }
    return out;
  }
  function charNormalize(c) {
    if (c.roleInstruction === undefined && c.systemMessage != null) c.roleInstruction = c.systemMessage;
    if (c.roleInstruction === undefined) c.roleInstruction = '';
    if (!c.name) c.name = 'Unnamed';
    var instr = String(c.roleInstruction || '');
    // AICC parity: fold in its other persona fields when they're literal text. Skip "@preset"
    // references (e.g. "@roleplay1") — those are AICC-internal aliases that carry no meaning here.
    var gwi = String(c.generalWritingInstructions || '').trim();
    if (gwi && gwi.charAt(0) !== '@') instr += '\n\nWriting style: ' + gwi;
    var rem = String(c.reminderMessage || '').trim();
    if (rem) instr += '\n\nKeep in mind: ' + rem;
    var avatar = (c.avatar && c.avatar.url) ? c.avatar.url : (c.avatarUrl || '');
    return { name: String(c.name), instruction: instr, avatar: avatar, id: (c.id != null ? c.id : null), uuid: c.uuid || null };
  }
  // respool's replay-from-file: timeless memories already stored on a thread's messages.
  function charMemoriesForCharacter(stores, character) {
    var threads = (stores.threads || []).filter(function (t) {
      return t && (t.characterId === character.id || (character.id == null && (stores.characters || []).length === 1));
    });
    var threadIds = {}; threads.forEach(function (t) { threadIds[t.id] = true; });
    var texts = [], seen = {};
    (stores.messages || []).forEach(function (m) {
      if (!m || !m.memoriesEndingHere) return;
      if (threads.length && !threadIds[m.threadId]) return;
      var levels = m.memoriesEndingHere;
      Object.keys(levels).forEach(function (lvl) {
        (levels[lvl] || []).forEach(function (mem) {
          var t = (mem && mem.text) ? mem.text : (typeof mem === 'string' ? mem : null);
          if (!t) return; var k = t.toLowerCase().replace(/[^a-z0-9 ]+/g, '').trim();
          if (k && !seen[k]) { seen[k] = true; texts.push(String(t).slice(0, 200)); }
        });
      });
    });
    return texts;
  }

  var CHARSTATE = { stores: null, chars: [], picked: null, memories: [] };
  function charSetStatus(msg, kind) { var el = byId('charStatus'); if (el) { el.textContent = msg; el.style.color = kind === 'er' ? 'var(--bad)' : (kind === 'ok' ? 'var(--good)' : 'var(--muted)'); } }

  // Shared sink for raw bytes from ANY source (file, fetched link). Decompress if gzipped, decode,
  // extract characters. needCbor preloads the decoder for .cbor/.gz payloads.
  function charIngestBytes(buf, label, needCbor) {
    var pre = needCbor ? charLoadCBOR() : Promise.resolve(null);
    return pre.then(function () {
      var bytes = new Uint8Array(buf);
      var gz = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
      return (gz ? charGunzip(buf) : Promise.resolve(bytes));
    }).then(function (bytes) {
      var obj = charDecode(bytes);
      return charIngestObject(obj, label);
    });
  }
  // Shared sink for an already-decoded object (raw pasted JSON skips decompression).
  function charIngestObject(obj, label) {
    if (!obj) { charSetStatus('Could not read ' + (label || 'that input') + ' \u2014 it may be empty or an unsupported format.', 'er'); return false; }
    var stores = charExtractStores(obj);
    var chars = (stores.characters || []).map(charNormalize).filter(function (c) { return c.name; });
    if (!chars.length) { charSetStatus('No characters found in ' + (label || 'that input') + '.', 'er'); return false; }
    CHARSTATE.stores = stores; CHARSTATE.chars = chars; CHARSTATE.picked = null;
    charSetStatus('Found ' + chars.length + ' character' + (chars.length === 1 ? '' : 's') + '. Pick one below.', 'ok');
    charRenderList();
    return true;
  }

  function charLoadFile(file) {
    if (!file) return;
    charSetStatus('Reading ' + file.name + ' (' + Math.round(file.size / 1024) + ' KB)\u2026');
    var needCbor = /\.cbor(\.gz)?$/i.test(file.name) || /\.gz$/i.test(file.name);
    file.arrayBuffer()
      .then(function (buf) { return charIngestBytes(buf, file.name, needCbor); })
      .catch(function (e) { charSetStatus('Failed to read the file: ' + ((e && e.message) || e), 'er'); });
  }

  // Recover an AICC upload id from a share link, a direct user.uploads.dev link, or a bare hex id
  // (mined from aicc-recovery). Returns a normalized FILEID.gz, or null.
  function charExtractFileId(raw) {
    var s = String(raw || '').trim();
    var m = s.match(/[?&]data=[^~]*~([a-z0-9]{16,}(?:\.gz)?)/i);
    if (m) return m[1].replace(/\.gz$/i, '') + '.gz';
    m = s.match(/user\.uploads\.dev\/file\/([a-z0-9]{16,}(?:\.gz)?)/i);
    if (m) return m[1].replace(/\.gz$/i, '') + '.gz';
    m = s.match(/^([a-f0-9]{24,})(?:\.gz)?$/i);
    if (m) return m[1] + '.gz';
    return null;
  }

  // Resilient fetch (DESIGN-transport, roadmap #9). A bare fetch dies on the first 429 or network blip;
  // this retries transient failures (429 / 408 / 5xx / network reject) with exponential backoff + FULL
  // JITTER — the AWS "Exponential Backoff and Jitter" strategy that p-retry / cockatiel / exponential-
  // backoff all use: wait a random time in [0, min(cap, base·2^attempt)), so a rate-limited host isn't
  // hammered in lockstep. A Retry-After header (seconds) is honored as a floor. Non-retryable statuses
  // (e.g. 404 removed/quarantined) fail fast — the final non-ok response is handed back to the caller.
  // fetchImpl/sleep are injectable for testing; they default to the real fetch + setTimeout.
  function fetchRetry(url, opts) {
    opts = opts || {};
    var max = opts.retries == null ? 3 : opts.retries;
    var base = opts.baseMs || 500, cap = opts.capMs || 8000;
    var doFetch = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var onRetry = opts.onRetry;
    function jitter(n) { return Math.floor(Math.random() * Math.min(cap, base * Math.pow(2, n))); }
    function retryable(st) { return st === 429 || st === 408 || (st >= 500 && st <= 599); }
    function attempt(n) {
      return Promise.resolve(doFetch(url, opts.init)).then(function (res) {
        if (res.ok || !retryable(res.status) || n >= max) return res;   // success, or hand the final non-ok back
        var wait = jitter(n);
        var ra = res.headers && res.headers.get && res.headers.get('Retry-After');
        if (ra != null) { var sec = parseFloat(ra); if (!isNaN(sec) && sec >= 0) wait = Math.max(wait, Math.ceil(sec * 1000)); }
        if (onRetry) onRetry(n + 1, max, wait, res.status);
        return sleep(wait).then(function () { return attempt(n + 1); });
      }, function (err) {
        if (n >= max) throw err;            // network error: retry until exhausted, then surface
        var wait = jitter(n);
        if (onRetry) onRetry(n + 1, max, wait, 'network');
        return sleep(wait).then(function () { return attempt(n + 1); });
      });
    }
    return Promise.resolve().then(function () { if (!doFetch) throw new Error('no fetch available in this context'); return attempt(0); });
  }

  // Load a character from pasted text: a link/file-id (fetched from user.uploads.dev) OR raw JSON.
  function charLoadText(raw) {
    var s = String(raw || '').trim();
    if (!s) { var ie = byId('charUrlInput'); if (ie) ie.focus(); return; }
    var fileId = charExtractFileId(s);
    if (fileId) {
      var url = 'https://user.uploads.dev/file/' + fileId;
      charSetStatus('Fetching ' + url + '\u2026');
      charLoadCBOR().then(function () { return fetchRetry(url, { onRetry: function (n, mx, wait, why) { charSetStatus('Fetch hit ' + (why === 'network' ? 'a network hiccup' : ('HTTP ' + why)) + ' \u2014 retry ' + n + '/' + mx + ' in ~' + Math.max(1, Math.round(wait / 1000)) + 's\u2026'); } }); })
        .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status + ' \u2014 the file may have been removed or quarantined'); return res.arrayBuffer(); })
        .then(function (buf) { return charIngestBytes(buf, 'the fetched file', true); })
        .catch(function (e) { charSetStatus('Could not fetch that link: ' + ((e && e.message) || e) + '. You can also download the file and drop it here.', 'er'); });
      return;
    }
    // Not a link/id -> try to parse it as raw character JSON directly.
    var startsObj = s.charAt(0) === String.fromCharCode(123) || s.charAt(0) === '[';
    if (startsObj) {
      var obj = null; try { obj = JSON.parse(s); } catch (e) { obj = charScavenge(s); }
      if (obj) { charSetStatus('Reading pasted character data\u2026'); charIngestObject(obj, 'the pasted data'); return; }
      charSetStatus('That looked like JSON but could not be parsed. Check it is a complete character export.', 'er');
      return;
    }
    charSetStatus('Paste a share link, a user.uploads.dev link, a file ID, or raw character JSON.', 'er');
  }

  function charRenderList() {
    var box = byId('charList'); while (box.firstChild) box.removeChild(box.firstChild);
    byId('charListCard').style.display = CHARSTATE.chars.length ? '' : 'none';
    CHARSTATE.chars.forEach(function (c, idx) {
      var row = document.createElement('div'); row.className = 'urow charrow';
      var grow = document.createElement('div'); grow.className = 'ugrow';
      var nm = document.createElement('div'); nm.className = 'uname'; nm.textContent = c.name; grow.appendChild(nm);
      var meta = document.createElement('div'); meta.className = 'umeta';
      var memCount = charMemoriesForCharacter(CHARSTATE.stores, c).length;
      var st = document.createElement('span'); st.className = 'uid';
      st.textContent = (c.instruction ? (c.instruction.length + ' chars of personality') : 'no personality text') + ' \u00b7 ' + memCount + ' memor' + (memCount === 1 ? 'y' : 'ies');
      meta.appendChild(st); grow.appendChild(meta); row.appendChild(grow);
      row.addEventListener('click', function () {
        CHARSTATE.picked = c;
        var rows = box.querySelectorAll('.charrow'); for (var i = 0; i < rows.length; i++) rows[i].className = 'urow charrow';
        row.className = 'urow charrow sel';
        charRenderPreview(c);
      });
      box.appendChild(row);
    });
  }

  function charRenderPreview(c) {
    byId('charPreviewCard').style.display = '';
    setText('charPreviewName', c.name);
    byId('charInstruction').value = c.instruction || '(this character has no role instruction)';
    CHARSTATE.memories = charMemoriesForCharacter(CHARSTATE.stores, c);
    var mh = byId('charMemHead'), ml = byId('charMemList');
    if (CHARSTATE.memories.length) {
      mh.style.display = ''; ml.style.display = '';
      while (ml.firstChild) ml.removeChild(ml.firstChild);
      CHARSTATE.memories.slice(0, 30).forEach(function (t) { var d = document.createElement('div'); d.textContent = '\u2022 ' + t; ml.appendChild(d); });
      byId('charSeedChk').checked = true; byId('charSeedChk').disabled = false;
    } else {
      mh.style.display = 'none'; ml.style.display = 'none';
      byId('charSeedChk').checked = false; byId('charSeedChk').disabled = true;
    }
    setText('charInstallNote', '');
  }

  function charInstall() {
    var c = CHARSTATE.picked; if (!c) { setText('charInstallNote', 'pick a character first'); return; }
    var replace = byId('charReplaceChk').checked;
    var seed = byId('charSeedChk').checked && CHARSTATE.memories.length;
    var jobs = [];
    if (replace) jobs.push(call('config.setCharacter', { name: c.name, instruction: c.instruction, avatar: c.avatar }));
    if (seed) jobs.push(call('character.seedMemories', { name: c.name, memories: CHARSTATE.memories, channelId: selChannel() }));
    if (!jobs.length) { setText('charInstallNote', 'nothing selected to apply'); return; }
    Promise.all(jobs).then(function () {
      setText('charInstallNote', 'done \u2014 she is now ' + c.name + (seed ? ' (with ' + CHARSTATE.memories.length + ' memories)' : ''));
      log('character installed: ' + c.name + (replace ? ' (personality replaced)' : '') + (seed ? ', ' + CHARSTATE.memories.length + ' memories seeded' : ''));
      refresh();
    });
  }

  (function charWire() {
    var pick = byId('charPickBtn'), fileEl = byId('charFile'), drop = byId('charDrop');
    if (pick && fileEl) { pick.addEventListener('click', function () { fileEl.click(); }); fileEl.addEventListener('change', function () { if (fileEl.files && fileEl.files[0]) charLoadFile(fileEl.files[0]); }); }
    if (drop) {
      ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.className = 'chardrop drag'; }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.className = 'chardrop'; }); });
      drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) charLoadFile(f); });
    }
    var ub = byId('charUrlBtn'); if (ub) ub.addEventListener('click', function () { charLoadText(byId('charUrlInput').value); });
    var ui = byId('charUrlInput'); if (ui) ui.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); charLoadText(ui.value); } });
    var pb = byId('charPasteBtn'); if (pb) pb.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (txt) { byId('charUrlInput').value = txt; charLoadText(txt); }, function () { charSetStatus('Clipboard read was blocked \u2014 paste into the box manually, then click Load.', 'er'); });
      } else { charSetStatus('This browser won\u2019t allow clipboard reads here \u2014 paste into the box manually, then click Load.', 'er'); byId('charUrlInput').focus(); }
    });
    var ib = byId('charInstallBtn'); if (ib) ib.addEventListener('click', charInstall);
    var ab = byId('charAuthorBtn'); if (ab) ab.addEventListener('click', function () {
      var nm = (byId('charAuthorName').value || '').trim();
      var instr = (byId('charAuthorInstr').value || '').trim();
      if (!nm) { setText('charAuthorNote', 'give your character a name first'); return; }
      if (!instr) { setText('charAuthorNote', 'write a sentence or two about who they are'); return; }
      setText('charAuthorNote', '\u2026');
      call('config.setCharacter', { name: nm, instruction: instr, avatar: '' }).then(function (res) {
        if (res && res.ok) { setText('charAuthorNote', 'done \u2014 she is now ' + nm); log('character authored: ' + nm + ' (personality replaced)'); refresh(); }
        else setText('charAuthorNote', 'could not apply: ' + ((res && res.reason) || 'unknown'));
      });
    });
    var cb = byId('charClearBtn'); if (cb) cb.addEventListener('click', function () {
      call('config.setCharacter', { name: null }).then(function () { setText('charCurrent', 'default Chloe'); log('character cleared \u2014 back to default Chloe'); refresh(); });
    });
  })();
