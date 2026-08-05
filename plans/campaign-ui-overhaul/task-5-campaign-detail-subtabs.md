---
task: 5
name: campaign-detail-subtabs
parallel_group: 3
depends_on: [3, 4]
issue: 22
---

# Task 5: Split campaign detail into three sub-tabs

## What to build

The campaign detail view currently renders seven sections in one continuous scroll: the flow editor,
a segment builder, a matching-members table, preview/send controls, a delivery funnel, activity
stats, and an enrollments table with a message timeline. Reaching the Send button means scrolling
past an entire graph editor.

Restructure it into a pinned header above three sub-tabs.

**The pinned header** holds the campaign name, its source and channel, the status strip from task 3,
and the Pause / Duplicate / Close actions. It stays visible regardless of which sub-tab is active.
The status strip replaces the standalone paused notice and the standalone auto-enroll notice that
currently sit in the body — remove those, do not leave duplicates.

**The three sub-tabs:**

- **Flow** — the flow canvas and its validation panel.
- **Audience & Send** — the segment builder, the matching-members table, Preview, Send campaign, and
  the "keep this segment running" auto-enroll option with its explanatory text.
- **Results** — the delivery funnel, the post-campaign activity stats, the enrollments table with
  its status filter and pager, and the per-lead message timeline.

Use the existing nested-chip styling from the global stylesheet rather than the top-level tab
styling, so this reads as subordinate to the app's main navigation instead of competing with it.

**Critical — the Flow panel must never unmount.** The flow canvas holds the graph in its own local
state. If switching to another sub-tab unmounts it, unsaved graph edits are silently destroyed —
that would be a data-loss bug introduced by this restructure. Hide the Flow panel when it is not the
active tab; do not conditionally render it away. Verify the canvas re-measures and draws at full size
when its tab is shown again; the graph library measures its container on mount, so if it comes back
collapsed, fit the view on re-show.

Show an indicator on the Flow tab label when there are unsaved changes, using the dirty-state
callback added in task 4.

**Two bugs to fix while rebuilding this code**, both in the sections this task rewrites:

1. The Pause/Resume handler has no error handling and no in-flight state — pausing a live campaign
   can fail silently with the button appearing to do nothing. Give it the same treatment as the
   auto-enroll disarm handler directly below it, and disable the button while the request is in
   flight.
2. The Send button is disabled until a preview has been run against the current segment, but on
   first load it is disabled with no explanation at all — the "preview again" hint only appears once
   a preview has already happened. Always explain why Send is unavailable.

Preserve all existing behaviour otherwise: the campaign list, opening a campaign directly after a
"move to campaign" navigation, duplicating, deleting, and every data fetch. This is a restructure,
not a rewrite of the logic.

Do **not** change the create-campaign form (task 6), the enrollment table's columns (task 7), or the
confirmation dialogs (task 8).

## Acceptance criteria

- [ ] Campaign detail renders a pinned header plus three sub-tabs: Flow, Audience & Send, Results.
- [ ] The header contains the status strip from task 3, and the previous standalone paused and
      auto-enroll notices are removed rather than duplicated.
- [ ] Each of the seven original sections appears in exactly one sub-tab, per the grouping above.
- [ ] Sub-tabs use the nested-chip styling, not the top-level tab styling.
- [ ] Switching away from Flow and back preserves unsaved graph edits — the panel is hidden, never
      unmounted.
- [ ] The canvas renders at full size after returning to the Flow tab.
- [ ] The Flow tab label shows an indicator when there are unsaved changes.
- [ ] Pause/Resume surfaces errors and disables itself while in flight.
- [ ] Send always explains why it is unavailable when it is disabled, including on first load.
- [ ] Campaign list, focused-campaign navigation, duplicate, and delete all still work.
- [ ] `npm run build` and `npm run lint` succeed in `frontend/admin-ui`.

## Commit convention

Your commit message MUST include `Closes #22` so the task's GitHub issue closes when
the commit lands on the default branch.
