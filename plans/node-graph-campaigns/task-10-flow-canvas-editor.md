---
task: 10
name: flow-canvas-editor
parallel_group: 3
depends_on: [8]
issue: 11
---

# Task 10: Visual flow canvas editor for campaign graphs

## What to build

This is a WhatsApp drip-campaign admin tool. The frontend is React 19 + Vite at `frontend/admin-ui`, served by the Express backend at `/admin/leads/`. Its only runtime dependencies today are `react` and `react-dom` — everything else in the admin UI is plain components and plain CSS. This task delivers the actual payoff of the whole node-graph-campaigns plan: the visual canvas where an admin drags node kinds onto a surface, wires them together with edges, configures each node, and saves the result as `campaign.draft` — replacing today's flat, hardcoded `steps[]` editor with a real graph builder. Task 8 (not part of this task) provides the backend API surface this canvas reads and writes against, including saving/loading `campaign.draft`, publishing a version, and the `/api/campaigns/meta/fields` and `/api/campaigns/meta/templates` metadata endpoints referenced below.

### Add the canvas dependency

Add `@xyflow/react` to `frontend/admin-ui`'s dependencies. This is the project's first real frontend dependency beyond `react`/`react-dom`, and the app runs React 19.2, so before wiring it in, verify at install time that the installed `@xyflow/react` version declares React 19 support (check its `peerDependencies` and installed React version compatibility, and confirm `npm install`/`npm run build` complete without peer-dependency errors or warnings that indicate a React 18-only release). Do not silently force-install over a peer conflict — if the latest published version doesn't support React 19, this is a blocker worth surfacing, not papering over with `--legacy-peer-deps`.

### New files

- `frontend/admin-ui/src/FlowCanvas.jsx` — the canvas itself: a palette of the node kinds, an `@xyflow/react` canvas that accepts drag-and-drop node creation, edge drawing between node handles, node move/select/delete, and a save action that serializes the canvas's nodes/edges back into the `{ nodes, edges }` shape `campaign.draft` expects (per the graph schema from task 3: each node is `{ id, kind, label, position, config }`, each edge is `{ id, from, to, branch }`).
- `frontend/admin-ui/src/NodeConfigPanel.jsx` — the side panel that renders the right configuration form for whichever node is currently selected on the canvas, dispatching on the selected node's `kind`.

### Canvas behaviour

- A palette lists the node kinds this task is responsible for configuring (source, filter, message, wait, condition, exit — see scope note below) and lets the admin drag one onto the canvas to create a new node there.
- Edges are drawn by dragging between node handles. Nodes can be moved (position persisted back into the node's `position`) and deleted (also removing any edges attached to them).
- **Output handles per kind**: `condition` and `goal` nodes render two labelled output handles, `yes` and `no`; `split` nodes render two labelled output handles, `a` and `b`; every other kind renders a single, unlabelled output handle. When an edge leaves a two-handle node, the edge's `branch` field is set to match the handle it was drawn from (`"yes"`/`"no"` or `"a"`/`"b"`); edges from single-handle nodes carry no `branch`.
- Saving the canvas writes the current nodes/edges to `campaign.draft` via the API task 8 exposes. The canvas also surfaces draft/publish state: a **Publish** button (snapshots the current draft as a new version through task 8's publish endpoint), a **version badge** showing the campaign's current live version, and a clear visual indicator whenever the draft differs from the last-published version (i.e. there are unpublished changes) that clears once a publish succeeds.

### Per-kind config panels — reuse, don't rebuild

`NodeConfigPanel` must reuse the existing filter-building components rather than reimplementing filter UI:

- Import `FilterCondition` and `buildMongoFilter` from `frontend/admin-ui/src/FilterBuilder.jsx` and use them unchanged to power the **source** node's `filter`, the **filter** node's `filter`, and the **condition** node's field-based comparisons. Do not fork or copy this logic into the new files.
- Import `describeFilter` from the same file to render a human-readable subtitle under a node on the canvas (e.g. a source or filter node shows `describeFilter(node.config.filter)` beneath its label), the same way `CampaignDetail` already uses it to describe a stored auto-enroll segment.

Per-kind panels to build in this task (source, filter, message, wait, condition, exit are in scope; split, goal, and action are explicitly **out of scope** — see boundary section):

- **Source node panel**: lets the admin pick which connected Data Source (or built-in source) feeds this node, then edit the canonical map (`config.map`) — one dropdown per canonical key (`phone`, `name`, `email`, …), each populated with the fields discovered for the selected source via `/api/campaigns/meta/fields`. `config.map.phone` is required per the graph schema (task 3); this panel must enforce that requirement in the UI — block saving/leaving the node unconfigured while `phone` has no mapped field, and surface that requirement visibly (e.g. a required marker and inline validation message), not just silently reject on the backend.
- **Filter node panel**: a `FilterCondition`/`buildMongoFilter`-driven filter editor identical in spirit to the one `CampaignDetail` already uses for segment-building, writing into `config.filter`.
- **Message node panel**: a template picker fed by the existing `/api/campaigns/meta/templates` endpoint, plus a params editor that lets the admin map each of the picked template's variable indices to a canonical key (`config.params: [{ index, from }]`), so template variables are filled from whatever canonical map the upstream source node established.
- **Wait node panel**: amount and unit (minutes/hours/days) for `config.amount`/`config.unit`, a send-window editor (from/to plus timezone) for `config.window`, and weekday skip-day checkboxes for `config.skipDays`.
- **Condition node panel**: reuses `FilterCondition`/`buildMongoFilter` for the `"field"`-based condition case, writing into the node's `config`.
- **Exit node panel**: a simple outcome label editor for `config.outcome`.

### Wire into CampaignsTab

Replace the existing steps editor in `frontend/admin-ui/src/CampaignsTab.jsx` (currently the `<h4>Steps</h4>` block and its surrounding step-card markup, lines 149–186 of `CreateCampaignForm`) with the new `FlowCanvas`/`NodeConfigPanel` pair, so building and editing a campaign's flow happens on the canvas instead of through the flat step-card list.

### Styling

Add plain CSS for the canvas, palette, node cards, handles, and config panel to `frontend/admin-ui/src/index.css`, using the project's existing CSS custom properties (`--bg-surface`, `--bg-canvas`, `--accent`, `--info`, and the rest of the existing dark theme palette already defined at the top of that file). Do not introduce Tailwind, CSS-in-JS, or any component library — match the plain-CSS, custom-property-driven style already used throughout `index.css`.

## Boundary — important for parallel safety

This task **owns the steps-editor region** of `CampaignsTab.jsx` (the block being replaced, described above) and nothing else in that file. It must **not** touch:

- `STATIC_SOURCES` or `STATIC_SOURCE_COLUMNS` (lines 25–42) — those belong to task 11.
- The step-count displays at line 323 (`enrollmentColumns`'s `currentStepIndex` column) and line 588 (the campaign list's `Steps` column showing `c.steps.length`) — also task 11's, since task 11 is deliberately sequenced into a later phase specifically so it and this task never edit `CampaignsTab.jsx` concurrently.

The config panels for the **split**, **goal**, and **action** node kinds are out of scope for this task — that work belongs to task 14. It is acceptable (and expected) for those three kinds to appear in the palette only in a minimal/placeholder form, or to be omitted from the palette entirely, as long as doing so doesn't block building and saving graphs using the six in-scope kinds.

## Acceptance criteria

- [ ] `@xyflow/react` is added to `frontend/admin-ui`'s dependencies, `npm install` succeeds, and its React 19 compatibility has been verified (peer dependency on React 19 satisfied, no forced/legacy peer-dep overrides needed).
- [ ] `frontend/admin-ui/src/FlowCanvas.jsx` and `frontend/admin-ui/src/NodeConfigPanel.jsx` exist and are wired into `CampaignsTab.jsx` in place of the old steps editor at lines 149–186.
- [ ] An admin can drag node kinds onto the canvas, connect them with edges, move nodes, and delete nodes.
- [ ] An admin can visually build a `source -> message -> wait -> condition -> exit` flow, save it as the campaign's draft, publish it, reload the page, and see the identical graph restored.
- [ ] Edges drawn from a `condition` node's two output handles carry `branch: "yes"` / `branch: "no"` correctly; edges from `split`'s two handles (if present in the palette) carry `"a"`/`"b"`; edges from single-handle node kinds carry no `branch`.
- [ ] The source node panel refuses to let the admin save/leave the node without a `phone` mapping set, with a visible inline validation message.
- [ ] The message node panel lists templates from `/api/campaigns/meta/templates` and lets the admin bind each template parameter index to a canonical key.
- [ ] The wait node panel edits amount/unit, send-window from/to/timezone, and skip-days.
- [ ] The filter and condition node panels reuse `FilterCondition`/`buildMongoFilter` from `FilterBuilder.jsx` rather than reimplementing filter UI, and node subtitles on the canvas use `describeFilter` from the same file.
- [ ] The Publish control publishes the draft, the version badge updates to the new version, and the unpublished-changes indicator clears immediately after a successful publish (and reappears once the draft is edited again).
- [ ] The existing filter/preview/send flow in `CampaignDetail` (segment building, preview, send, auto-enroll) still works unchanged.
- [ ] `CampaignsTab.jsx`'s `STATIC_SOURCES`, `STATIC_SOURCE_COLUMNS` (lines 25–42), and the step-count displays at lines 323 and 588 are untouched by this task's diff.
- [ ] The split, goal, and action config panels are not implemented in this task (left to task 14).
- [ ] All new canvas/panel styling lives in `frontend/admin-ui/src/index.css` as plain CSS using existing custom properties, with no Tailwind, CSS-in-JS, or new UI/component library introduced.

## Commit convention

Your commit message MUST include `Closes #11` so the task's GitHub issue closes when the commit lands on the default branch.
