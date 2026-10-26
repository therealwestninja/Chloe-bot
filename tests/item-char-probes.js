// Item CHAR probes — character import helpers (pure) + fetchRetry (injected) + ingest sink.
// No network, no live writes. CHARSTATE/DOM touched by C5 are snapshotted + restored.
// Run: page_eval {path:"src/tests/item-char-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:CHAR]', id, detail); } catch (e) {} } }
const charStateBk = JSON.stringify(CHARSTATE);
const charListEl = document.getElementById('charList');
const charListBk = charListEl ? charListEl.innerHTML : null;
const charCardBk = document.getElementById('charListCard') ? document.getElementById('charListCard').style.display : null;
const charStatusBk = document.getElementById('charStatus') ? document.getElementById('charStatus').textContent : null;
function restore() {
  try { const s = JSON.parse(charStateBk); Object.keys(CHARSTATE).forEach(k => delete CHARSTATE[k]); Object.assign(CHARSTATE, s); } catch (e) {}
  if (charListEl && charListBk !== null) charListEl.innerHTML = charListBk;
  if (charCardBk !== null) document.getElementById('charListCard').style.display = charCardBk;
  if (charStatusBk !== null) document.getElementById('charStatus').textContent = charStatusBk;
}
try {
  // C1 — file-id extraction: all three link forms + bare id + rejects
  const id24 = 'abcdef1234567890abcdef12';
  ck('C1-share-link', charExtractFileId('https://perchance.org/foo?data=xyz~' + id24 + '.gz') === id24 + '.gz', 'share link');
  ck('C1-uploads-link', charExtractFileId('https://user.uploads.dev/file/' + id24) === id24 + '.gz', 'uploads link');
  ck('C1-bare-id', charExtractFileId(id24) === id24 + '.gz' && charExtractFileId(id24 + '.gz') === id24 + '.gz', 'bare id ± suffix');
  ck('C1-rejects', charExtractFileId('hello') === null && charExtractFileId('abc123') === null && charExtractFileId('') === null, 'junk rejected');
  // C2 — lenient JSON: strict, scavenged, hopeless
  ck('C2-strict', JSON.stringify(charParseJsonLoose('{"a":1}')) === '{"a":1}', 'strict parse');
  ck('C2-scavenge', JSON.stringify(charParseJsonLoose('prefix {"a":2} trailing')) === '{"a":2}', 'scavenged');
  ck('C2-hopeless', charParseJsonLoose('no braces at all') === null, 'null on junk');
  // C3 — normalize: folds, defaults, skips presets, never mutates input
  const inp = { systemMessage: 'be kind', generalWritingInstructions: '@roleplay1', reminderMessage: 'smile' };
  const snap = JSON.stringify(inp);
  const n = charNormalize(inp);
  ck('C3-fold', n.instruction.includes('be kind') && n.instruction.includes('Keep in mind: smile') && !n.instruction.includes('@roleplay1'), 'fold+skip: ' + n.instruction.slice(0, 60));
  ck('C3-default-name', n.name === 'Unnamed', 'default name');
  ck('C3-pure', JSON.stringify(inp) === snap, 'input unmutated');
  // C4 — fetchRetry with injected transport (no waiting: sleep resolves instantly)
  const noSleep = () => Promise.resolve();
  const mkRes = (ok, status) => ({ ok, status, headers: { get: () => null } });
  let calls = 0;
  const flaky = () => { calls++; return Promise.resolve(calls < 3 ? mkRes(false, 500) : mkRes(true, 200)); };
  const r1 = await fetchRetry('http://x', { fetchImpl: flaky, sleep: noSleep, baseMs: 1, capMs: 2 });
  ck('C4-retry-then-ok', r1.ok && calls === 3, 'ok after 3 attempts');
  let calls404 = 0;
  const r404 = await fetchRetry('http://x', { fetchImpl: () => { calls404++; return Promise.resolve(mkRes(false, 404)); }, sleep: noSleep });
  ck('C4-404-fast', !r404.ok && calls404 === 1, 'non-retryable handed back');
  let netCalls = 0;
  const rNet = await fetchRetry('http://x', { fetchImpl: () => { netCalls++; return netCalls < 2 ? Promise.reject(new Error('down')) : Promise.resolve(mkRes(true, 200)); }, sleep: noSleep });
  ck('C4-net-retry', rNet.ok && netCalls === 2, 'network blip retried');
  // C5 — ingest sink: good object populates, junk fails clean
  const good = charIngestObject({ name: 'Probe', roleInstruction: 'be brief' }, 'probe');
  ck('C5-ingest-ok', good === true && CHARSTATE.chars.length === 1 && CHARSTATE.chars[0].name === 'Probe', 'one char picked up');
  const bad = charIngestObject(null, 'probe');
  ck('C5-ingest-null', bad === false, 'null rejected');
  const empty = charIngestObject({ nope: 1 }, 'probe');
  ck('C5-ingest-empty', empty === false, 'charless rejected');
} catch (e) { ck('C0-no-throw', false, String((e && e.message) || e)); }
restore();
const pass = checks.every(c => c.ok);
return { pass, checks };
