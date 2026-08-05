# Plan: campaign-ui-overhaul

## Goal

Make the campaign screen usable by separating the three unrelated jobs it currently stacks in one
scroll — authoring a flow, choosing an audience and sending, watching results — and by making the
system's real state legible: what is actually live, what will break before it is published, and why
a lead is stuck. Frontend only; every value this plan needs is already served by the backend.

## Approach

`CampaignDetail` becomes a pinned header (name, status strip, Pause / Duplicate / Close) above three
sub-tabs: **Flow**, **Audience & Send**, **Results**. The Flow panel stays mounted when hidden so
unsaved graph edits survive tab switching.

Around that restructure, four independent pieces land as new modules: a `validateGraph` checker that
mirrors the backend's own graph invariants and gates Publish, a `CampaignStatus` strip that composes
four scattered state indicators (including the *global* sending kill switch) into one sentence, a
themed `ConfirmDialog` replacing `window.confirm` on the two destructive actions, and the surfacing
of `statusReason` — a field the backend already records and already sends, which the UI has never
displayed.

## Decisions & Rejected Alternatives

- **Three sub-tabs, not a full-screen flow editor or a sticky section nav** — the three jobs happen
  on different days and deserve separate surfaces. Rejected: full-screen canvas (helps authoring
  only, leaves the other five sections as one scroll); sticky jump-nav (smallest change, but the
  page is still one scroll doing three jobs).

- **The Flow panel is hidden, never unmounted** — `FlowCanvas` holds the graph in local
  `useNodesState`/`useEdgesState`. Unmounting on tab switch would silently discard unsaved edits, so
  the restructure would have introduced a data-loss bug. Rejected: auto-saving the draft on switch
  (writes to the server without asking, and makes "Save draft" meaningless); a confirm-on-leave
  prompt (friction on every switch, and it is exactly the browser-dialog pattern this plan is
  removing); lifting graph state into `CampaignDetail` (architecturally cleanest but a real refactor
  of FlowCanvas's save/publish paths, disproportionate to the problem).

- **Validation is two-tiered — errors block Publish, warnings only inform** — the walker's stated
  contract is *"a broken graph parks, it never throws"*, so a half-built flow is genuinely
  publishable and its parked leads are recoverable by fixing config and republishing. Blocking
  everything would fight iterative building. Rejected: warn-only (the list becomes something you
  learn to click past); block-everything (prevents publishing a flow whose later branches are
  unfinished, which the backend tolerates by design).

- **Duplicate node IDs and dangling edges block Save draft too, not just Publish** — these two are
  rejected by Mongoose validators on *save*. Treating them as publish-only errors would let the
  draft PUT return 400 with no explanation. Every other error blocks Publish alone.

- **Validation mirrors the backend rather than inventing rules** — the checks are ports of
  `graphIntegrityErrors()` and `sourceEntryPoints()`. Any rule not derived from real backend
  behaviour would drift into lying about what will actually happen.

- **The status strip reads the global sending switch** — that switch lives in the app header, so a
  campaign can display "Active" while sending nothing. Answering "why is nothing going out?" without
  leaving the page is the single highest-value thing the strip does. Rejected: badges-only (compact,
  but cannot explain that leads keep walking the old version when a draft differs).

- **The create form's source picker is made real, not deleted** — choosing a source up front is the
  right instinct; today the dropdown is dead UI, because `POST /campaigns` discards `targetModel` and
  the field no longer exists on the model. It will now seed an actual source node into the new
  campaign's graph. Rejected: dropping it entirely (leaves you at a blank canvas with no hint that a
  source node is mandatory); keeping the embedded `FlowCanvas` inside the form (a full drag-and-drop
  editor inside a form whose canvas cannot save or publish).

- **`campaign.targetModel` reads stay, writes go** — the read fallbacks still serve rows written
  before campaigns became graphs.

- **Scope is campaigns only** — the other five tabs keep their known issues (raw `JSON.stringify` in
  table cells, `.catch(() => {})` error swallowing, desktop-only layout). `ConfirmDialog` is built to
  be reusable so a later sweep is cheap. Rejected: applying the shared fixes app-wide now (roughly
  doubles the diff and the review surface).

- **URL deep-linking deferred** — a refresh still returns you to the first tab. Considered and
  explicitly not taken this round.

- **No automated verification exists** — the repo has no test suite and no test runner. Verification
  is `npm run build`, `npm run lint` (oxlint), and a manual walkthrough. Stated plainly rather than
  implying coverage this plan does not create.

## Tasks

| # | Task | Phase | Depends on | Status |
|---|------|-------|------------|--------|
| 1 | Graph validation module mirroring backend invariants | 1 | — | pending |
| 2 | Themed confirm dialog component | 1 | — | pending |
| 3 | Campaign status strip with global sending awareness | 1 | — | pending |
| 4 | Wire validation into the flow canvas | 2 | 1 | pending |
| 5 | Split campaign detail into three sub-tabs | 3 | 3, 4 | pending |
| 6 | Create form seeds a real source node | 4 | 5 | pending |
| 7 | Surface why leads are stuck | 4 | 5 | pending |
| 8 | Replace window.confirm on send and delete | 4 | 2, 5 | pending |

## Execution phases

- **Phase 1 (parallel):** task-1, task-2, task-3 — three independent new modules, no shared files.
- **Phase 2:** task-4 — needs the validation module from task-1; confined to `FlowCanvas.jsx`.
- **Phase 3:** task-5 — the restructure; needs the status strip (task-3) and the canvas's new
  dirty-state callback (task-4).
- **Phase 4 (parallel):** task-6, task-7, task-8 — all three edit `CampaignsTab.jsx`, but in
  disjoint regions (the create form, the Results tab, the send/delete handlers). Each task's brief
  names its boundary explicitly so the regions do not overlap.

## Issues

- [ ] #18 — Graph validation module mirroring backend invariants
- [ ] #19 — Themed confirm dialog component
- [ ] #20 — Campaign status strip with global sending awareness
- [ ] #21 — Wire validation into the flow canvas
- [ ] #22 — Split campaign detail into three sub-tabs
- [ ] #23 — Create form seeds a real source node
- [ ] #24 — Surface why leads are stuck
- [ ] #25 — Replace window.confirm on send and delete
