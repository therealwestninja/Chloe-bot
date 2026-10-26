// Activity-tab probes — first tab, chat card, feed/debug consolidation, admin profile.
// Chat send is tested with respond() stubbed (no AI spend). Restores everything.
// Run: page_eval {path:"src/tests/item-activity-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:ACT]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
const beforeTab = document.querySelector('.tab.active') ? document.querySelector('.tab.active').id : null;
let beforeAdmin = null;
try { beforeAdmin = localStorage.getItem('chloe.adminProfile.v1'); } catch (e) {}
const realSeam = window.__chloeRespond;
try {
  // ACT1 — Activity is the first tab and the default-active pane
  const tabs = [...document.querySelectorAll('.tabs .tab')].map(t => t.id);
  ck('ACT1-first', tabs[0] === 'tab_activity', tabs.join(','));
  ck('ACT1-active', byId('tab_activity').classList.contains('active') && byId('pane_activity').classList.contains('active'), 'tab+pane active');
  // ACT2 — unified chat card: timeline + input + admin + chat tools all inside pane_activity
  ['chatCard', 'chatLog', 'chatInput', 'chatSendBtn', 'adminNameInput', 'adminDiscordInput', 'adminSaveBtn', 'adminNote', 'feedClearBtn', 'diagBtn', 'errBtn', 'rescueBtn', 'resetBtn', 'debugToggleChk'].forEach(id => ck('ACT2-' + id, !!byId(id), id));
  const pane = byId('pane_activity');
  ck('ACT2-tools-in-pane', !!(pane && pane.querySelector('#diagBtn') && pane.querySelector('#errBtn') && pane.querySelector('#rescueBtn') && pane.querySelector('#feedClearBtn')), 'trace/errors/rescue/clear inside pane_activity');
  ck('ACT2-split-gone', !pane.querySelector('#feed') && !pane.querySelector('#debugBox') && !byId('log'), 'no separate feed/debug/log surfaces');
  // ACT3 — admin profile save round-trip (localStorage), then restore
  byId('adminNameInput').value = 'ProbeAdmin';
  byId('adminDiscordInput').value = '12345';
  byId('adminSaveBtn').click();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('chloe.adminProfile.v1')); } catch (e) {}
  ck('ACT3-save', !!(saved && saved.name === 'ProbeAdmin' && saved.discordId === '12345'), JSON.stringify(saved));
  ck('ACT3-note', byId('adminNote').textContent.indexOf('12345') >= 0, byId('adminNote').textContent);
  // ACT4 — chat send with stubbed respond (no AI spend): line appears, history grows, empty no-ops
  const linesBefore = pane.querySelectorAll('#chatLog .chatline').length;
  window.__chloeRespond = function () { return Promise.resolve({ ok: true, value: 'stubbed hi' }); };
  byId('chatInput').value = 'hello probe';
  byId('chatSendBtn').click();
  let replied = null;
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 250)); const ls = [...pane.querySelectorAll('#chatLog .chatline.her .cmsg')]; if (ls.length && ls[ls.length - 1].textContent === 'stubbed hi') { replied = true; break; } }
  ck('ACT4-reply', !!replied, 'stubbed her-line rendered');
  ck('ACT4-history', chatHistory.length >= 2 && chatHistory[0].text === 'hello probe', 'history=' + chatHistory.length);
  const n0 = pane.querySelectorAll('#chatLog .chatline').length;
  byId('chatInput').value = '   ';
  byId('chatSendBtn').click();
  await new Promise(r => setTimeout(r, 500));
  ck('ACT4-empty-noop', pane.querySelectorAll('#chatLog .chatline').length === n0, 'empty send adds nothing');
  // ACT5 — neighbors: tab switching still works both ways
  byId('tab_setup').click();
  const setupOn = byId('pane_setup').classList.contains('active') && !byId('pane_activity').classList.contains('active');
  byId('tab_activity').click();
  const actOn = byId('pane_activity').classList.contains('active') && byId('tab_activity').classList.contains('active');
  ck('ACT5-tabs', setupOn && actOn, 'setup→activity switching intact');
} catch (e) { ck('ACT0-no-throw', false, String((e && e.message) || e)); }
finally {
  try { if (realSeam) window.__chloeRespond = realSeam; else delete window.__chloeRespond; } catch (e) {}
  try {
    if (beforeAdmin === null) localStorage.removeItem('chloe.adminProfile.v1');
    else localStorage.setItem('chloe.adminProfile.v1', beforeAdmin);
    if (typeof renderAdmin === 'function') renderAdmin();
    setText('adminNote', '');
  } catch (e) {}
  try { if (beforeTab && byId(beforeTab)) byId(beforeTab).click(); } catch (e) {}
}
const pass = checks.every(c => c.ok);
return { pass, checks };
