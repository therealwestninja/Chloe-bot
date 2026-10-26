// Ham radio probes — callsign, validator, emulator relay, null controls.
// Run: page_eval {path:"src/tests/item-ham-probes.js"}. Returns {pass, checks}.
// Stubs window.grabAiText (restored); forces hamStatus (restored); opens real
// emulator sockets (closed); flips live config.setHamRadio true->back (net-zero).
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:HAM]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const hamStatusBk = (typeof hamStatus !== 'undefined') ? hamStatus : null;
const logBk = (window.__hamLog || []).slice();
const feedEl = byId('chatLog');
const feedBk = feedEl ? feedEl.innerHTML : null;
const grabBk = window.__hamAi;
const refreshBk = window.refresh;
// The live 5s refresh loop would overwrite our forced hamStatus mid-test;
// park it on a stub while we drive the client, restore at the end.
const heardBk = {};
try { Object.keys(hamHeard).forEach(function (k) { heardBk[k] = hamHeard[k]; }); } catch (e) {}
let sockB = null;
// Cooldown/outbound timestamps persist across runs in one page load; reset so
// the suite is rerun-safe (a prior run's reply must not cool down this one).
try { hamLastReplyAt = 0; hamLastTxAt = 0; } catch (e) {}
function restore() {
  try { if (sockB) { try { sockB.close(); } catch (e) {} } sockB = null; } catch (e) {}
  try { window.__ham.close(); } catch (e) {}
  try { Object.keys(hamHeard).forEach(function (k) { delete hamHeard[k]; }); Object.keys(heardBk).forEach(function (k) { hamHeard[k] = heardBk[k]; }); } catch (e) {}
  try { window.__hamLog = logBk; } catch (e) {}
  try { window.__hamAi = grabBk; } catch (e) {}
  try { window.refresh = refreshBk; } catch (e) {}
  try { window.__hamHold = false; } catch (e) {}
  try { hamStatus = hamStatusBk; ensureHam(); } catch (e) {}
  try { if (feedEl && feedBk !== null) feedEl.innerHTML = feedBk; } catch (e) {}
}
function rows() { return feedEl ? feedEl.querySelectorAll('.ev.received').length : -1; }
return (async function () {
try {
  const c1 = hamCallsign('123456789012345678'), c2 = hamCallsign('123456789012345678'), c3 = hamCallsign('999');
  ck('H1-deterministic', c1 === c2, c1);
  ck('H1-format', /^[A-Z0-9-]{2,24}$/.test(c1) && c1.indexOf('CHLOE-') === 0, c1);
  ck('H1-distinct', c1 !== c3, c1 + ' vs ' + c3);

  // H2 — validator battery
  ck('H2-good', !!hamValidBurst({ t: 'burst', id: 'CHLOE-AB12CD', text: 'hello' }), 'accepts well-formed burst');
  ck('H2-bad-id', hamValidBurst({ t: 'burst', id: 'nope!', text: 'x' }) === null, 'rejects bad callsign');
  ck('H2-long', hamValidBurst({ t: 'burst', id: 'CHLOE-AB12CD', text: new Array(283).join('x') }) === null, 'rejects 281-char text');
  ck('H2-empty', hamValidBurst({ t: 'burst', id: 'CHLOE-AB12CD', text: '   ' }) === null, 'rejects empty text');
  ck('H2-unknown-t', hamValidBurst({ t: 'shout', id: 'CHLOE-AB12CD', text: 'x' }) === null, 'rejects unknown type');
  ck('H2-nonobject', hamValidBurst('nope') === null && hamValidBurst(null) === null, 'rejects non-objects');
  ck('H2-hello', !!hamValidBurst({ t: 'hello', id: 'CHLOE-AB12CD' }), 'accepts hello without text');

  // H3 — null controls: off means no socket, inbound junk leaves no rows
  window.refresh = function () { return Promise.resolve(null); };
  hamStatus = { hamRadio: false, botUserId: '123456789012345678' };
  ensureHam();
  await new Promise(function (r) { setTimeout(r, 300); });
  ck('H3-no-socket-off', !hamWanted() && byId('hamState').textContent === 'off', 'state=' + byId('hamState').textContent);
  const r0 = rows();
  ck('H3-bad-json', hamOnMessage('not json{{{') === 'bad-json', 'bad json tagged');
  ck('H3-bad-shape', hamOnMessage(JSON.stringify({ t: 'burst', id: 'bad id!', text: 'x' })) === 'bad-shape', 'bad shape tagged');
  ck('H3-no-rows', rows() === r0, 'junk inbound adds no timeline rows');

  // H4 — live client path via emulator: force ON, real socket, inbound burst
  // naming us -> RADIO row + stubbed-AI reply published back to the band.
  // Note: the AI seam is window.__hamAi (a getter returning a canned ai fn),
  // read explicitly off window by hamThink — bare-global stubbing of
  // grabAiText does not reach page code. window.__hamHold parks the live
  // 5s refresh while the forced hamStatus is under test.
  window.__hamAi = function () { return function () { return Promise.resolve('Canned station check, all well here.'); }; };
  window.__hamHold = true;
  hamStatus = { hamRadio: true, botUserId: '123456789012345678' };
  const own = hamOwnId();
  ensureHam();
  let tries = 0;
  while (tries++ < 40 && byId('hamState').textContent.indexOf('on air') !== 0) await new Promise(function (r) { setTimeout(r, 250); });
  ck('H4-on-air', byId('hamState').textContent.indexOf('on air') === 0, 'state=' + byId('hamState').textContent);
  sockB = root.createServerSocket();
  const heardBack = [];
  sockB.addEventListener('message', function (e) { try { heardBack.push(String(e.data)); } catch (x) {} });
  await sockB.opened;
  sockB.send(JSON.stringify({ t: 'join', id: 'CHLOE-PROBE1' }));
  await new Promise(function (r) { setTimeout(r, 400); });
  const before = rows();
  sockB.send(JSON.stringify({ t: 'burst', id: 'CHLOE-PROBE1', text: 'calling ' + own + ' come in' }));
  tries = 0;
  while (tries++ < 40 && rows() <= before) await new Promise(function (r) { setTimeout(r, 250); });
  ck('H4-row', rows() > before, 'RADIO row rendered for inbound burst');
  tries = 0;
  while (tries++ < 40 && !heardBack.some(function (s) { return s.indexOf(own) >= 0 && s.indexOf('Canned station check') >= 0; })) await new Promise(function (r) { setTimeout(r, 250); });
  ck('H4-reply', heardBack.some(function (s) { return s.indexOf(own) >= 0 && s.indexOf('Canned station check') >= 0; }), 'stubbed reply published with our callsign');
  ck('H4-cooldown', hamMaybeReply('CHLOE-PROBE1', 'calling ' + own) === 'cooldown', 'second handoff inside 90s cools down');
  ck('H4-quiet', hamMaybeReply('CHLOE-PROBE1', 'just chatting away') === 'no-trigger', 'unaddressed chatter gets no reply');

  // H5 — self-echo ignored, no row
  const r1 = rows();
  ck('H5-echo', hamOnMessage(JSON.stringify({ t: 'burst', id: own, text: 'my own words ' + own })) === 'echo' && rows() === r1, 'own burst ignored');

  // H6 — live engine round trip: opt in, see it in status, opt back out
  const wasOn = !!(hamStatusBk && hamStatusBk.hamRadio);
  const setOn = await call('config.setHamRadio', { on: true });
  ck('H6-on', !!(setOn && setOn.ok && setOn.value && setOn.value.hamRadio === true), JSON.stringify(setOn && (setOn.ok ? setOn.value : setOn.reason)));
  const stOn = await call('status', null);
  ck('H6-status', !!(stOn && stOn.ok && stOn.value && stOn.value.hamRadio === true), 'status carries hamRadio:true');
  const setBack = await call('config.setHamRadio', { on: wasOn });
  ck('H6-restore', !!(setBack && setBack.ok && setBack.value && setBack.value.hamRadio === wasOn), 'restored to ' + wasOn);

  // H7 — feedType tags radio lines RADIO on the received style
  const ft = feedType('[chloe.radio] CHLOE-X: hello there');
  ck('H7-tag', ft && ft[0] === 'received' && ft[1] === 'RADIO', JSON.stringify(ft));
} catch (e) { ck('H0-no-throw', false, String((e && e.message) || e)); }
restore();
const pass = checks.every(function (c) { return c.ok; });
return { pass, checks };
})()