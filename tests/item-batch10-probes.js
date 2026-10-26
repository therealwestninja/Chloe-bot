// Batch 10 probes — F10 stale-run, F11 modeSel guard, F14 selector wipe,
// 10A null-safety leftovers, 10B blind/silent, 10C shape guards.
// Offline synthetic, zero transport (applyStatus + renderChannelSel only).
// Run serially (shares strip + selects + channel selector with other suites).
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B10]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const STRIP = ['runDot','runTxt','sb_run_dot','sb_run','verTxt','tokTxt','botTxt','sb_brain','pollTxt'];
const beforeStrip = {}; STRIP.forEach(id => { const el = byId(id); beforeStrip[id] = el ? { t: el.textContent, c: el.className } : null; });
const beforeMode = byId('modeSel') ? byId('modeSel').value : null;
const beforeEngage = byId('engageModeSel') ? byId('engageModeSel').value : null;
const selEl = byId('viewChannelSel');
const beforeSelOpts = selEl ? [...selEl.options].map(o => o.value) : [];
const beforeSelDisp = selEl ? selEl.style.display : null;
const tabBefore = document.querySelector('.tab.active') ? document.querySelector('.tab.active').id : null;
function restore() {
  STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b) { el.textContent = b.t; el.className = b.c; } });
  if (beforeMode !== null) byId('modeSel').value = beforeMode;
  if (beforeEngage !== null) byId('engageModeSel').value = beforeEngage;
  try {
    while (selEl.firstChild) selEl.removeChild(selEl.firstChild);
    beforeSelOpts.forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v; selEl.appendChild(o); });
    selEl.style.display = beforeSelDisp;
  } catch (e) {}
  try { if (tabBefore && byId(tabBefore)) byId(tabBefore).click(); } catch (e) {}
  try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (e) {}
}
try {
  byId('tab_behavior').click();
  // B10-1 — F10 code-shape: refresh fail path resets run pair to unknown
  try {
    const src = refresh.toString();
    ck('B10-1-f10-shape', src.indexOf("setText('runTxt', '\\u2026')") >= 0 && src.indexOf("setText('sb_run', '\\u2026')") >= 0,
      src.indexOf('runTxt') >= 0 ? 'fail path resets run pair' : 'no run reset in refresh');
  } catch (e) { ck('B10-1-f10-shape', false, 'threw: ' + e); }
  // B10-2 — F11: focused modeSel resists; unfocused follows (parity with engageModeSel)
  try {
    byId('modeSel').value = 'both'; byId('modeSel').focus();
    const took = document.activeElement === byId('modeSel');
    applyStatus({ running: false, addressMode: 'mention' });
    ck('B10-2-mode-focused', took && byId('modeSel').value === 'both', took ? ('kept both, got ' + byId('modeSel').value) : 'PROBE INVALID: focus did not take');
    byId('modeSel').blur();
    applyStatus({ running: false, addressMode: 'mention' });
    ck('B10-2b-mode-clean', byId('modeSel').value === 'mention', 'unfocused follows: ' + byId('modeSel').value);
    byId('engageModeSel').value = 'normal'; byId('engageModeSel').focus();
    const took2 = document.activeElement === byId('engageModeSel');
    applyStatus({ running: false, engageMode: 'locked' });
    ck('B10-2c-engage-focused', took2 && byId('engageModeSel').value === 'normal', took2 ? ('kept normal, got ' + byId('engageModeSel').value) : 'PROBE INVALID');
    byId('engageModeSel').blur();
  } catch (e) { ck('B10-2-mode-focused', false, 'threw: ' + e); }
  // B10-3 — F14: union shapes populate; empty preserves (never wipes)
  try {
    renderChannelSel({ publicChannels: ['p1', 'p2'] });
    ck('B10-3-public-shape', selEl.options.length === 2 && selEl.style.display === '', 'publicChannels → 2 opts, shown');
  } catch (e) { ck('B10-3-public-shape', false, 'threw'); }
  try {
    renderChannelSel({ channelId: 'solo9' });
    ck('B10-3b-single-shape', selEl.options.length === 1 && selEl.options[0].value === 'solo9' && selEl.style.display === 'none', 'channelId → 1 opt, hidden');
  } catch (e) { ck('B10-3b-single-shape', false, 'threw'); }
  try {
    const keep = [...selEl.options].map(o => o.value).join(',');
    renderChannelSel({});
    const kept = [...selEl.options].map(o => o.value).join(',');
    ck('B10-3c-no-wipe', kept === keep && kept.length > 0, 'empty preserves: ' + kept);
  } catch (e) { ck('B10-3c-no-wipe', false, 'threw'); }
  try {
    renderChannelSel({ channels: ['a', 'b', 'c'] });
    ck('B10-3d-legacy-shape', selEl.options.length === 3, 'legacy channels still work');
  } catch (e) { ck('B10-3d-legacy-shape', false, 'threw'); }
  // B10-4 — 10A null-safety code-shapes
  try {
    const t = [
      ['modAct-permaban', modAct.toString().indexOf('res && res.ok') >= 0],
      ['refreshMods', refreshMods.toString().indexOf('refreshInto') >= 0 && refreshInto.toString().indexOf('res && res.ok') >= 0],
      ['refresh-guards', refresh.toString().indexOf('!res || !res.ok') >= 0 && refresh.toString().indexOf('refreshRoster') >= 0 && refreshRoster.toString().indexOf('r && r.ok') >= 0],
    ];
    t.forEach(p => ck('B10-4-' + p[0], p[1], p[1] ? 'gated' : 'bare res.ok remains'));
  } catch (e) { ck('B10-4-gates', false, 'threw: ' + e); }
  // B10-5 — 10C shape-guard code-shapes (poll/newUsers, channels/chs, prefixes/cps).
  // Batch 19: read the LIVE scripts, not document innerHTML — the engine keeps an inert
  // type="notjs" preloaded copy of the generator source in the DOM whose text lags the
  // workspace between saves, so innerHTML shape checks matched stale code (vacuous pass).
  const liveSrc = [...document.querySelectorAll('script')].filter(s => { const t = (s.type || '').toLowerCase(); return t === '' || t.indexOf('javascript') >= 0 || t === 'module'; }).map(s => s.textContent || '').join('\n');
  try {
    const html = liveSrc;
    ck('B10-5-poll-shape', html.indexOf('(pv.newUsers && pv.newUsers.length) || 0') >= 0, 'poll newUsers fallback');
    ck('B10-5b-channels-shape', html.indexOf('(res.value && res.value.channels) || []') >= 0, 'channels chs fallback');
    ck('B10-5c-prefix-shape', html.indexOf('(r.value && r.value.commandPrefixes) || []') >= 0, 'prefixes cps fallback (Batch 19 logRes thunk param is r)');
  } catch (e) { ck('B10-5-shapes', false, 'threw: ' + e); }
  // B10-6 — 10B fail-log code-shapes (gates/pool/opAct/modlog/diag/DM), read from the
  // live scripts (see B10-5 note). Batches 18/19 moved gates + pool onto logRes, so those
  // two assert the surviving fail-prefix strings rather than the old else-log lines.
  try {
    const html = liveSrc;
    ck('B10-6-gates-fail', html.indexOf("'output gate ' + g + ' failed'") >= 0, 'gates fail prefix (logRes)');
    ck('B10-6b-pool-fail', html.indexOf("'pool set failed'") >= 0, 'pool fail prefix (logRes)');
    ck('B10-6c-opact-fail', html.indexOf("failed: ' + opOk + '/' + ids.length") >= 0, 'opAct counted fail');
    ck('B10-6d-modlog-fail', html.indexOf('mod log failed: ') >= 0, 'modlog distinct fail');
    ck('B10-6e-diag-fail', html.indexOf('diagnostics failed: ') >= 0, 'diag distinct fail');
    ck('B10-6f-dm-gate', html.indexOf('save DM channels failed: ') >= 0, 'DM leg gated');
    ck('B10-6g-permaban-count', html.indexOf('prune incomplete: ') >= 0, 'batch permaban counted');
  } catch (e) { ck('B10-6-fails', false, 'threw: ' + e); }
} finally { restore(); }
let ok = true;
STRIP.forEach(id => { const el = byId(id), b = beforeStrip[id]; if (el && b && (el.textContent !== b.t || el.className !== b.c)) ok = false; });
if (byId('modeSel').value !== beforeMode) ok = false;
if (byId('engageModeSel').value !== beforeEngage) ok = false;
try {
  const now = [...selEl.options].map(o => o.value).join(',');
  if (now !== beforeSelOpts.join(',')) ok = false;
  if (selEl.style.display !== beforeSelDisp) ok = false;
} catch (e) { ok = false; }
ck('B10-0-restored', ok, ok ? 'strip + selects + channel selector restored' : 'DRIFT');
const pass = checks.every(c => c.ok);
return { pass, checks };
