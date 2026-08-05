# Plan: node-graph-campaigns

## Goal

Turn campaigns from a flat, hardcoded `steps[]` array into a versioned graph of typed, reusable nodes that an admin builds on a visual canvas. Connecting a new lead-magnet database becomes a pure configuration act: connect it in the Data Sources tab, drop a Source node on a canvas, map its fields to canonical keys once, and wire it into any existing drip — with no code change anywhere. Along the way the system gains the three things it structurally cannot do today: wait between messages, branch on lead behaviour, and put lead values into templates. It also gains global STOP/opt-out handling, which does not exist at all.

## Approach

`Campaign` keeps its identity but its body becomes `draft: { nodes, edges }` plus an append-only `versions[]` array. Publishing snapshots the draft as a new version; each `CampaignEnrollment` records the `graphVersion` it entered on and walks that snapshot to completion, so editing a flow can never strand a lead mid-drip.

Nine node kinds: `source`, `filter`, `message`, `wait`, `condition`, `split`, `goal`, `action`, `exit`. The keystone is the **Source node's canonical map** — each source declares once how its raw fields (`phoneNumber`, `firstName`, `caStatus`) map to canonical keys (`phone`, `name`, `stage`). Every downstream node reads only canonical keys, which is what makes a single Message node work against any source, lets multiple differently-shaped sources feed one graph, and deletes the phone-field guessing heuristic entirely.

`advanceEnrollment` becomes a graph walker: resolve the pinned version, look up `currentNodeId`, dispatch on `kind`, follow the matching edge. Non-sending nodes are traversed within one tick; `message` and `wait` end the tick. A per-tick hop limit is the runtime backstop against a cycle containing no wait.

The two rival source resolvers collapse into one. Opt-out is deliberately **not** a node — it is global, always-on, and unskippable, because compliance must not be something an admin can forget to draw.

Migration is in place: existing `steps[]` become a linear chain of message nodes with deterministic ids, `currentStepIndex` maps to the equivalent `currentNodeId`, and queued enrollments resume exactly where they were. One engine, not two.

## Decisions & Rejected Alternatives

- **Visual canvas (`@xyflow/react`), not a configurable list** — the request was explicitly for connectable nodes. Rejected: a typed-block list UI (cheaper, same data model, but not what was asked for) and canvas-later (defers the only visible payoff).
- **Multiple Source nodes feeding one graph** — `CampaignEnrollment` already carries `targetModel` per row with a unique index on `(campaign, targetModel, targetId)`, so a source union needs no enrollment change. Rejected: one source per flow (would force duplicating a flow per lead magnet, i.e. the copy-paste this plan exists to remove).
- **Canonical field map on the Source node** — the single decision that makes nodes reusable across differently-shaped sources, and the one that lets `guessPhoneField`/`PHONE_FIELD_CANDIDATES` be deleted rather than worked around. Rejected: per-Message-node mapping (re-declares the mapping in every node — the same hardcoding in a new place).
- **Live re-read of source data at send time**, not a snapshot frozen at enroll. Rejected: enroll-time snapshot (faster and survives source outages, but a message sent on day 7 would render day-0 values, defeating condition nodes that branch on current state).
- **Presets copy on insert** — editing a preset must never mutate a campaign that is mid-send. Rejected: live-linked shared nodes (maximum reuse, but a typo fix would rewrite the flow under ~951 in-flight leads).
- **Draft → Publish with enrollments pinned to a version** — makes "someone deleted the node 951 leads are sitting on" structurally impossible. Rejected: live edit with orphan parking (cheap but needs manual cleanup and shows leads a graph they did not sign up for); locking structural edits while active (no new schema, but blocks iteration without pausing sends).
- **Migrate in place, one engine** — rejected: a parallel `Flow` model beside `Campaign` (zero migration risk, but two engines, two UIs and two schedulers forever); migrate-and-reset (clean, but leads who already received messages 1 and 2 would get message 1 again).
- **Opt-out is global and not drawable** — a flow where someone forgot to wire the STOP node keeps messaging people who said stop, which costs WhatsApp template limits and can flag the business number. Rejected: an opt-out node wired per flow.
- **Re-entry stays impossible; keep the unique index** — it is what makes the 5-minute auto-enroll rescan idempotent. Rejected: re-entry with cooldown, and unlimited concurrent re-entry (would make every rescan tick a potential repeat blast).
- **Wait = relative delay + send window + quiet hours.** Rejected: plain delay (a 2-day wait armed at 23:00 fires at 23:00); wait-for-event (a Condition node evaluated after a Wait covers the same ground without event-driven wake-ups); absolute-time waits.
- **Message-ID extraction stays duplicated** — `campaignEngine` and `wati.js` check different ID fields in different orders. A real latent backfill bug, but unrelated to this refactor; explicitly deferred rather than silently bundled.
- **No test framework and no publish-time graph validation** — accepted deliberately. The walker's per-tick hop limit is the runtime backstop instead of static cycle detection, and verification rides on the existing `tools/verify-*.js` script pattern plus an env-gated phone allowlist.

## Tasks

| # | Task | Phase | Depends on | Status |
|---|------|-------|------------|--------|
| 1 | global-opt-out | 1 | — | pending |
| 2 | unified-source-resolver | 1 | — | pending |
| 3 | graph-schema | 1 | — | pending |
| 4 | phone-allowlist | 1 | — | pending |
| 5 | graph-walker | 2 | 2, 3 | pending |
| 6 | migration-script | 2 | 3 | pending |
| 7 | backend-stepindex-readpaths | 2 | 3 | pending |
| 8 | campaign-graph-api | 2 | 2, 3 | pending |
| 9 | verify-graph-walk-harness | 3 | 5, 6 | pending |
| 10 | flow-canvas-editor | 3 | 8 | pending |
| 11 | frontend-columns-and-node-labels | 4 | 7, 10 | pending |
| 12 | advanced-node-handlers | 4 | 5, 9 | pending |
| 13 | retire-admagnet | 4 | 2, 9 | pending |
| 14 | node-presets-and-duplicate-flow | 5 | 10, 12 | pending |

## Execution phases

- **Phase 1 (parallel):** task-1, task-2, task-3, task-4
- **Phase 2 (parallel):** task-5, task-6, task-7, task-8
- **Phase 3 (parallel):** task-9, task-10
- **Phase 4 (parallel):** task-11, task-12, task-13
- **Phase 5:** task-14

Task 1 (global opt-out) carries no dependencies deliberately, so it lands in the first parallel wave — roughly 5,982 leads are queued to auto-enroll and the system currently has no STOP handling at all.

Tasks that edit the same file are separated across phases rather than run in parallel: `CampaignsTab.jsx` is touched by task-10 and task-11, and task-11 is placed in phase 4 specifically so the two never run concurrently.

## Shared reference

Canonical node config shapes, the enrollment field migration, and the full 13-site blast radius of the `currentStepIndex` → `currentNodeId` change are specified in the individual task files. The authoritative statements of intent are the Decisions section above and the grilling record on the parent issue.

## Task issues

- [ ] #2 — phase 1 — Global WhatsApp opt-out (STOP keyword handling)
- [ ] #3 — phase 1 — Collapse the two source resolvers into one canonical `sourceResolver.js`
- [ ] #4 — phase 1 — Versioned graph schema for Campaign and CampaignEnrollment
- [ ] #5 — phase 1 — Env-gated send allowlist for real end-to-end drip testing
- [ ] #6 — phase 2 — Replace advanceEnrollment with a versioned graph walker
- [ ] #7 — phase 2 — One-time `steps[]` → graph migration script for live campaign data
- [ ] #8 — phase 2 — Migrate backend read paths off `history[].stepIndex` to `history[].nodeId`
- [ ] #9 — phase 2 — Campaign HTTP API for the versioned graph (draft, publish, versions, graph-aware preview/enroll)
- [ ] #10 — phase 3 — Standalone verification script for the graph walker and migration
- [ ] #11 — phase 3 — Visual flow canvas editor for campaign graphs
- [ ] #12 — phase 4 — Kill hardcoded source columns and replace step numbers with node labels in the frontend
- [ ] #13 — phase 4 — Implement the split, goal, and action node handlers
- [ ] #14 — phase 4 — Retire the hardcoded AdMagnetStudent source in favor of a generic DataSourceConnection
- [ ] #15 — phase 5 — Node presets, duplicate-flow, and the split/goal/action config panels
