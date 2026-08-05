---
task: 1
name: graph-validation-module
parallel_group: 1
depends_on: []
issue: 18
---

# Task 1: Graph validation module mirroring backend invariants

## What to build

A pure, dependency-free module in the admin UI that inspects a campaign flow graph
(`{ nodes, edges }` in the shape `campaign.draft` uses) and returns the problems it finds, split
into two tiers: **errors** that must block publishing, and **warnings** that inform without
blocking.

The rules are ports of what the backend already enforces or already does at runtime. Do not invent
rules. Read the backend first and mirror it:

- `backend/node/models/Campaign.js` — `graphIntegrityErrors()` (duplicate node ids, edges pointing
  at nodes that do not exist). These run as Mongoose validators on **save**.
- `backend/node/lib/campaignTargets.js` — `sourceEntryPoints()` (source node present, `sourceId`
  configured, source has an outgoing edge, filter is a valid object). These throw at enrollment.
- `backend/node/lib/campaignEngine.js` — the per-kind config gaps that cause the walker to *park* a
  lead rather than throw. Each parked-lead cause is a warning.

**Errors** (block publish): no source node in the graph; a source node with no `sourceId`; a source
node with no `map.phone`; a source node with no outgoing edge; an edge whose `from` or `to` names a
node that is not in the graph; two nodes sharing an id.

**Warnings** (do not block): a `message` node with no `templateId`; a `wait` node with no `amount`
or no `unit`; a `split` node whose `ratio` is missing or outside 0–100; a `condition` node missing
its field, operator, or value; a `goal` node with neither `threshold` nor `count`; an `action` node
with neither a URL nor a source field; an `action` node that is not `enabled`; an orphan node (no
inbound edge and not a source node).

Two rules are special and must be marked as such in the returned data: **duplicate node ids** and
**dangling edges** are rejected by Mongoose validators on save, so they block **saving a draft** as
well as publishing. Every other error blocks publishing only — a half-built flow must stay
saveable. Give each error a flag the caller can read to distinguish "blocks save" from "blocks
publish".

Every returned problem must carry the id of the node it belongs to (where it has one) so a caller
can select that node on a canvas, plus a human-readable message that names the node by its label
where it has one and falls back to its id where it does not. Messages are read by an operator, not
a developer: "Source \"CA Guru\" has no phone mapping", not "config.map.phone undefined".

This task delivers the module and nothing else. It is not wired into any component — that is
task 4's job.

## Acceptance criteria

- [ ] A new module exports a function taking a `{ nodes, edges }` graph and returning errors and
      warnings as separate collections.
- [ ] Every error and warning listed above is implemented, and no rule exists that is not derived
      from observed backend behaviour.
- [ ] Duplicate node ids and dangling edges are distinguishable by the caller as also blocking a
      draft save; all other errors block publish only.
- [ ] Each problem carries its node id (where applicable) and an operator-readable message that
      prefers the node's label over its id.
- [ ] The module is pure — no React, no network calls, no imports from component files.
- [ ] A graph with no problems returns empty collections for both tiers.
- [ ] `npm run build` and `npm run lint` succeed in `frontend/admin-ui`.

## Commit convention

Your commit message MUST include `Closes #18` so the task's GitHub issue closes when
the commit lands on the default branch.
