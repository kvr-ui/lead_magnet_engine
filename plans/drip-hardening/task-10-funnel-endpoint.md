---
task: 10
name: funnel-endpoint
parallel_group: 2
depends_on: [4]
issue:
---

# Task 10: Per-node funnel aggregation endpoint

## What to build

With per-node visits now recorded (task 4), expose them as a funnel an operator can read:
for one campaign and one graph version, how many distinct leads reached each node, how
many sends from that node succeeded or errored, and how many leads are sitting at that
node right now.

Build a single read endpoint returning, per node id:

- **reached** — distinct leads that visited the node, from the visit collection.
- **sent** and **error** — from the enrollments' history entries for that node, counted
  as distinct leads rather than raw entries, matching the idiom the existing delivery
  rollups already use.
- **parkedHere** — leads whose current position is this node and whose status is active,
  paused or failed, so a blockage is visible as a number rather than as an absence.

**Scope strictly by graph version.** A node id is only meaningful inside the version that
declared it; a node id from version 1 may not exist in version 3, or may mean something
structurally different. The endpoint takes an explicit graph version, defaulting to the
campaign's live version, and counts only enrollments pinned to it. Enrollments on other
versions are reported as a single total with no per-node breakdown, so a caller can say
"plus N leads on older versions" without placing them on nodes that may not exist in the
version being viewed. This mirrors how the existing per-node message rollup already
resolves strictly against the version an enrollment actually walked.

Keep the endpoint a dumb counter — no edge topology, no drop-off percentages, no
inference about what the numbers mean. Its caller composes those.

Place it beside the existing per-campaign delivery rollup, which already owns the
node-index and describe-node helpers this needs; reuse them rather than re-deriving the
graph.

**Boundary:** this task is read-only aggregation. It does not write visits (task 4) and
does not render anything (task 13).

## Acceptance criteria

- [ ] One endpoint returns per-node `reached`, `sent`, `error` and `parkedHere` for a campaign and graph version
- [ ] Graph version defaults to the campaign's live version and can be requested explicitly
- [ ] Only enrollments pinned to the requested version contribute per-node counts
- [ ] Enrollments on other versions are reported as a single separate total
- [ ] `sent` and `error` count distinct leads, not raw history entries
- [ ] `parkedHere` counts active, paused and failed enrollments at that node
- [ ] Decision nodes that write no history still report a non-zero `reached`
- [ ] The existing graph node-index and describe helpers are reused, not duplicated
- [ ] A campaign with no enrollments returns zeroed nodes rather than an error or an empty body
- [ ] `backend/node/tools/verify-node-funnel.js` seeds enrollments with mixed outcomes and version pins and asserts every point above

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
