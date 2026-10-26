// Treeshake scope: status-strip writers vs readers (applyStatus ↔ DOM ids).
// Every static byId/setText id in the live panel scripts must resolve to a real
// element, except ids with a documented dynamic lifecycle (allowlist below).
// Rule 0 §10 lock: fails loudly on the next writer/reader drift.
// Run: page_eval {path:"src/tests/item-treeshake-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:TREE]', id, detail); } catch (e) {} } }
try {
  // Dynamic-lifecycle ids (no static HTML definition by design):
  // - linkBanner: removed if left by an older build (setLink defensive cleanup).
  // - workerBanner: created/removed by refreshWorkers as the role changes.
  // - feedEmpty / chatEmpty: recreated by feedClear ('Feed cleared.') / removed on first chat line.
  const ALLOW = ['linkBanner', 'workerBanner', 'feedEmpty', 'chatEmpty'];
  const liveSrc = [...document.querySelectorAll('script')].filter(s => { const t = (s.type || '').toLowerCase(); return t === '' || t.indexOf('javascript') >= 0 || t === 'module'; }).map(s => s.textContent || '').join('\n');
  const ids = new Set();
  for (const m of liveSrc.matchAll(/\b(?:byId|setText)\(\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
  const bad = [];
  // A trailing-underscore id is a dynamic prefix (byId('gate_' + g)); its members are
  // proven by the family checks below, not here.
  ids.forEach(id => { if (ALLOW.includes(id) || id.endsWith('_')) return; if (!document.getElementById(id)) bad.push(id); });
  ck('TREE-ids-resolve', bad.length === 0, bad.length ? ('missing: ' + bad.join(',')) : (ids.size + ' static ids resolve'));
  // Dynamic families resolve completely (code list ↔ HTML defs). NOTE 2026-10-26:
  // there is no Character tab — personality lives in Behavior (About sweep
  // 10-18: "a section, not a tab"), so 'character' was dropped from this list.
  const fam = [
    ['gates', ['emoji', 'pings', 'everyone', 'links', 'channelLinks'].map(g => 'gate_' + g)],
    ['anchor-card', ['personaAnchorChk', 'personaNoteBox', 'personaClearBtn']],
    ['tabs-panes', 'activity setup behavior moderation people system about'.split(' ').flatMap(n => ['tab_' + n, 'pane_' + n])],
  ];
  fam.forEach(([name, list]) => { const m = list.filter(id => !document.getElementById(id)); ck('TREE-fam-' + name, m.length === 0, m.length ? ('missing: ' + m.join(',')) : (list.length + '/' + list.length + ' present')); });
  // Dials tree-shook 2026-10-22: no live code may reference them anymore (panel or probes).
  const dialIds = ['kindness', 'sarcasm', 'curiosity', 'playfulness', 'formality', 'verbosity'].map(k => 'dial_' + k);
  const dialSrcHits = dialIds.filter(id => liveSrc.indexOf("'" + id + "'") >= 0 || liveSrc.indexOf('"' + id + '"') >= 0);
  ck('TREE-no-dials', dialSrcHits.length === 0, dialSrcHits.length ? ('still referenced: ' + dialSrcHits.join(',')) : 'no dial references');
  // Reaction-notes anchor card is the replacement widget: all three ids must exist.
  const anchorMissing = ['personaAnchorChk', 'personaNoteBox', 'personaClearBtn'].filter(id => !document.getElementById(id));
  ck('TREE-anchor-card', anchorMissing.length === 0, anchorMissing.length ? ('missing: ' + anchorMissing.join(',')) : 'anchor card present');
} catch (e) { ck('TREE-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
