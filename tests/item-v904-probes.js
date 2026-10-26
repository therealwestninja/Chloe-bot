// v0.90.4 live verification — FLAG_TOGGLES table dispatch round-trips, net-zero.
// Flips two boolean flags via UI clicks (lullFiller + ackReactions), status-confirms
// each direction, restores. Bot must be STOPPED (flags are inert while stopped).
// Run: page_eval {path:"src/tests/item-v904-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:V904]', id, detail); } catch (e) {} } }
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
async function waitLog(s, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 12000)) { const t = feedTail(4).join(' / '); if (t.includes(s)) return t; await new Promise(r => setTimeout(r, 400)); } return null; }
async function statusVal(field) { const r = await call('status'); return (r && r.ok && r.value) ? r.value[field] : 'NO-STATUS'; }
try {
  let ver = document.getElementById('verTxt') ? document.getElementById('verTxt').textContent : '?';
  if (ver.indexOf('0.90.') < 0) { await new Promise(r => setTimeout(r, 6000)); ver = document.getElementById('verTxt') ? document.getElementById('verTxt').textContent : '?'; }
  const stVer = await statusVal('version');   // shell-split era: verTxt reports the bundle version, not the userscript's 0.90.x
  ck('V904-version', ver.indexOf('0.90.') >= 0 || String(ver) === String(stVer), 'bridge ver=' + ver + ' (legacy 0.90.x monolith, or bundle ver matching status.version=' + stVer + ')');
  // V904-1 — lullFiller false→true→false with status confirmation each way
  const lull = document.getElementById('lullChk');
  const lull0 = lull.checked;
  if (lull0) { lull.click(); await waitLog('lullFiller: false', 12000); }
  lull.click();
  const up = await waitLog('lullFiller: true', 12000);
  const svUp = await statusVal('lullFiller');
  ck('V904-1-lull-on', !!up && svUp === true, 'log=' + !!up + ' status=' + svUp);
  lull.click();
  const dn = await waitLog('lullFiller: false', 12000);
  const svDn = await statusVal('lullFiller');
  ck('V904-2-lull-off', !!dn && svDn === false && lull.checked === false, 'log=' + !!dn + ' status=' + svDn);
  // V904-3 — ackReactions round-trip (second table flag, restored after)
  const ack = document.getElementById('ackChk');
  const ack0 = ack.checked;
  ack.click();
  const aUp = await waitLog('status reactions: ', 12000);
  const svA = await statusVal('ackReactions');
  ck('V904-3-ack-flip', !!aUp && svA === ack.checked, 'log=' + !!aUp + ' status=' + svA + ' box=' + ack.checked);
  ack.click();
  const aDn = await waitLog('status reactions: ', 12000);
  const svA2 = await statusVal('ackReactions');
  ck('V904-4-ack-restore', !!aDn && ack.checked === ack0, 'restored box=' + ack.checked + ' status=' + svA2);
} catch (e) { ck('V904-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
