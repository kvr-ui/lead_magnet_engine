---
task: 8
name: campaign-graph-api
parallel_group: 2
depends_on: [2, 3]
issue: 9
---

# Task 8: Campaign HTTP API for the versioned graph (draft, publish, versions, graph-aware preview/enroll)

## What to build

This is a WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node` using Mongoose). Campaign routes live in `backend/node/routes/campaigns.js`. Task 3 replaced `Campaign.targetModel` + `steps[]` with a versioned graph: `draft: { nodes, edges }`, `versions: [{ version, nodes, edges, publishedAt }]`, and `liveVersion`. Task 2 collapsed the two duplicate source-resolution implementations into `backend/node/lib/sourceResolver.js`, exporting `resolveSource(sourceId, map)` which returns `{ find(filter), findById(id), mapDoc(doc), kind, collection|model }`. This task is the HTTP surface that lets the rest of the system (and later, the canvas editor in task 10) create, edit, publish, and run campaigns against that graph shape.

Today's routes assume the old flat shape everywhere: `POST /api/campaigns` accepts `targetModel` + `steps` in the body; `PATCH /api/campaigns/:id` writes straight onto the campaign document; `preview`/`enroll` call `previewTargets`/`enrollTargets` in `lib/campaignEngine.js`, which resolve a single `campaign.targetModel` via the old `getAdapter`/`adapters` dispatch and validate a single filter via `validateFilter(campaign.targetModel, filter)` in `lib/sourceData.js`; the campaign list endpoint (`GET /api/campaigns`) returns raw campaign documents whose UI relies on `steps.length` to show a step count. All of that has to change to work in terms of nodes, edges, drafts, versions, and — since a graph can now have more than one `source` node — a union of sources per campaign instead of exactly one.

### 1. `POST /api/campaigns` — create

Accepts `{ name, description?, channelId?, draft? }`. No `targetModel`, no `steps` — those fields no longer exist on the model (task 3 removed them). When `draft` is omitted, create the campaign with an empty graph (`draft: { nodes: [], edges: [] }`); when supplied, it goes through the same Mongoose validation task 3 added (unknown `kind`, duplicate node `id`, dangling edge). `liveVersion` starts unset/null and `versions` starts empty — nothing is live until the first publish.

### 2. `GET /api/campaigns/:id` and `PATCH /api/campaigns/:id` — draft-only edits

`GET` returns the campaign document as today (now including `draft`, `versions`, `liveVersion` instead of `targetModel`/`steps`).

`PATCH` continues to handle the non-graph fields exactly as today (`active`, `autoEnroll`, `autoEnrollFilter`, `channelId`, `name`, `description`, ...), including the existing auto-enroll arming guard (see section 5). When the request body includes graph edits (`nodes`/`edges`, or a nested `draft` object — pick one shape and use it consistently), those writes land **only** on `draft.nodes` / `draft.edges`. A `PATCH` must never write into `versions[]` or change `liveVersion` — those are owned exclusively by the publish endpoint. This is the mechanism that keeps an in-flight enrollment safe: it's walking a `versions[]` entry pinned by `graphVersion`, and nothing about editing `draft` may reach back and mutate that entry.

### 3. `POST /api/campaigns/:id/publish` — snapshot draft into a new version

Reads the campaign's current `draft`, computes the next version number (`(highest existing versions[].version || 0) + 1`), appends `{ version, nodes: draft.nodes, edges: draft.edges, publishedAt: new Date() }` to `versions`, and sets `liveVersion` to that new version number. Returns the newly created version. Published versions are immutable — once appended, nothing in this task's code path ever mutates an existing `versions[]` entry in place; a later publish only appends a new one. `draft` itself is left untouched by publishing (it keeps editing forward from where it was) — publishing copies draft into a version, it does not clear or reset draft.

### 4. `GET /api/campaigns/:id/versions` — list versions

Returns `versions` (or a summary of it) with each entry's `version` number and `publishedAt` timestamp, so the UI can show a version history / rollback picker. Full `nodes`/`edges` per version can be included or omitted at the implementer's discretion — the acceptance criterion only requires `version` and `publishedAt` to be present per entry.

### 5. `POST /api/campaigns/:id/preview` and `POST /api/campaigns/:id/enroll` — graph-aware target resolution

These currently call into `previewTargets(campaign, filter)` / `enrollTargets(campaign, filter)` in `lib/campaignEngine.js`, which resolve one `campaign.targetModel` against one `filter`. That single-source assumption no longer holds: a graph can carry more than one `source` node (e.g. two different lead magnets feeding the same drip), and per the plan's design, this needs no `CampaignEnrollment` schema change — it already carries `targetModel` per row and its unique index is `(campaign, targetModel, targetId)`, so two source nodes of different `targetModel`s (or even the same one) can coexist safely.

Rework target resolution so that, for the graph currently in scope (draft for preview during editing, or whichever graph enroll is meant to run against — see note below), it:

- Walks `nodes` and collects every node with `kind === "source"`.
- For each source node, resolves it via `resolveSource(node.config.sourceId, node.config.map)` from `lib/sourceResolver.js`, applies that source node's own `filter` (its `config.filter`, validated the same way `validateFilter` validates today — reject non-whitelisted fields and unsafe operator shapes, same rules as `isSafeValue`/`getSourceFields` enforce today), and matches targets against it — same phone-cleaning and already-enrolled checks `matchTargets` in `campaignEngine.js` performs today.
- Unions the results across all source nodes into one combined `matched`/`willEnroll`/`skipped*`/`alreadyEnrolled` count set for `preview`, deduplicating by `(targetModel, targetId)` so a lead reachable through two source nodes (e.g. present in two connected data sources) is counted and enrolled once, not twice.
- For `enroll`, writes one `CampaignEnrollment` row per deduped target, with `targetModel` taken from the source node that produced it, `graphVersion` set to the campaign's current `liveVersion` (not the draft — an enrollment always pins to a published version, per task 3's design; enrolling against a campaign with no `liveVersion` yet should fail with a clear error rather than silently enrolling against an unpublished draft), and `currentNodeId` set to the id of the node that the winning source node's outgoing edge points to (i.e. the first node after the source node in the graph the enrollment entered on).

Keep the existing two-step contract: `preview` stays strictly read-only (no writes, including no enrollment rows and no `autoEnrollFilter`/`autoEnroll` mutation) and is called first so the UI can show counts before a confirm; `enroll` is the only endpoint that writes rows and is the only place `autoEnroll`/`autoEnrollFilter` may be armed, exactly as today — a filter (or in the new shape, the set of source-node filters) reaching the auto-enroll scheduler must be one that came from a previewed-and-confirmed `enroll` call, never a filter posted straight at the API through some other path. Preserve the current `PATCH` guard that refuses to flip `autoEnroll: true` unless `autoEnrollFilter` is already non-empty.

Note for the implementer on which graph `preview`/`enroll` run against: `enroll` must run against the published graph (`liveVersion`'s entry in `versions`), since that's what the resulting enrollments will actually walk. `preview` should mirror whatever `enroll` would do for the same campaign, so the counts it shows are accurate for the confirm step — resolve it the same way `enroll` does rather than against `draft` (an admin can end up previewing stale numbers if `draft` has since diverged from the last published version, but previewing against a different graph than the one enroll will use would be actively misleading, not just stale).

### 6. `GET /api/campaigns/meta/fields` and `GET /api/campaigns/meta/values` — scoped per source node

These currently take a bare `source` query param and call `getSourceFields`/`distinctValues` against it directly — that continues to work unchanged for a single source identifier. Keep them working the same way, called per source node (the UI will call once per source node it's configuring), rather than trying to merge fields/values across multiple sources server-side.

### 7. `GET /api/campaigns` — list endpoint

Currently each returned campaign implicitly exposes `steps.length` (via the raw `steps` array) for the UI to show a step count. Since `steps` no longer exists, add a node count to each campaign in the response (e.g. `nodeCount: (campaign.draft?.nodes || []).length`, or count against the live version if that's a more useful count for the list view — pick one and be consistent) so the UI has an equivalent number to show without needing the full graph. Keep the existing `enrollments`/`delivery` aggregation additions on each list row as they are today.

## Boundaries — do not do in this task

- No canvas UI or any frontend work — that's task 10.
- No graph walker changes — `advanceEnrollment`'s node-by-node traversal, wait handling, hop limits, etc. are task 5. This task only needs `currentNodeId` set correctly at enroll time; it does not implement how the walker consumes it afterward.
- Do not implement `split`/`goal`/`action` node runtime semantics — that's task 12. This task's source-node union logic only needs to look at `kind === "source"` nodes; it does not need to interpret any other node kind's `config`.
- Do not touch `CampaignEnrollment`'s schema — task 3 already added `graphVersion` and renamed `currentStepIndex`→`currentNodeId`; this task only writes those fields correctly, it doesn't redefine them.

## Acceptance criteria

- [ ] `POST /api/campaigns` creates a campaign with no `targetModel`/`steps` in the accepted body; an omitted `draft` produces `{ nodes: [], edges: [] }`, `versions: []`, and no `liveVersion`.
- [ ] `GET /api/campaigns/:id` returns `draft`, `versions`, `liveVersion`.
- [ ] `PATCH /api/campaigns/:id` with graph edits writes only to `draft.nodes`/`draft.edges` and never touches any existing `versions[]` entry or `liveVersion`.
- [ ] `PATCH /api/campaigns/:id` still supports the existing non-graph fields (`active`, `autoEnroll`, `autoEnrollFilter`, `channelId`, `name`, `description`) with identical behavior to today, including the existing guard that refuses `autoEnroll: true` unless `autoEnrollFilter` is already armed and non-empty.
- [ ] `POST /api/campaigns/:id/publish` appends a new `versions[]` entry with the next sequential `version` number, `publishedAt` set, and a snapshot of `draft.nodes`/`draft.edges`; sets `liveVersion` to that new version; returns the new version.
- [ ] Publishing never mutates an already-existing `versions[]` entry — a campaign with an active enrollment pinned to an earlier `graphVersion` is unaffected by a later publish (its `versions[<graphVersion>]` entry is byte-for-byte the same before and after the publish).
- [ ] Publishing does not clear or reset `draft`.
- [ ] `GET /api/campaigns/:id/versions` returns every `versions[]` entry's `version` and `publishedAt`.
- [ ] `POST /api/campaigns/:id/preview` and `POST /api/campaigns/:id/enroll` union targets across every `kind: "source"` node in the graph, resolving each through `resolveSource(sourceId, map)` from `lib/sourceResolver.js` and each source node's own `config.filter`.
- [ ] A target reachable through more than one source node is counted/enrolled exactly once, deduplicated by `(targetModel, targetId)`.
- [ ] `enroll` writes each `CampaignEnrollment` with `targetModel` matching the source node that produced it, `graphVersion` equal to the campaign's `liveVersion` at enroll time, and `currentNodeId` set to the node id that source node's outgoing edge points to.
- [ ] `enroll` against a campaign with no `liveVersion` (never published) fails with a clear error rather than creating enrollments against the draft.
- [ ] `preview` performs no writes — no enrollment rows, no change to `autoEnroll`/`autoEnrollFilter` — and resolves targets against the same graph `enroll` would use, not against `draft`.
- [ ] Each source node's `filter` is still validated by the existing whitelist-fields-and-safe-operator-shapes rule (equivalent to today's `validateFilter`/`isSafeValue`) — a filter referencing a non-filterable field or an unsafe operator shape is rejected with a 400, per source node.
- [ ] The existing auto-enroll arming rule is preserved: `autoEnrollFilter` is only ever written from `enroll` after a previewed-and-confirmed segment, never accepted directly from a `PATCH` body when arming `autoEnroll: true` for the first time.
- [ ] `GET /api/campaigns/meta/fields` and `GET /api/campaigns/meta/values` continue to work per individual `source` query param, usable once per source node the UI is configuring.
- [ ] `GET /api/campaigns` no longer relies on `steps.length`; each returned campaign includes a node count derived from its graph, and the existing `enrollments`/`delivery` per-campaign aggregations are unchanged.

## Commit convention

Your commit message MUST include `Closes #9` so the task's GitHub issue closes when the commit lands on the default branch.
