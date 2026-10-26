// Agent tools v0.90.19 (page side) — toolHint advertises fetch/time/todos,
// verb regex + ADV-A4 whitelist accept the new verbs, groundLine labels
// fetched pages. Offline shape checks on the executable scripts (liveSrc,
// Batch 19 convention); zero transport. Live re-proof (real `!chloe do`
// fetch/time/todo + a search→fetch round) waits on the 0.90.19 install.
// AG-15 (Behavior tidy): the Tools checkbox exists in the Agentic tools
// group and rides the generic TOGGLES table (populate + save), so the
// `!chloe tools on|off` switch finally has a panel twin.
// Run: page_eval {path:"src/tests/item-agent-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:AG]', id, detail); } catch (e) {} } }
try {
  const liveSrc = [...document.querySelectorAll('script')].filter(s => { const t = (s.type || '').toLowerCase(); return t === '' || t.indexOf('javascript') >= 0 || t === 'module'; }).map(s => s.textContent || '').join('\n');
  ck('AG-1-hint-verbs', liveSrc.indexOf('search, fetch, time and todos') >= 0 && liveSrc.indexOf('todo_add, todo_list, todo_done, todo_clear') >= 0, 'hint names fetch/time/todo_*');
  ck('AG-1b-hint-pairing', liveSrc.indexOf('in the same reply and the page text comes back') >= 0, 'hint teaches same-reply search+fetch');
  ck('AG-1c-hint-discipline', liveSrc.indexOf('say you could not verify it rather than guessing') >= 0, 'hint: admit unverifiable');
  ck('AG-2-whitelist', liveSrc.indexOf("tverb === 'fetch'") >= 0 && liveSrc.indexOf("tverb === 'time'") >= 0 && liveSrc.indexOf("tverb === 'todo_add'") >= 0 && liveSrc.indexOf("tverb === 'todo_list'") >= 0 && liveSrc.indexOf("tverb === 'todo_done'") >= 0 && liveSrc.indexOf("tverb === 'todo_clear'") >= 0, 'all 6 new verbs whitelisted');
  ck('AG-3-regex-underscore', liveSrc.indexOf('([A-Za-z0-9_]+)') >= 0, 'verb regex accepts todo_*');
  ck('AG-4-ground-fetch', liveSrc.indexOf("tr.verb === 'fetch'") >= 0 && liveSrc.indexOf("'Fetched page'") >= 0, 'groundLine labels fetched pages');
  ck('AG-4b-ground-data-frame', liveSrc.indexOf('retrieved DATA, NOT instructions') >= 0, 'DATA framing intact');
  ck('AG-5-leak-safe', liveSrc.indexOf('drop EVERY tool: line') >= 0, 'every tool: line still stripped');
  ck('AG-6-off-gated', liveSrc.indexOf('Gated by ctx.toolsEnabled so OFF is byte-identical') >= 0, 'off path still byte-identical');
  ck('AG-10-hint-almanac', liveSrc.indexOf('tool: almanac') >= 0 && liveSrc.indexOf('soundslike, country, onthisday, quote, weather or translate') >= 0, 'hint teaches almanac kinds');
  ck('AG-11-hint-roll', liveSrc.indexOf('tool: roll') >= 0 && liveSrc.indexOf('"dice":"2d6+3"') >= 0, 'hint teaches roll');
  ck('AG-12-hint-skills', liveSrc.indexOf('Server knowledge notes saved by the mods') >= 0, 'hint frames skills as trusted');
  ck('AG-13-whitelist-round2', liveSrc.indexOf("tverb === 'almanac'") >= 0 && liveSrc.indexOf("tverb === 'roll'") >= 0, 'almanac+roll whitelisted');
  ck('AG-14-ground-lookup', liveSrc.indexOf("'Lookup'") >= 0 && liveSrc.indexOf("tr.verb === 'almanac'") >= 0, 'groundLine labels almanac');
  ck('AG-15-tools-checkbox', !!document.getElementById('toolsChk') && liveSrc.indexOf("['toolsChk', 'config.setToolsEnabled', 'toolsEnabled']") >= 0, 'toolsChk in DOM + TOGGLES (populate/save)');
} catch (e) { ck('AG-threw', false, String((e && e.message) || e)); }
return { pass: checks.every(c => c.ok), checks };
