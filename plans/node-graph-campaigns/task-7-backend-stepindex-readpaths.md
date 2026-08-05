---
task: 7
name: backend-stepindex-readpaths
parallel_group: 2
depends_on: [3]
issue: 8
---

# Task 7: Migrate backend read paths off `history[].stepIndex` to `history[].nodeId`

## What to build

This is a WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node` using Mongoose, React 19 + Vite frontend at `frontend/admin-ui`, WATI as the WhatsApp provider). Task 3 (`graph-schema`) renamed `CampaignEnrollment.history[].stepIndex` — a `Number` that indexed into the old flat `steps[]` array — to `history[].nodeId`, a `String` that identifies a node in the campaign's graph. That rename landed in the schema, but several backend read paths outside the schema itself still assume an integer step index. This task is the cleanup pass: find every remaining place that reads, projects, or seeds `stepIndex` and bring it in line with `nodeId`, without changing anything about how the graph itself is walked or migrated.

Fix these four sites:

1. **`backend/node/routes/messageEvents.js` line 213** — inside the `campaignBranch` aggregation pipeline that powers `GET /api/sends`, the `$project` stage has `stepIndex: "$history.stepIndex"`. Change the projected field name and its source path so it reads `nodeId: "$history.nodeId"`.

2. **`backend/node/routes/messageEvents.js` line 296** — in the same `GET /api/sends` handler, the response row's `_id` is built as `` `${r.enrollmentId}-${r.stepIndex}` `` for `kind === "campaign"` rows (to disambiguate the several sends that share one enrollment, since `$unionWith` merges campaign-history rows with `DirectMessage` rows into one paged, sorted set). This must become `` `${r.enrollmentId}-${r.nodeId}` ``, sourced from the renamed projection in fix 1. Call this site out explicitly when reviewing the change — it is the easiest of the four to miss, because it is buried inside a template-literal string concatenation rather than an obvious `.stepIndex` field read, and nothing will throw or visibly break if it's left stale; it will just silently produce wrong-but-plausible-looking row keys (or keys that collide) once `history.stepIndex` no longer exists on new documents.

3. **`backend/node/routes/messageEvents.js` lines 111-138 and 160-170** — two related handlers that currently have no `stepIndex` reference at all today but need one added, in its new `nodeId` form, to unblock task 11 (frontend, depends on this task):
   - The enrollment detail endpoint, `GET /api/enrollments/:id` (roughly lines 111-138 today: it loads the `enrollment`, `campaign`, and `events` via `Promise.all`, then resolves the lead through `getAdapter`/`adapter.findById`). Extend this handler so its response lets the UI show *which step* the enrollment is at and *which steps* it has passed through by name, not by a raw id: for `enrollment.currentNodeId` and for each `enrollment.history[].nodeId`, resolve the node's `label` and (for message-kind nodes) `templateId` from the campaign's pinned graph version — use `enrollment.graphVersion` to look up the matching entry in `campaign.versions` (falling back sensibly if the campaign's `draft` is the only thing that makes sense to fall back to — but the graph a specific enrollment is walking is always the `versions[]` entry matching its `graphVersion`, per task 3's pinning guarantee, so prefer that first). Attach the resolved `label`/`templateId` alongside `nodeId` in the response, either by decorating `history` entries in place or via a small lookup map included in the payload — either shape is fine as long as the frontend can pair a `nodeId` with its `label`/`templateId` without doing its own graph traversal.
   - The per-enrollment event timeline, `GET /api/enrollments/:id/events` (roughly lines 160-170 today: it loads `MessageEvent` rows for the enrollment, sorted oldest-first). Where those events correspond to steps recorded in the enrollment's `history` (matched the way this endpoint already correlates events to sends, e.g. via `providerMessageId`/`providerLocalMessageId` or whatever correlation the existing code already does — do not invent a new correlation strategy), include the same resolved `nodeId` + `label` + `templateId` so the timeline can name each step instead of numbering it.
   
   Task 11 (frontend) consumes exactly these two fields (`label`, `templateId`) alongside `nodeId` from these two endpoints — match that shape, since task 11 depends on this task and will be built against what you deliver here.

4. **`backend/node/tools/verify-webhook.js` line 75** and **`backend/node/tools/verify-direct-send.js` lines 132 and 184** — these are the project's manual verification scripts (fixture-seeding + assertion scripts, not an automated test suite), and they still seed/assert the old field:
   - `verify-webhook.js:75` seeds a `CampaignEnrollment.history` fixture entry as `{ stepIndex: 0, templateId: "verify_tpl", sentAt: new Date(), status: "sent" }`. Change `stepIndex: 0` to `nodeId: <some string node id>` — pick a value consistent with whatever the rest of that script's fixture campaign/graph uses to identify its message node (introduce a small literal node id constant if the script doesn't already have graph fixtures to borrow from).
   - `verify-direct-send.js:132` seeds a similar `history` fixture entry with `stepIndex: 0`; change it the same way.
   - `verify-direct-send.js:184-185` asserts `campaignRow?.stepIndex === 0` and logs `` `${campaignRow?.campaignName} step ${campaignRow?.stepIndex}` ``. Update both to assert and log against `campaignRow?.nodeId` instead, matching whatever `nodeId` value the fixture in line 132 now seeds.
   Both scripts must still run to completion and pass after these edits — they exercise the exact `GET /api/sends` code path touched by fixes 1 and 2, so they are the fastest way to confirm those fixes are correct end-to-end.

**Boundary — do not touch in this task:**
- Do not edit any frontend file under `frontend/admin-ui`. The UI changes that consume the `label`/`templateId`/`nodeId` fields added in fix 3 are task 11, which depends on this task specifically so it can build against a finished API contract.
- Do not touch the graph walker (task 5) — this task only changes how already-written `history` data is read back out, not how the walker advances an enrollment or writes new `history` entries.
- Do not touch the `steps[]` → graph migration script (task 6) — that script is a separate one-time data migration; this task is about live backend read paths.
- Do not change the `CampaignEnrollment` or `Campaign` schemas — those were already updated by task 3. This task only touches route handlers, the aggregation pipeline, and the two verify scripts.

## Acceptance criteria

- [ ] `GET /api/sends` (in `backend/node/routes/messageEvents.js`) returns `nodeId` (not `stepIndex`) for campaign-kind rows, correctly sourced from `history.nodeId` via the aggregation's `$project` stage.
- [ ] Each campaign-kind row's `_id` in the `GET /api/sends` response is built from `nodeId`, not `stepIndex`, and remains unique per history entry (no collisions introduced for enrollments with multiple history entries).
- [ ] `GET /api/enrollments/:id` returns, for `currentNodeId` and for each `history[]` entry, the corresponding node's `label` and (where applicable) `templateId`, resolved from the `versions[]` entry matching the enrollment's `graphVersion`.
- [ ] `GET /api/enrollments/:id/events` returns the same `nodeId`/`label`/`templateId` information alongside each event that corresponds to a `history` entry, using the endpoint's existing event-to-send correlation logic.
- [ ] `GET /api/campaigns/:id/delivery` (or whichever existing delivery-summary endpoint aggregates by step) continues to return correct data keyed by `nodeId`, with no residual `stepIndex` grouping.
- [ ] `backend/node/tools/verify-webhook.js` runs to completion and passes after being updated to seed `nodeId` instead of `stepIndex`.
- [ ] `backend/node/tools/verify-direct-send.js` runs to completion and passes after being updated to seed and assert `nodeId` instead of `stepIndex`.
- [ ] A full-repo grep for `stepIndex` under `backend/node` (excluding `node_modules`) returns no remaining reads of `history[].stepIndex` or `currentStepIndex` in application code.
- [ ] No frontend file is modified by this task.

## Commit convention

Your commit message MUST include `Closes #8` so the task's GitHub issue closes when the commit lands on the default branch.
