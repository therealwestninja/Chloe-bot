// Batch 20 probes — clearBox helper (ten remove-all-children loops → one helper).
// Fully offline: unit proof on a detached node + live-source shape check that no
// inline remove-firstChild loop remains. Behavior rides the full-board re-green
// (B renders the roster, C clears the feed, B10 drives the channel selector).
// Run: page_eval {path:"src/tests/item-batch20-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:B20]', id, detail); } catch (e) {} } }
try {
  // B20-1 — unit: clears a populated node, no-op on an empty one
  const d = document.createElement('div');
  d.appendChild(document.createElement('span')); d.appendChild(document.createElement('b'));
  clearBox(d);
  ck('B20-1-unit', d.childNodes.length === 0, 'children after clear=' + d.childNodes.length);
  let threw = false;
  try { clearBox(d); } catch (e) { threw = true; }
  ck('B20-2-empty-noop', !threw, 'empty clear silent');
  // B20-3 — no inline remove-firstChild loop survives in the live scripts
  const liveSrc = [...document.querySelectorAll('script')].filter(s => { const t = (s.type || '').toLowerCase(); return t === '' || t.indexOf('javascript') >= 0 || t === 'module'; }).map(s => s.textContent || '').join('\n');
  ck('B20-3-one-loop', (liveSrc.match(/while \([a-zA-Z]+\.firstChild\)/g) || []).length === 1 && liveSrc.indexOf('function clearBox(el)') >= 0, 'loops=' + ((liveSrc.match(/while \([a-zA-Z]+\.firstChild\)/g) || []).length));
  // B20-4 — helper defined once and used at all ten call sites (9 clearBox( + feedClear)
  const uses = (liveSrc.match(/clearBox\(/g) || []).length;
  ck('B20-4-ten-uses', uses >= 10, 'clearBox( occurrences=' + uses);
} catch (e) { ck('B20-0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
