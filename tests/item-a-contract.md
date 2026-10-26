# Item A contract (FROZEN — Rule F §1, one written place)

Scope: command-bar + status-bar core indicators. Sources: `status` cmd value `s` (applyStatus), `bridge.status` value `v` (refreshWorkers), link boolean (setLink).

| badge | writer | inputs (real shapes) | states |
|---|---|---|---|
| runDot | applyStatus(s): `dot `+(s.running?on:off) | s.running bool | on=green, off=red; INITIAL `dot off` (F1: explicit stopped, Batch 1) |
| runTxt | applyStatus(s) | s.running bool | running/stopped |
| sb_run_dot | applyStatus(s) | s.running bool | on/off; INITIAL `dot off` (F1, Batch 1) |
| sb_run | applyStatus(s) | s.running bool | running/stopped (unified with runTxt, Batch 4) |
| linkDot | setLink(alive) | alive bool (refresh: false on !res.ok) | on/idle; INITIAL `dot idle` + waiting |
| linkTxt | setLink(alive) | alive bool | userscript linked / waiting for userscript… |
| verTxt | applyStatus(s): s.version \|\| – | s.version string\|missing | version or –; INITIAL `…` (unknown, F2 Batch 1) |
| tokTxt | applyStatus(s): s.hasToken?set:not set | s.hasToken bool\|missing→falsy | set/not set; INITIAL `…` (F2 Batch 1) |
| botTxt | applyStatus(s): s.botUserId? id:unverified | s.botUserId string\|missing | id/unverified; INITIAL `…` (F2 Batch 1) |
| sb_brain | applyStatus(s): s.brain.respond.{srtt,state} else running?warming:– | s.brain object\|missing; s.running | Nms / down (state open) / warming / –; INITIAL `…` (F2 Batch 1) |
| pollTxt | applyStatus(s): explicit reset `–` when s.lastPoll missing (F3 Batch 1); half-shape fields guarded per-field with `–` (F4 Batch 1) | s.lastPoll.{ingested,fetched} (each nullable) | "N new of M" (missing field → –) or –; INITIAL `…` (F2 Batch 1) |
| sb_workers_wrap/sb_workers | refreshWorkers(v): role queen+ids.length?show:hide | v.role string, v.workers object map | visible+N or display:none |
| bridgeRole | refreshWorkers(v): role+ids.length; unavailable on !res.ok | v.role, v.workers, v.poolSize | tabs: … queen · N workers / worker / ? / unavailable |

Where it runs: applyStatus needs `status` cmd (userscript) — probes call it directly with synthetic `s`. refreshWorkers needs `bridge.status` — probes call DOM branch directly OR stub call(). linkAlive global.
