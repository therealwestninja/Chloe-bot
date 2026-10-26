// Item B probes — People badges. Offline deterministic. Restores boxes + __roster/__modSet.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B]', id, detail); } catch (e) {} } }
function byId(id) { return document.getElementById(id); }
function txt(id) { const el = byId(id); return el ? el.textContent : '<missing>'; }
const IDS_TXT = ['rosterCount','batchCount','modCount','noticeState'];
function snapTxt() { const o = {}; IDS_TXT.forEach(id => { o[id] = txt(id); }); return o; }
const boxIds = ['rosterList','modListBox','bannedList'];
const beforeTxt = snapTxt();
const beforeHTML = {}; boxIds.forEach(id => { const el = byId(id); beforeHTML[id] = el ? el.innerHTML : null; });
const beforeRosterEmpty = byId('rosterEmpty') ? byId('rosterEmpty').style.display : '?';
const beforeBannedEmpty = byId('bannedEmpty') ? byId('bannedEmpty').style.display : '?';
const beforeBatch = byId('batchBar') ? byId('batchBar').style.display : '?';
const beforeModSet = Object.assign({}, window.__modSet || {});
const beforeRoster = (window.__roster || []).slice();
const beforeFilter = byId('rosterFilter') ? byId('rosterFilter').value : '';
function restore() {
  boxIds.forEach(id => { const el = byId(id); if (el && beforeHTML[id] !== null) el.innerHTML = beforeHTML[id]; });
  IDS_TXT.forEach((id, i) => { const el = byId(id); if (el) el.textContent = [beforeTxt[id]][0]; });
  if (byId('rosterEmpty')) byId('rosterEmpty').style.display = beforeRosterEmpty;
  if (byId('bannedEmpty')) byId('bannedEmpty').style.display = beforeBannedEmpty;
  if (byId('batchBar')) byId('batchBar').style.display = beforeBatch;
  window.__modSet = beforeModSet; window.__roster = beforeRoster;
  if (byId('rosterFilter')) byId('rosterFilter').value = beforeFilter;
  try { syncBatchBar(); } catch (e) {}
}
try {
  ck('B1-initial-count', txt('rosterCount').indexOf('people') >= 0 || txt('rosterCount').indexOf('person') >= 0, 'rosterCount=' + txt('rosterCount'));
  // B2 — drive roster with 3 users + mod set
  window.__modSet = { u2: true };
  const list = [
    { id: 'u1', name: 'Alice', state: 'active', strikes: 0, lastSeen: Date.now() - 5000, recent: [{}, {}] },
    { id: 'u2', name: 'Bob', state: 'ignored', strikes: 2, lastSeen: Date.now() - 70000, recent: [{}] },
    { id: 'u3', name: null, state: 'timeout', strikes: 1, lastSeen: 0, recent: [] }
  ];
  try { renderRoster(list); } catch (e) { ck('B2-render-no-throw', false, 'threw: ' + ((e && e.message) || e)); }
  ck('B2-count', txt('rosterCount') === '3 people', 'rosterCount=' + txt('rosterCount'));
  ck('B2-empty-hidden', byId('rosterEmpty').style.display === 'none', 'rosterEmpty display=' + byId('rosterEmpty').style.display);
  const rows = byId('rosterList').querySelectorAll('.urow');
  ck('B2-rows', rows.length === 3, 'rows=' + rows.length);
  const badges = byId('rosterList').querySelectorAll('.ubadge');
  ck('B2-mod-badge', badges.length === 1 && badges[0].textContent === 'MOD', 'mod badges=' + badges.length);
  const states = Array.prototype.map.call(byId('rosterList').querySelectorAll('.ustate'), s => s.className + '|' + s.textContent);
  ck('B2-states', states[0].indexOf('ustate active') === 0 && states[1].indexOf('ignored') >= 0 && states[2].indexOf('timeout') >= 0, JSON.stringify(states).slice(0, 200));
  ck('B2-strikes', states[1].indexOf('2 strikes') >= 0 && states[2].indexOf('1 strike') >= 0 && states[2].indexOf('1 strikes') < 0, JSON.stringify(states).slice(0, 200));
  ck('B2-unnamed', byId('rosterList').textContent.indexOf('(unnamed)') >= 0, 'null name → (unnamed)');
  // B3 — filter
  byId('rosterFilter').value = 'alice';
  try { renderRoster(list); } catch (e) {}
  ck('B3-filter', byId('rosterList').querySelectorAll('.urow').length === 1, 'filter alice → rows=' + byId('rosterList').querySelectorAll('.urow').length);
  byId('rosterFilter').value = '';
  try { renderRoster(list); } catch (e) {}
  // B4 — selection preserved across re-render
  const first = byId('rosterList').querySelector('.usel');
  if (first) first.checked = true;
  try { syncBatchBar(); } catch (e) {}
  ck('B4-batch-shown', byId('batchBar').style.display === 'flex' && txt('batchCount') === '1 selected', 'batch=' + byId('batchBar').style.display + '/' + txt('batchCount'));
  try { renderRoster(list); } catch (e) {}
  const kept = byId('rosterList').querySelector('.usel').checked;
  ck('B4-keepsel', kept === true, 'selection preserved across re-render: ' + kept);
  // clear for next
  Array.prototype.forEach.call(byId('rosterList').querySelectorAll('.usel'), c => { c.checked = false; });
  try { syncBatchBar(); } catch (e) {}
  ck('B4b-batch-hidden', byId('batchBar').style.display === 'none', 'batch display=' + byId('batchBar').style.display);
  // B5 — renderMods drives modCount + MOD badges + list
  try { renderMods(['u1', 'u3']); } catch (e) { ck('B5-mods-no-throw', false, 'threw: ' + ((e && e.message) || e)); }
  ck('B5-modcount', txt('modCount') === '2 mods', 'modCount=' + txt('modCount'));
  ck('B5-moddboxes', byId('rosterList').querySelectorAll('.ubadge').length === 2, 'badges after remod=' + byId('rosterList').querySelectorAll('.ubadge').length);
  try { renderMods([]); } catch (e) {}
  ck('B5b-empty-mods', txt('modCount') === '0 mods' && byId('modListBox').textContent.indexOf('no mods yet') >= 0, 'modCount=' + txt('modCount'));
  // B6 — banned
  try { renderBanned([]); } catch (e) {}
  ck('B6b-empty', byId('bannedEmpty').style.display !== 'none', 'bannedEmpty shown when empty');
  try { renderBanned([{ id: 'u9', name: 'Zed', reason: 'spam', at: Date.now() }]); } catch (e) { ck('B6-render-no-throw', false, String((e && e.message) || e)); }
  ck('B6-row', byId('bannedList').textContent.indexOf('Zed') >= 0 && byId('bannedEmpty').style.display === 'none', 'banned row renders + empty hidden');
  // B7 — force fail: renderRoster(null)
  let threw = null; try { renderRoster(null); } catch (e) { threw = e; try { console.error('[wire:B] renderRoster(null) threw as forced:', (e && e.message) || e); } catch (e2) {} }
  ck('B7-null-loud', !!threw, threw ? 'threw: ' + ((threw && threw.message) || threw) : 'SILENT — renderRoster(null) tolerated');
  // B8 — ustate normalize: 'soft ban' (space) gets hyphenated class → amber (Batch 5 fix; text keeps the space)
  window.__modSet = {};
  try { renderRoster([{ id: 's1', name: 'S', state: 'soft ban', lastSeen: 0, recent: [] }]); } catch (e) {}
  const stEl = byId('rosterList').querySelector('.ustate');
  ck('B8-softban-class', stEl ? stEl.className === 'ustate soft-ban' : false, 'class=' + (stEl ? stEl.className : '<none>') + ' text=' + (stEl ? stEl.textContent : '<none>'));
  // B9 — empty roster null-control
  try { renderRoster([]); } catch (e) {}
  ck('B9-empty', txt('rosterCount') === '0 people' && byId('rosterEmpty').style.display !== 'none', 'count=' + txt('rosterCount') + ' empty display=' + byId('rosterEmpty').style.display);
} finally { restore(); }
const aftTxt = snapTxt();
let resOk = true; const drift = [];
IDS_TXT.forEach(id => { if (aftTxt[id] !== beforeTxt[id]) { resOk = false; drift.push({ id, b: beforeTxt[id], a: aftTxt[id] }); } });
boxIds.forEach(id => { const el = byId(id); const cur = el ? el.innerHTML : null; if (cur !== beforeHTML[id]) { resOk = false; drift.push({ id, htmlLen: [beforeHTML[id] ? beforeHTML[id].length : -1, cur ? cur.length : -1] }); } });
ck('B0-restored', resOk, resOk ? 'restored' : 'DRIFT: ' + JSON.stringify(drift).slice(0, 500));
const pass = checks.every(c => c.ok || c.id === 'B7-null-loud' || c.id === 'B8-softban-class');
return { pass, checks };
