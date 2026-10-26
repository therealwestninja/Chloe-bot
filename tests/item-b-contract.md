# Item B contract (FROZEN)

Scope: People badges. Writers: renderRoster(list) ← `roster.get`; syncBatchBar() ← checkbox change; renderMods(list) ← `mod.listMods`; renderBanned(rows) ← `mod.listBanned`; noticeState ← applyStatus(s.noticePinned).

Real shapes (from code):
- person p: {id: string (data-id string), name: string|null → "(unnamed)", state: string (default 'active'), strikes: number|missing, lastSeen: ms epoch|missing → fmtTime→'–', recent: array|missing → length}
- MOD: window.__modSet[id] truthy → span.ubadge "MOD" appended to .uname
- ustate: class 'ustate '+stateName with whitespace→hyphens (Batch 5: engine 'soft ban' → amber .soft-ban); text keeps raw stateName + (strikes? ' · N strike(s)') — CSS colors only .active/.ignored/.soft-ban/.timeout
- rosterCount: N + ' person'/' people'; rosterEmpty display none/block (block iff empty)
- batch: rosterSelected() reads #rosterList .usel:checked data-id; batchBar flex/none; batchCount "N selected"; row .checked class; rosterAll checked iff sel==__roster.length>0
- modCount: N + ' mod'/' mods'; modListBox rows or empty note
- banned: rows [{id,name,reason,at}] or empty → bannedEmpty show/hide
- noticeState: s.noticePinned ? 'pinned ✓' : 'not pinned'
