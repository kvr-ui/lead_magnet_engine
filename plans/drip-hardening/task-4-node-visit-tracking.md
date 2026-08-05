---
task: 4
name: node-visit-tracking
parallel_group: 1
depends_on: []
issue: 32
---

# Task 4: Track per-node visits in CampaignNodeVisit

## What to build

Per-node funnel counts cannot be reconstructed from data the system persists today. An
enrollment's `history[]` only ever receives entries whose `kind` is `message` or
`action` — decision nodes (`filter`, `condition`, `split`, `goal`, `wait`, `source`,
`exit`) deliberately write nothing, because decisions chain inside a single tick and
only a send, wait, action or park ends one.

The walker already computes exactly what is needed: `result.visited` accumulates every
node the tick passes through, of every kind. It is then used only to build a hop-limit
error message and thrown away.

Persist it into a new collection.

**Model** — `CampaignNodeVisit`: `{ campaign, graphVersion, nodeId, enrollment,
firstVisitedAt }`, with a unique index across campaign + graphVersion + nodeId +
enrollment, plus a lookup index on campaign + graphVersion. One row per lead per node
per graph version, ever. Writes use `$setOnInsert` so a revisit — a loop back through a
wait node, say — is a no-op. This counts distinct leads rather than events, matching the
`$addToSet` idiom the existing delivery rollups already use.

**Instrumentation** — in `walkEnrollment`'s outer wrapper, beside the existing
`applyWalkResult` call and **not** inside the walk itself, issue a fire-and-forget
`bulkWrite` of upserts built from `result.visited`, gated on `!dryRun` and guarded with
`.catch()` that logs. Analytics must never be able to throw into the walk, must never
delay it, and must never violate the dry-run guarantee of zero side effects. `runWalk`
and `applyWalkResult` themselves stay untouched.

**Historical data is unrecoverable and must not be faked.** Decision-node visits that
happened before this ships were never persisted anywhere, so nothing can backfill them.
A one-off backfill script may optionally seed rows from what *is* recoverable — one row
per message/action history entry, plus one for each enrollment's current
`currentNodeId` — but it must not guess at paths already walked and left behind. Whether
the script ships is your call; if it does, it goes in `backend/node/tools/`.

**Boundary:** this task writes the data only. It does NOT add the aggregation endpoint
(task 10) or any canvas rendering (task 13). It does not touch the message-node block of
the walker (tasks 2 and 7) or the condition evaluators (task 9).

## Acceptance criteria

- [ ] `models/CampaignNodeVisit.js` exists with the fields and unique index described
- [ ] Walking an enrollment writes one row per visited node, including decision nodes that write no history
- [ ] Revisiting a node does not create a second row and does not move `firstVisitedAt`
- [ ] Rows carry the enrollment's pinned `graphVersion`, not the campaign's live version
- [ ] A dry run writes zero rows
- [ ] A failure of the visit write is caught and logged and does not affect the walk's result or the enrollment
- [ ] `runWalk` and `applyWalkResult` are unchanged; the instrumentation lives in `walkEnrollment`'s wrapper
- [ ] `walkEnrollment` still never throws
- [ ] `backend/node/tools/verify-node-visits.js` drives a graph containing filter/condition/wait nodes and asserts rows appear for kinds that write no history

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
