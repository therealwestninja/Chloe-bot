// Item M probes — People memory editor (memRow construction + safe interactions).
// No document attachment (rows stay detached); one harmless live round-trip (M5 delete of a
// fake id → engine 'not found', exercises the Batch 13 fail log). Link-up safe.
// Run: page_eval {path:"src/tests/item-m-probes.js"}. Returns {pass, checks}.
const checks = [];
function ck(id, ok, detail) { checks.push({ id, ok: !!ok, detail: String(detail || '') }); if (!ok) { try { console.error('[wire:M]', id, detail); } catch (e) {} } }
const feedN0 = document.querySelectorAll('#chatLog .ev').length;
function feedTail(n) { return [...document.querySelectorAll('#chatLog .ev .msg')].slice(-n).map(e => e.textContent); }
try {
  // M1 — fact row DOM: textarea value, importance input (default 5), delete button
  const fr = memRow('u1', 'fact', { id: 'f1', text: 'likes dogs', importance: 7 });
  ck('M1-fact-dom', fr.querySelector('textarea').value === 'likes dogs' && fr.querySelector('input.memimp') && fr.querySelector('input.memimp').value === '7' && !!fr.querySelector('button.memx'), 'fact row shaped');
  const frd = memRow('u1', 'fact', { id: 'f2', text: 'x' });
  ck('M1-fact-imp-default', frd.querySelector('input.memimp').value === '5', 'importance defaults 5');
  // M2 — insight row DOM: no importance input
  const ir = memRow('u1', 'insight', { id: 'i1', text: 'night owl' });
  ck('M2-insight-dom', ir.querySelector('textarea').value === 'night owl' && !ir.querySelector('input.memimp') && !!ir.querySelector('button.memx'), 'insight row shaped');
  // M3 — construction triggers no transport (feed untouched)
  ck('M3-no-call-on-build', document.querySelectorAll('#chatLog .ev').length === feedN0, 'feed unchanged by construction');
  // M4 — blur without edits: not dirty → no call, no log
  const ta = fr.querySelector('textarea');
  ta.dispatchEvent(new Event('blur', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  ck('M4-blur-clean-silent', document.querySelectorAll('#chatLog .ev').length === feedN0, 'clean blur silent');
  // M5 — delete of unknown id: live fail → Batch 13 fail log, row NOT removed (detached: parentNode null)
  const n5 = document.querySelectorAll('#chatLog .ev').length;
  fr.querySelector('button.memx').click();
  let seen = '';
  for (let i = 0; i < 20; i++) { await new Promise(r => setTimeout(r, 500)); const t = feedTail(3).join(' / '); if (t.includes('delete memory failed')) { seen = t; break; } }
  ck('M5-delete-fail-loud', !!seen, seen.slice(0, 120) || 'no fail log within 10s');
  ck('M5-delete-keeps-row', !!fr.querySelector('textarea'), 'row survives failed delete');
  // M6 — operator-source tag
  const or = memRow('u1', 'fact', { id: 'f3', text: 'y', source: 'operator' });
  ck('M6-op-tag', or.textContent.includes('added by you'), 'operator tag present');
} catch (e) { ck('M0-no-throw', false, String((e && e.message) || e)); }
const pass = checks.every(c => c.ok);
return { pass, checks };
