---
task: 11
name: frontend-columns-and-node-labels
parallel_group: 4
depends_on: [7, 10]
issue: 12
---

# Task 11: Kill hardcoded source columns and replace step numbers with node labels in the frontend

## What to build

This is a WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node`, React 19 + Vite frontend at `frontend/admin-ui`, plain CSS with custom properties, WATI as the WhatsApp provider). The backend was migrated from a flat `steps[]` array to a graph (nodes + edges) by earlier tasks in this plan. This task is the frontend cleanup that follows: it removes the last hardcoded per-source column definitions from the UI, and replaces every remaining "step number" display with the graph node's label, now that "step index" is no longer a meaningful concept.

This task is placed in parallel group 4, after task 7 (backend read paths — provides `nodeId`/`label`/`templateId` on the enrollment detail and event timeline endpoints) and task 10 (FlowCanvas / NodeConfigPanel graph editor UI). It is scheduled in a later phase specifically so it never edits `CampaignsTab.jsx` concurrently with task 10 — task 10 owns `FlowCanvas.jsx` and `NodeConfigPanel.jsx` exclusively, and this task must not touch those two files.

### (a) Kill the hardcoded source lists

`frontend/admin-ui/src/CampaignsTab.jsx` lines 25-42 define two constants:

- `STATIC_SOURCES` (line 25) — a literal `["Contact", "Lead"]`.
- `STATIC_SOURCE_COLUMNS` (line 28) — hardcoded column definitions keyed by `"Contact"` and `"Lead"`.

These are used at line 238 (`campaign.targetModel.startsWith(DYNAMIC_PREFIX) ? dynamicColumns || [] : STATIC_SOURCE_COLUMNS[campaign.targetModel]`) to pick preview-table columns, and at line 528 (`...STATIC_SOURCES.map((s) => ({ value: s, label: STATIC_SOURCE_LABELS[s] }))`) to populate the source picker.

This is the concrete symptom the whole plan exists to fix: the backend already accepts any connected MongoDB as a source, but a newly connected lead-magnet database appears in the source picker with no columns, because nobody hand-wrote an entry for it in `STATIC_SOURCE_COLUMNS`.

Delete both `STATIC_SOURCES` and `STATIC_SOURCE_COLUMNS` entirely. Replace every call site that reads them:

- The segment-builder and preview-table columns must be built dynamically for *every* source (not just dynamic ones) from `/api/campaigns/meta/fields` combined with the source node's canonical map (the same canonical-map concept `dynamicColumns` already uses for dynamic sources — reuse that mechanism rather than inventing a second one). Order the resulting columns sensibly: canonical keys first (`phone`, `name`, and any other keys the canonical map defines), then the remaining discovered fields from `/api/campaigns/meta/fields` that aren't already covered by the canonical keys.
- The source picker (currently built from `STATIC_SOURCES`) must list whatever sources the backend actually reports as connected/available, not a hardcoded pair.

### (b) Replace step numbers with node labels

A graph has no step numbers, so every remaining "step N" or "N of M" display needs to become a node-label display. Consume the `nodeId`, `label`, and `templateId` fields that task 7 added to `GET /api/enrollments/:id` and `GET /api/enrollments/:id/events` — do not re-derive labels or node counts by walking the graph yourself in the browser.

In `frontend/admin-ui/src/CampaignsTab.jsx`:

- Line 323 — the enrollment table's "Step" column currently does `{ key: "currentStepIndex", header: "Step", get: (d) => d.currentStepIndex + 1 }`. Change it to render the current node's label (sourced from the enrollment detail payload's resolved `label`, keyed by `currentNodeId`) instead of `currentStepIndex + 1`.
- Line 588 — the campaign list currently renders `<td>{c.steps.length}</td>`. Change it to render a node count (the graph's node count for the campaign) instead of the length of a `steps` array that no longer exists as the source of truth.

In `frontend/admin-ui/src/MessageTrackingTab.jsx`:

- Lines 75 and 79 — the `useEffect` dependency array includes `row.stepIndex` (line 75), and the history entry lookup is `data?.enrollment?.history?.find((h) => h.stepIndex === row.stepIndex)` (line 79). Change the lookup to match on `nodeId` instead of `stepIndex`, and update the `row.stepIndex` in the `useEffect` dependency array to `row.nodeId` (or whatever the equivalent field is once `row` itself is sourced from the nodeId-based `GET /api/sends` response from task 7).
- Line 109 — the source line currently reads `` `${data.campaign?.name || "Campaign"} · step ${row.stepIndex + 1}` ``. Change `step ${row.stepIndex + 1}` to the node's label.
- Line 130 — the "Step reached" progress line currently reads `` `${(data.enrollment?.currentStepIndex ?? 0) + 1} of ${data.campaign?.steps?.length ?? "?"}` ``. Change it to the current node's label plus the graph's node count (e.g. `"<label> of <nodeCount> steps"` or similarly clear phrasing) instead of a numeric "N of M".
- Line 187 (`{d.campaignName || "Campaign"} <span className="muted">· step {d.stepIndex + 1}</span>`) has the same pattern as line 109 and must be fixed the same way — render the node's label instead of `stepIndex + 1`.

## Boundary

- Does NOT touch `FlowCanvas.jsx` or `NodeConfigPanel.jsx` — task 10 owns those files exclusively.
- Does NOT change any backend file under `backend/node`.
- Does NOT re-implement graph traversal or node-count computation in the browser — consume `nodeId`/`label`/`templateId`/node-count fields already exposed by the endpoints task 7 finished.

## Acceptance criteria

- [ ] Connecting a brand-new data source (one with no hand-written column definitions anywhere in the frontend) renders correct preview-table and segment-builder columns with zero code change required.
- [ ] Neither `STATIC_SOURCES` nor `STATIC_SOURCE_COLUMNS` remains anywhere in the codebase (verified by a full-repo grep).
- [ ] The source picker in `CampaignsTab.jsx` lists sources dynamically rather than from a hardcoded array.
- [ ] Preview/segment columns are ordered canonical-keys-first, then remaining discovered fields, for every source (not just dynamic ones).
- [ ] No screen in `CampaignsTab.jsx` or `MessageTrackingTab.jsx` displays a numeric step index (no `currentStepIndex + 1`, `stepIndex + 1`, or `N of M` numeric progress text remains).
- [ ] The enrollment table's "Step" column and the message-tracking drill-down both name the current step by its node label, not a number.
- [ ] The campaign list shows a node count (not `steps.length`) per campaign.
- [ ] The message-tracking drill-down (`MessageTrackingTab.jsx`) resolves the correct history entry by matching `nodeId`, not `stepIndex`, and the relevant `useEffect` dependency array is updated accordingly.
- [ ] `FlowCanvas.jsx`, `NodeConfigPanel.jsx`, and all backend files are unmodified by this task.

## Commit convention

Your commit message MUST include `Closes #12` so the task's GitHub issue closes when the commit lands on the default branch.
