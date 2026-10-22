// ==UserScript==
// @name         Chloe shell (Discord <- Perchance)
// @namespace    therealwestninja
// @version      1.1
// @description  Thin stable shell: GM transport/storage, control link, engine-bundle cache. Engine logic arrives from the control generator panel (__installEngine) — reinstall this file only for transport/grant changes.
// @author       therealwestninja
// @match        https://*.perchance.org/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @grant        GM_openInTab
// @grant        GM_addValueChangeListener
// @connect      discord.com
// @connect      translate.googleapis.com
// @connect      api.duckduckgo.com
// @connect      en.wikipedia.org
// @connect      wikipedia.org
// @connect      api.open-meteo.com
// @connect      geocoding-api.open-meteo.com
// @connect      api.quotable.io
// @connect      byabbe.se
// @connect      restcountries.com
// @connect      api.datamuse.com
// @connect      api.dictionaryapi.dev
// @run-at       document-idle
// ==/UserScript==

/* chloe-shell — thin stable userscript shell (v1.0).
 *
 * This file intentionally contains NO engine logic: no commands, no polling, no
 * memory, no AI. It provides:
 *   1. the userscript privileges the engine needs (GM_* grants, @connect hosts),
 *   2. the control-link listener (LINKWIN postMessage, same origin gate as before),
 *   3. __hello / __installEngine: the panel asks what engine is installed and pushes
 *      the engine bundle (engine.js + tabbridge.js + wiring.js) when it is missing
 *      or stale; the bundle is cached in GM storage so it survives reloads,
 *   4. boot-from-cache + menu delegates.
 *
 * Reinstall this file only when the TRANSPORT changes (new grants, new @connect
 * hosts, new GM APIs). Engine/behavior changes ship with the generator — no
 * reinstall. New external lookup hosts need an @connect line here (= reinstall).
 */
(function () {
  'use strict';
  if (window.top !== window) return;   // shell + engine live in the top frame only

  var SHELL_VERSION = '1.1';
  var NS = 'chloe:';
  var BUNDLE_KEY = NS + 'engine:bundle';   // { version, source }
  var ORIGIN_OK = /^(null|https:\/\/([a-z0-9]{32}\.)?perchance\.org)$/;

  // #14: some userscript managers sandbox `window` so the page's postMessages miss a
  // listener bound on the sandbox window. unsafeWindow is the real page window.
  var LINKWIN = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  var TAB_ROLE = (/chloe-worker/.test(location.hash || '')) ? 'worker' : 'queen';

  var Wiring = null;          // return of __chloeWire(Shell)
  var engineVersion = null;   // bundle version string (from the bundle header)

  function sendRes(source, origin, obj) {
    try { source.postMessage(obj, (origin && origin !== 'null') ? origin : '*'); }
    catch (e) { try { source.postMessage(obj, '*'); } catch (e2) {} }
  }

  // v1.1 scoping fix: the bundle references bare GM_* / unsafeWindow, which live
  // in the userscript sandbox scope — NOT in the global scope an indirect eval
  // sees. v1.0's `(0, eval)(source)` threw "GM_getValue is not defined" on every
  // install, so no engine ever installed and the panel could never link (status
  // kept answering "no engine installed"). Compile with those names as explicit
  // parameters instead — the same shape as the generator's build-engine smoke
  // test, which injects them as function-scope vars. No engine change: bundle v1
  // installs as-is once the shell lets it.
  var GM_PARAMS = 'GM_getValue,GM_setValue,GM_deleteValue,GM_xmlhttpRequest,GM_openInTab,GM_registerMenuCommand,GM_addValueChangeListener,unsafeWindow';
  function installEngine(version, source) {
    version = String(version || '');
    if (!version || typeof source !== 'string' || source.length < 1000) {
      return { ok: false, reason: 'bad bundle (empty/short)' };
    }
    var wireFn;
    try {
      var uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : undefined;
      wireFn = new Function(GM_PARAMS,
        source + '\n;return (typeof __chloeWire !== "undefined" ? __chloeWire : null);')(
        GM_getValue, GM_setValue, GM_deleteValue, GM_xmlhttpRequest, GM_openInTab, GM_registerMenuCommand, GM_addValueChangeListener, uw);
    } catch (e) { return { ok: false, reason: 'bundle compile: ' + (e && e.message) }; }
    if (typeof wireFn !== 'function') return { ok: false, reason: 'bundle has no __chloeWire' };
    try {
      if (Wiring && typeof Wiring.shutdown === 'function') { try { Wiring.shutdown(); } catch (e) {} }
      Wiring = null; engineVersion = null;
      Wiring = wireFn({ LINKWIN: LINKWIN, tabRole: TAB_ROLE, engineVersion: version });
      if (!Wiring || typeof Wiring.onPanelEvent !== 'function') { Wiring = null; return { ok: false, reason: 'wiring boot failed' }; }
      engineVersion = version;
      try { GM_setValue(BUNDLE_KEY, { version: version, source: source }); }
      catch (e) { try { console.log('[chloe-shell] bundle cache write failed (quota?): ' + (e && e.message)); } catch (e2) {} }
      try { console.log('[chloe-shell] engine ' + version + ' installed as ' + TAB_ROLE); } catch (e) {}
      return { ok: true, value: { engine: version, role: (typeof Wiring.getRole === 'function') ? Wiring.getRole() : TAB_ROLE } };
    } catch (e) {
      Wiring = null; engineVersion = null;
      return { ok: false, reason: 'install failed: ' + (e && e.message) };
    }
  }

  function bootFromCache() {
    var cached = null;
    try { cached = GM_getValue(BUNDLE_KEY, null); } catch (e) {}
    if (cached && cached.version && typeof cached.source === 'string') {
      var r = installEngine(cached.version, cached.source);
      try { console.log('[chloe-shell] cache boot: ' + (r.ok ? cached.version : 'FAILED ' + r.reason)); } catch (e) {}
    }
  }

  LINKWIN.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.__chloe !== 1) return;
    if (!ORIGIN_OK.test(ev.origin)) return;
    if (d.kind !== 'req') return;
    var nonce = d.nonce, source = ev.source, origin = ev.origin;
    function res(obj) { obj = obj || {}; obj.__chloe = 1; obj.kind = 'res'; obj.nonce = nonce; sendRes(source, origin, obj); }
    if (d.cmd === '__hello') {
      res({ ok: true, value: { shell: SHELL_VERSION, engine: engineVersion, role: (Wiring && Wiring.getRole) ? Wiring.getRole() : TAB_ROLE } });
      return;
    }
    if (d.cmd === '__installEngine') {
      var a = d.args || {};
      res(installEngine(a.version, a.source));
      return;
    }
    if (!Wiring) { res({ ok: false, reason: 'no engine installed (shell ' + SHELL_VERSION + ' waiting for bundle)' }); return; }
    try { Wiring.onPanelEvent(ev); }
    catch (e) { res({ ok: false, reason: 'wiring: ' + (e && e.message) }); }
  });

  GM_registerMenuCommand('Set bot token', function () {
    if (Wiring && Wiring.promptToken) { try { Wiring.promptToken(); } catch (e) {} }
    else { try { alert('Chloe shell: no engine installed yet — open the control panel first.'); } catch (e) {} }
  });
  GM_registerMenuCommand('Reset Chloe state (keeps token)', function () {
    if (Wiring && Wiring.resetState) { try { Wiring.resetState(false); } catch (e) {} }
  });

  bootFromCache();
  try { console.log('[chloe-shell ' + SHELL_VERSION + '] loaded as ' + TAB_ROLE + ', engine: ' + (engineVersion || 'none (panel will push)')); } catch (e) {}
})();
