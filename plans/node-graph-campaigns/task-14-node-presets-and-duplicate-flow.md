---
task: 14
name: node-presets-and-duplicate-flow
parallel_group: 5
depends_on: [10, 12]
issue: 15
---

# Task 14: Node presets, duplicate-flow, and the split/goal/action config panels

## What to build

This is a WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node` using Mongoose, React 19 + Vite frontend at `frontend/admin-ui`, plain CSS custom properties — no Tailwind, no CSS-in-JS). Task 10 built the `@xyflow/react` canvas and its editor chrome; task 12 implemented the `split`, `goal`, and `action` walker handlers inside the graph walker from task 5. This task delivers the "nodes we can reuse" half of the original request, plus the config panels task 10 deliberately left out, plus a way to clone a proven flow for a new lead magnet.

**Boundary — this task does not change walker semantics** (owned by tasks 5 and 12) or the graph schema itself (owned by task 3). It builds UI and reuse machinery on top of both, and it must emit `config` shapes that the existing task-5/task-12 handlers already consume without any translation layer.

### 1. Node presets

A preset is a saved, reusable node configuration an admin can drop onto any canvas instead of re-authoring the same `message`/`wait`/`condition`/etc. node from scratch every time.

**Backend — new model `backend/node/models/NodePreset.js`:**

```
{
  name:   String,   // admin-facing label for the preset library
  kind:   String,   // same node-kind enum as Campaign.draft.nodes[].kind (task 3)
  config: Mixed,    // a snapshot of a node's config — same shape the corresponding kind uses in the graph schema
}
```

Include Mongoose timestamps (`createdAt`/`updatedAt`).

**Backend — CRUD routes.** Follow the existing route-file conventions in `backend/node/routes/` (naming, mounting, response shapes consistent with the other route files in this codebase):

- `GET /api/node-presets` — list presets. Support filtering by `kind` (e.g. `?kind=message`) since the frontend preset library groups by kind.
- `POST /api/node-presets` — create a preset from `{ name, kind, config }`.
- `PUT /api/node-presets/:id` (or `PATCH`, matching whatever verb this codebase's other CRUD routes use for updates) — edit an existing preset's `name`/`config`.
- `DELETE /api/node-presets/:id` — remove a preset.

**Frontend — save-as-preset action.** On the canvas built in task 10, add a "Save as preset" action to the selected-node inspector/toolbar. It prompts for a preset `name`, then `POST`s the currently-selected node's `kind` and `config` (only `kind`/`config` — never the node's canvas `id` or `position`, which are per-instance) to `/api/node-presets`.

**Frontend — preset library panel.** A panel on the canvas screen (collapsible side panel or similar, consistent with task 10's existing canvas chrome) that lists saved presets grouped/filterable by node `kind`, and supports dragging a preset onto the canvas to insert it. On drop, the frontend must construct a brand-new node object with a freshly generated node `id`, the drop `position`, `kind` copied from the preset, and `config` **deep-copied** from the preset's `config` — never a reference to the preset document and never the preset's own `_id`.

**THE CORE INVARIANT — copy semantics, not live links.** Inserting a preset copies its `config` at insertion time. Editing a preset afterwards (via the CRUD routes above) must never mutate any node that was already inserted into any campaign's graph — not a node sitting in `draft.nodes`, and not a node baked into an already-published entry of `versions[]`. This was a deliberate design decision over live-linked shared nodes, made explicit in this plan's Decisions record: a typo fix on a shared node would otherwise silently rewrite the flow underneath roughly 951 in-flight leads mid-drip. Concretely: nothing in the preset CRUD routes or the insert-from-library flow may store a preset id or any other live reference on a campaign's node — a campaign node that originated from a preset must be indistinguishable, in storage, from one an admin typed by hand.

### 2. Duplicate flow

A "Duplicate flow" action (e.g. on the campaign list or campaign detail screen — match whatever surface task 10/8 already exposes campaign-level actions from) that clones a campaign's **draft** graph into a brand-new `Campaign` document, so a new lead magnet can start from a proven nurture sequence and only swap its source node.

Backend behavior (new route, e.g. `POST /api/campaigns/:id/duplicate`, following the campaign-graph-api conventions from task 8):

- Deep-copy `draft.nodes` and `draft.edges` from the source campaign into the new campaign's `draft`. Node ids may be regenerated or preserved as long as internal edge references (`from`/`to`) stay internally consistent within the new graph.
- The new campaign must NOT copy:
  - `versions[]` — the clone starts with an empty `versions` array and no `liveVersion`; it is unpublished.
  - Any `CampaignEnrollment` documents — the clone starts with zero enrollments, regardless of how many leads are enrolled in the source campaign.
  - `autoEnroll` arming — the clone's `autoEnroll` must be `false` (off) even if the source campaign has it `true`, so the clone cannot silently start auto-enrolling leads the moment it's created.
- Fields like `name` should be adjusted to make the clone identifiable as a copy (e.g. append "(copy)" or similar), `channelId`/`active`/`autoEnrollFilter` follow whatever sane default this codebase already uses for a newly-created campaign via the task-8 create-campaign route — do not invent a divergent default path.
- Frontend: a button that triggers the duplicate call and navigates the admin into the new campaign's canvas so its source node can be swapped immediately.

### 3. The remaining canvas config panels: split, goal, action

Task 10 built the canvas shell and presumably shipped config panels for `source`, `filter`, `message`, `wait`, `condition`, and `exit`, but explicitly left out `split`, `goal`, and `action` since their walker handlers didn't exist yet (they landed in task 12). Add the three missing panels now, wired into whatever node-inspector pattern task 10 established for the other node kinds. Each panel must emit exactly the `config` shape its task-12 handler consumes — read `backend/node/lib` (wherever task 5/12 implemented the walker and its `split`/`goal`/`action` dispatch) to confirm the exact keys before building the form, rather than re-deriving the shape from the task 3 schema doc alone, since task 12 is the ground truth for what the handler actually reads at runtime.

- **Split panel.** Per the task 3 schema, `split` config is `{ ratio }`. Build a form that lets the admin set the a/b traffic ratio (e.g. two linked numeric or slider inputs that sum to a whole, or a single 0–100 slider for branch "a" with "b" implied) and emits `{ ratio }` in the shape task 12's split handler reads. Label the two outgoing edges/handles on the node itself "a" and "b" to match the `branch` values the schema defines for split edges.
- **Goal panel.** `goal` config is an activity-threshold shape (`Mixed` in the schema — task 12 is the concrete source of truth for its keys). Build a form exposing whatever activity/threshold fields task 12's goal handler reads (e.g. an activity type and a count/duration threshold), and label the node's two outgoing edges "yes"/"no" to match the schema's `branch` values for goal edges.
- **Action panel.** `action` config is `{ url, method, body }` for an outbound HTTP call, or a source-field write-back shape — confirm both shapes and their discriminator (however task 12 distinguishes "HTTP call" mode from "write to source field" mode) and build a form that toggles between the two modes accordingly. This is the only node kind that writes (calls an external endpoint or mutates source data), so the panel must visibly surface, not bury:
  - That the node is **disabled by default** — the form's enabled/disabled toggle must default to off for a newly-created action node, and the disabled state must be visually obvious on the canvas node itself (not just inside the inspector panel), e.g. a distinct badge/border state, so a glance at the graph shows which action nodes are live.
  - That it is **gated by the existing send kill switch** — the panel must include visible copy/indicator stating that even an enabled action node will not fire if the site-wide kill switch is off, so an admin isn't surprised when enabling the node alone doesn't make it execute.

Styling for all new UI (preset library panel, save-as-preset control, duplicate-flow button, and the three new config panels) goes in `frontend/admin-ui/src/index.css`, using the existing CSS custom properties and matching the existing dark theme — no Tailwind, no CSS-in-JS, no new styling approach introduced for this task alone.

## Acceptance criteria

- [ ] `backend/node/models/NodePreset.js` exists with `name`, `kind` (matching the task 3 node-kind enum), `config` (`Mixed`), and timestamps.
- [ ] `GET /api/node-presets` (optionally filtered by `kind`), `POST /api/node-presets`, an update route, and `DELETE /api/node-presets/:id` all work per standard CRUD conventions matching this codebase's existing route files.
- [ ] From the canvas, selecting a node and choosing "Save as preset" creates a `NodePreset` capturing that node's `kind` and `config` (not its per-instance `id`/`position`).
- [ ] The preset library panel lists saved presets grouped or filterable by node `kind`.
- [ ] Dragging a preset from the library onto the canvas inserts a new node with a fresh node id, the drop position, and a **deep copy** of the preset's `config` — not a reference to the preset document.
- [ ] Editing a preset's `config` after it has been inserted into one or more campaigns leaves every already-inserted node's `config` completely unchanged, verified for a node sitting in a campaign's `draft` and for a node baked into an already-published entry of that campaign's `versions[]`.
- [ ] No campaign node stores a preset id or any other live reference back to its originating `NodePreset` — a preset-derived node is indistinguishable in storage from a hand-authored one.
- [ ] A "Duplicate flow" action clones a campaign's `draft.nodes`/`draft.edges` into a new `Campaign` document with internally-consistent edge references.
- [ ] The duplicated campaign has an empty `versions[]`, no `liveVersion`, zero `CampaignEnrollment` documents, and `autoEnroll: false`, regardless of the source campaign's publish state, enrollment count, or `autoEnroll` setting.
- [ ] The duplicated campaign is otherwise created through the same defaulting path as a normal new campaign (per task 8's create route), not a divergent one-off default.
- [ ] The split config panel emits `{ ratio }` and the split node's two outgoing edges are labeled/handled as `"a"`/`"b"`, matching what task 12's split handler and the task 3 edge schema expect.
- [ ] The goal config panel emits whatever activity-threshold keys task 12's goal handler actually reads, and the goal node's two outgoing edges are labeled/handled as `"yes"`/`"no"`.
- [ ] The action config panel supports both the HTTP-call mode (`{ url, method, body }`) and the source-field write-back mode, toggling between them, and emits config in the shape task 12's action handler consumes without any translation.
- [ ] The action panel visibly shows that a newly-created action node is disabled by default, with that disabled state also visible at a glance on the canvas node itself (not only inside the inspector).
- [ ] The action panel visibly states that action execution is additionally gated by the site-wide send kill switch, independent of the node's own enabled toggle.
- [ ] All new styling lives in `frontend/admin-ui/src/index.css`, uses existing CSS custom properties, and matches the existing dark theme — no Tailwind, no CSS-in-JS.
- [ ] No changes are made to the graph walker's semantics (tasks 5/12) or to the `Campaign`/node/edge schema definitions (task 3) — this task only adds presets, duplicate-flow, and canvas panels on top of them.

## Commit convention

Your commit message MUST include `Closes #15` so the task's GitHub issue closes when the commit lands on the default branch.
