---
task: 6
name: migration-script
parallel_group: 2
depends_on: [3]
issue: 7
---

# Task 6: One-time `steps[]` → graph migration script for live campaign data

## What to build

Task 3 has already changed the schema underneath this data: `Campaign` loses `targetModel` and `steps[]` and gains `draft: { nodes, edges }`, `versions: [{ version, nodes, edges, publishedAt }]` and `liveVersion`; `CampaignEnrollment` renames `currentStepIndex` (Number) to `currentNodeId` (String), renames `history[].stepIndex` to `history[].nodeId`, and adds a required `graphVersion` (Number). This task writes the one-time script that converts the *live data* sitting in Mongo into that new shape — this runs against roughly 1,111 existing enrollments, about 951 of which are currently sitting `active`/due in the send queue with a `nextSendAt` already scheduled. The decision this plan settled on is migrate-in-place with a single engine: a lead that is mid-drip today must resume from exactly the message it was about to receive next, not restart from the first step and not lose its scheduled send time.

Because this script runs directly against production-shaped data before any route or UI depends on the new shape, it has to be conservative, idempotent, and legible in its own output — there is no second chance to re-run it blind against already-mutated documents.

Deliver `backend/node/tools/migrate-to-graph.js`, following the existing standalone-script pattern used by `backend/node/tools/verify-webhook.js` and `backend/node/tools/verify-direct-send.js`: a plain Node script (no test framework, no CLI framework) that connects to Mongo through `db.js`'s `connectDB()`, does its work, prints a clear human-readable summary, and exits — not an Express route, not something wired into app boot.

**Per campaign**, build a linear graph from the old `targetModel` + `steps[]`:
- `n0` = `{ id: "n0", kind: "source", config: { sourceId: <old campaign.targetModel value>, filter: <campaign.autoEnrollFilter, or {} if it was empty/unset>, map: {} } }`. `map` is intentionally left empty — task 3's canonical-map mechanism doesn't have historical data to backfill it from; a later task/admin action populates it.
- for each entry `steps[i]` (0-indexed), a node `n{i+1}` = `{ id: "n{i+1}", kind: "message", config: { templateId: steps[i].templateId, providerMeta: steps[i].providerMeta, params: [] } }` — `params` starts empty because the old flat steps had no per-recipient variable slots to carry over.
- append one terminal node, `kind: "exit"`, after the last message node (pick an id that cannot collide with the `n{i}` sequence, e.g. `"exit"`).
- `edges` chain them in order: `n0 -> n1 -> n2 -> ... -> n{steps.length} -> exit`, one edge per hop, no branches.
- Write this graph as `versions[0]`: `{ version: 1, nodes, edges, publishedAt: <a timestamp — use campaign.updatedAt or now, be consistent> }`. Set `liveVersion = 1`. Copy the identical `nodes`/`edges` into `draft` as well, so the campaign opens in the canvas editor showing exactly what's live rather than an empty draft.
- Leave `autoEnroll` and `autoEnrollFilter` completely untouched — they keep their old meaning and their old values; only the graph shape changes.
- Positions: since there was never a canvas before, synthesize simple, deterministic `position: { x, y }` values for each node (e.g. evenly spaced left-to-right) — they just need to exist and not collide, later editing can rearrange them.

**Per enrollment**, once its campaign has been migrated:
- `graphVersion = 1` (every migrated campaign's migrated graph is version 1).
- `currentNodeId`: if `n{currentStepIndex + 1}` exists as a node id in the campaign's `versions[0].nodes`, use it. Otherwise (the old `currentStepIndex` pointed past the last step — the lead had already finished the sequence) use the exit node's id. This is the exact rule that keeps a lead who was mid-drip resuming from its next message rather than restarting: an enrollment previously at `currentStepIndex: 1` must land on `n2`, i.e. the node representing the step it had not yet received.
- `history[].nodeId = "n{stepIndex + 1}"` for every history entry, replacing `stepIndex` — this is a pure rename/relabel of already-sent history, not a re-derivation, so also drop the old `stepIndex` key rather than leaving both fields present.
- Do not touch `status`, `nextSendAt`, `phone`, `targetModel`, `targetId`, or any `history[]` field other than the `stepIndex` → `nodeId` rename. The ~951 `active` enrollments with a `nextSendAt` already due must come out of this script still `active` with the same `nextSendAt`, so they resume on the existing schedule instead of being re-queued or delayed.

**Idempotency.** The script must be safe to run twice (and to run, discover a partial prior run, and finish it). Before migrating a campaign, detect whether it has already been migrated (e.g. `versions` already non-empty / `liveVersion` already set / `steps` field already absent) and skip it, counted separately from campaigns actually migrated. Same for enrollments: detect an already-migrated enrollment (e.g. `currentNodeId` already present / `graphVersion` already set) and skip it. A second full run against already-migrated data must change zero documents.

**`--dry-run` flag.** When passed, the script performs every read and every computation it normally would, prints the exact same summary it would after a real run (including per-campaign and aggregate counts), but issues zero writes to Mongo. This must be genuinely dry — no `updateOne`/`save`/`bulkWrite` calls execute, not even inside a transaction that gets rolled back.

**Summary output.** On any run (dry or real), print at minimum: number of campaigns found, number of campaigns migrated, number of campaigns skipped (already migrated) with the reason, number of campaigns that failed to migrate with why; the same three counts (migrated / skipped / failed, each with reasons) for enrollments. Make the output legible enough that someone watching stdout against live production data can tell at a glance whether it's safe to proceed from `--dry-run` to a real run.

**Boundary — do not do this in task 6:**
- Do not delete the `AdMagnetStudent` source or touch `backend/node/routes/adMagnet.js` — that's task 13 (retire-admagnet), which this task's `sourceId` values may still reference (`AdMagnetStudent` stays a valid `sourceId` after migration, unchanged).
- Do not touch any frontend file.
- Do not modify the graph walker (`lib/campaignEngine.js`'s advance logic, or wherever task 5 lands it) — this script only rewrites data, it does not change how enrollments get advanced.
- Do not implement or call `resolveSource`/`sourceResolver.js` (task 2) — the migration only needs the old `targetModel` string value copied into `config.sourceId`, not source resolution.

## Acceptance criteria

- [ ] `backend/node/tools/migrate-to-graph.js` exists, connects via `db.js`'s `connectDB()`, and follows the standalone-script pattern of `tools/verify-webhook.js` / `tools/verify-direct-send.js` (no test framework, no route, not wired into app boot).
- [ ] Running with `--dry-run` performs all reads/computation and prints the full planned summary (campaigns/enrollments to migrate, skip, fail — with reasons) but writes nothing to Mongo — verified by comparing collection contents before and after the dry run.
- [ ] For a campaign with `steps.length === N`, the migrated graph has exactly `N + 2` nodes (`n0` source, `n1..nN` message, one exit) and `N + 1` edges chaining them in order with no branches.
- [ ] `versions[0].version === 1`, `liveVersion === 1`, and `draft.nodes`/`draft.edges` are identical to `versions[0].nodes`/`versions[0].edges` immediately after migration.
- [ ] `n0.config.sourceId` equals the old `campaign.targetModel` value, and `n0.config.filter` equals `campaign.autoEnrollFilter` (or `{}` if it was empty/unset); `campaign.autoEnroll` and `campaign.autoEnrollFilter` themselves are byte-for-byte unchanged by the script.
- [ ] For every migrated enrollment, `currentNodeId` resolves to a node id that actually exists in that enrollment's pinned `versions[0]` (i.e. `graphVersion === 1` and that node is present) — no enrollment ends up pointing at a nonexistent node.
- [ ] An enrollment previously at `currentStepIndex: 1` ends up with `currentNodeId === "n2"`.
- [ ] An enrollment previously at a `currentStepIndex` at or past `steps.length` (already finished the old sequence) ends up with `currentNodeId` equal to the exit node's id.
- [ ] Every `history[]` entry's old `stepIndex` is replaced by `nodeId === "n{stepIndex + 1}"`, and the old `stepIndex` key is not left behind alongside it.
- [ ] For every migrated enrollment, `status`, `nextSendAt`, `phone`, `targetModel`, and `targetId` are unchanged from their pre-migration values — in particular, `active` enrollments with a due `nextSendAt` remain `active` with the same `nextSendAt` (they resume, they do not restart or get re-queued).
- [ ] Running the script a second time against already-migrated data changes zero documents and reports those campaigns/enrollments as skipped (already migrated), not migrated again.
- [ ] The printed summary's counts (migrated/skipped/failed for both campaigns and enrollments) match the actual number of documents changed, verified against the database state before/after a real (non-dry-run) run.
- [ ] `AdMagnetStudent`-sourced campaigns migrate the same as any other `targetModel` value, and `routes/adMagnet.js` is untouched.

## Commit convention

Your commit message MUST include `Closes #7` so the task's GitHub issue closes when the commit lands on the default branch.
