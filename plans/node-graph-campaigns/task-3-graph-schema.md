---
task: 3
name: graph-schema
parallel_group: 1
depends_on: []
issue: 4
---

# Task 3: Versioned graph schema for Campaign and CampaignEnrollment

## What to build

This is a WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node` using Mongoose, React 19 + Vite frontend at `frontend/admin-ui`, WATI as the WhatsApp provider). Today `backend/node/models/Campaign.js` models a campaign as a single `targetModel` string plus a flat `steps: [{ templateId, providerMeta }]` array — an ordered list of template sends with no way to express a delay between sends, a branch on lead behavior, more than one source feeding a campaign, or a per-recipient template variable. This task replaces that flat shape with a versioned graph of typed nodes and edges. It is the data contract every other task in this plan (the walker, the migration script, the API routes, the canvas editor) builds on, so every shape below must land exactly as specified — other tasks will read this file rather than re-deriving the schema.

**Boundary — this task is schema and validation only.** Do not write the graph walker (task 5), the `steps[]` → graph migration script (task 6), any campaign API routes (task 8), or any frontend code. Do not implement node *behavior* (what a `wait` node actually does when the walker reaches it) — only its `config` shape needs to exist and be documented.

### 1. `backend/node/models/Campaign.js`

Remove `targetModel` and `steps` entirely. Add:

```
draft:       { nodes: [nodeSchema], edges: [edgeSchema] }
versions:    [ { version: Number, nodes: [nodeSchema], edges: [edgeSchema], publishedAt: Date } ]
liveVersion: Number
```

`draft` is the in-progress graph an admin is editing on the canvas. Publishing (handled by a later task) snapshots `draft.nodes`/`draft.edges` into a new entry appended to `versions`, and updates `liveVersion` to that entry's `version`. Each `CampaignEnrollment` pins to the `liveVersion` in effect at the moment it was created (see below), so editing `draft` — or even publishing a new version — can never strand or silently re-route a lead already mid-drip. `versions` is append-only; nothing in this task edits or removes an existing entry.

Keep `name`, `description`, `channelId`, `active`, `autoEnroll`, `autoEnrollFilter`, `lastAutoEnrollAt`, `lastAutoEnrollCount`, and `lastAutoEnrollError` exactly as they are today — do not touch their types, validation, or defaults.

### 2. Node schema

Each node in `nodes` (used identically inside `draft` and inside every entry of `versions`):

```
{
  id:       String,   // unique within this graph (draft, or a single versions[] entry)
  kind:     String,   // enum, one of the nine kinds below
  label:    String,   // admin-facing display name, free text
  position: { x: Number, y: Number },  // canvas coordinates
  config:   Mixed,     // shape depends on kind — see below
}
```

### 3. Edge schema

Each edge in `edges`:

```
{
  id:     String,
  from:   String,   // node id this edge originates from
  to:     String,   // node id this edge points to
  branch: String,   // optional — see below
}
```

`branch` disambiguates which outgoing edge to follow when a node has more than one:
- `"yes"` / `"no"` — for edges leaving a `condition` node or a `goal` node.
- `"a"` / `"b"` — for edges leaving a `split` node.
- Absent (`undefined`) — for every other node kind, which has at most one outgoing edge.

### 4. The nine node kinds and their `config` shapes

Document each of these as a schema comment above the relevant part of the model, not just in this task file — the comment is what the walker and API tasks will read instead of re-deriving the shape.

- **`source`** — `{ sourceId, filter, map: { phone, name, email, ... } }`. `sourceId` identifies the connected Data Source (or built-in `Contact`/`Lead`/`AdMagnetStudent`). `filter` reuses the existing Mongo-ish filter shape already used by `autoEnrollFilter`/`matchTargets`. `map` is the canonical field map — the mechanism that lets every downstream node address a lead's fields by stable canonical key (`phone`, `name`, `email`, …) instead of the source's raw field names. `map.phone` is required; every other key is optional and source-specific.
- **`filter`** — `{ filter }`. Same Mongo-ish filter shape as the source node's `filter`, applied mid-graph to narrow which leads continue past this point.
- **`message`** — `{ templateId, providerMeta, params: [{ index, from }] }`. `templateId` and `providerMeta` carry over unchanged in meaning from the old `stepSchema`. `params` maps WhatsApp template variable slots to canonical fields: each entry's `index` is the template's variable position and `from` names a canonical key (as produced by the enclosing source node's `map`) whose value fills that slot at send time.
- **`wait`** — `{ amount, unit, window: { from, to, tz }, skipDays: [Number] }`. `unit` is one of `"minutes"`, `"hours"`, `"days"`. `window` optionally restricts delivery to a time-of-day range in a given timezone; `skipDays` optionally lists weekday numbers (e.g. 0=Sunday) to skip entirely.
- **`condition`** — `{ on, ...per-kind args }`. `on` is one of `"field"`, `"engagement"`, `"activity"`, `"elapsed"`; the remaining keys are specific to which `on` value is chosen (e.g. a `"field"` condition needs a field name/operator/value; an `"elapsed"` condition needs a duration). Model `config` as `Mixed` — do not attempt to enumerate every per-kind arg shape as separate sub-schemas in this task.
- **`split`** — `{ ratio }`. Splits traffic between its `"a"` and `"b"` branches according to `ratio`. The branch actually taken for a given lead must be chosen by a stable hash of the enrollment's `targetId` (not randomly), so that the same lead deterministically re-derives the same branch if ever re-evaluated — document this requirement in the schema comment even though the hashing itself is implemented by the walker (task 5), not here.
- **`goal`** — an activity-threshold config (`Mixed`), evaluated by the walker to decide the `"yes"`/`"no"` branch.
- **`action`** — `{ url, method, body }` for an outbound HTTP call, or a source-field write-back shape. This is the only node kind that writes (calls an external endpoint or mutates source data) as opposed to reading/branching/sending. Document in the schema comment that any implementation of this node (a later task) must be gated by the existing send kill switch and must default to disabled — this task only needs to model the config shape, not enforce the gating, but the comment must state the requirement so it isn't lost.
- **`exit`** — `{ outcome }`. Terminates the walk for a lead with a labeled outcome.

Use a single discriminated node schema (`kind` enum + `config: Mixed`) rather than per-kind Mongoose subdocuments, so a graph's `nodes` array can freely mix kinds — validation of `kind` itself still needs to be a real Mongoose enum (see validation section below), just not a polymorphic subdocument schema.

### 5. `backend/node/models/CampaignEnrollment.js`

Rename `currentStepIndex` (`Number`) to `currentNodeId` (`String`) — it now holds the id of the node the enrollment is at (about to process, or last processed), not an array index.

Rename `history[].stepIndex` (`Number`) to `history[].nodeId` (`String`) for the same reason.

Add `graphVersion` (`Number`, required) to the top-level enrollment schema. This pins the enrollment to the specific `versions[].version` of its campaign that was live at the moment the enrollment was created, so that a later publish of a new version never changes which graph an in-flight enrollment is walking.

Keep everything else in this model exactly as it is today: the `status` enum (`active`/`completed`/`paused`/`cancelled`/`failed`), `nextSendAt`, `phone`, `targetModel`, `targetId`, and every existing index — most importantly:
- the unique compound index on `(campaign, targetModel, targetId)`, which is what makes the 5-minute auto-enroll rescan idempotent (re-running `matchTargets`/`enrollTargets` against the same source can't double-enroll a target);
- the `history.providerMessageId` and `history.providerLocalMessageId` indexes, which the WATI webhook's inbound-event-to-send matching relies on (see `routes/wati.js`).

Do not rename, retype, or drop any of the above while making the `currentStepIndex`/`stepIndex` renames — this is purely a field rename plus one field addition, not a broader schema rewrite.

### 6. Schema-level validation

Add validation (Mongoose custom validators on `Campaign`, applied identically to `draft` and to each entry of `versions`) that:
- rejects an unknown `kind` value in `nodes` (i.e. `kind` is a real Mongoose `enum` over the nine kinds listed above, not a free-form string);
- rejects a graph containing two or more nodes with the same `id`;
- rejects an edge whose `from` or `to` does not match the `id` of any node present in the same graph.

These three checks must run for `draft` and for every `versions[]` entry — a version, once published, is never supposed to contain a dangling edge or a duplicate id either, since a later task's migration script will be writing directly into `versions[0]`.

## Acceptance criteria

- [ ] `Campaign.js` no longer has `targetModel` or `steps`; it has `draft: { nodes, edges }`, `versions: [{ version, nodes, edges, publishedAt }]`, and `liveVersion`.
- [ ] `name`, `description`, `channelId`, `active`, `autoEnroll`, `autoEnrollFilter`, `lastAutoEnrollAt`, `lastAutoEnrollCount`, `lastAutoEnrollError` are unchanged from their current definitions.
- [ ] The node schema has `id`, `kind`, `label`, `position: { x, y }`, `config`, and `kind` is a real Mongoose enum over exactly the nine kinds: `source`, `filter`, `message`, `wait`, `condition`, `split`, `goal`, `action`, `exit`.
- [ ] The edge schema has `id`, `from`, `to`, and optional `branch`.
- [ ] Every one of the nine node kinds' `config` shapes is documented in a schema comment in `Campaign.js`, matching this task's descriptions, including the `split` stable-hash-of-`targetId` requirement and the `action` kill-switch/default-disabled requirement.
- [ ] `CampaignEnrollment.js` has `currentNodeId: String` (not `currentStepIndex`) and `history[].nodeId: String` (not `history[].stepIndex`).
- [ ] `CampaignEnrollment.js` has a required `graphVersion: Number` field.
- [ ] `CampaignEnrollment.js`'s `status` enum, `nextSendAt`, `phone`, `targetModel`, `targetId`, and every existing index (including the ones checked below) are otherwise untouched.
- [ ] The unique compound index on `(campaign, targetModel, targetId)` still exists on `CampaignEnrollment`.
- [ ] The `history.providerMessageId` and `history.providerLocalMessageId` indexes still exist on `CampaignEnrollment`.
- [ ] Both models load (e.g. via `require(...)` / app boot) with no Mongoose schema-compile warnings or errors.
- [ ] Saving a `Campaign` whose `draft.nodes` contains two nodes with the same `id` is rejected by validation.
- [ ] Saving a `Campaign` whose `draft.edges` contains an edge with a `from` or `to` that does not match any node `id` in `draft.nodes` is rejected by validation.
- [ ] Saving a `Campaign` whose `draft.nodes` contains a node with a `kind` outside the nine-value enum is rejected by validation.
- [ ] The same three validations (duplicate id, dangling edge, unknown kind) apply to entries pushed into `versions`, not only to `draft`.
- [ ] Saving a `CampaignEnrollment` without `graphVersion` is rejected by validation.

## Commit convention

Your commit message MUST include `Closes #4` so the task's GitHub issue closes when the commit lands on the default branch.
