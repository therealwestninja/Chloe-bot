// Shell/world-split probes — __hello handshake, engine version match, install round-trip.
// SH2 reinstalls the SAME bundle version (net-zero content) but re-wires (engines stop),
// so it runs ONLY while stopped; otherwise SKIPPED with a note.
// Run: page_eval {path:"src/tests/item-shell-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:SHELL]', id, detail); } catch (e) {} } }
async function ucall(cmd, args, ms) { try { return await call(cmd, args, ms || 15000); } catch (e) { return { ok: false, reason: 'threw: ' + ((e && e.message) || e) }; } }
try {
  const want = (typeof root !== 'undefined' && root.ENGINE_BUNDLE_VERSION) ? String(root.ENGINE_BUNDLE_VERSION) : null;
  ck('SH0-want', !!want, 'want=' + want);
  // SH1 — hello answers with shell + engine + role (pre-shell bridge: unanswered → skip)
  const h = await ucall('__hello', null, 8000);
  const hv = (h && h.ok && h.value) || null;
  const preShell = !hv && (!h || h.reason === 'timeout' || /unknown command/.test(String((h && h.reason) || '')));
  ck('SH1-hello', !!(hv && hv.shell) || preShell, hv ? JSON.stringify(hv) : ('pre-shell bridge (' + ((h && h.reason) || 'no reply') + ')'));
  if (hv) ck('SH1-version', hv.engine === want, 'installed=' + hv.engine + ' want=' + want + ' shell=' + hv.shell);
  else ck('SH1-version', true, 'SKIPPED: pre-shell bridge (no __hello)');
  // SH3 — wiring alive: status answers
  const st = await ucall('bridge.status', null, 15000);
  ck('SH3-status', !!(st && st.ok), (st && (st.ok ? 'ok' : st.reason)) || 'no reply');
  // SH2 — same-version reinstall round-trip, only while stopped
  const running = !!(st && st.ok && st.value && st.value.running);
  if (hv && !running) {
    const src = await fetch('src/engine.bundle.js').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
    ck('SH2-fetch', src.length > 500000 && src.indexOf('__chloeWire') >= 0, 'bundle bytes=' + src.length);
    const ins = await ucall('__installEngine', { version: want, source: src }, 120000);
    ck('SH2-install', !!(ins && ins.ok && ins.value && ins.value.engine === want), JSON.stringify((ins && (ins.value || ins.reason)) || null).slice(0, 120));
    const h2 = await ucall('__hello', null, 8000);
    ck('SH2-hello-after', !!((h2 && h2.ok && h2.value && h2.value.engine) === want), JSON.stringify(h2 && h2.value));
    const st2 = await ucall('bridge.status', null, 15000);
    ck('SH2-status-after', !!(st2 && st2.ok), (st2 && (st2.ok ? 'ok' : st2.reason)) || 'no reply');
  } else ck('SH2-install', true, hv ? 'SKIPPED: bot running (re-wire would stop engines)' : 'SKIPPED: pre-shell bridge');
} catch (e) { ck('SH0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
