---
task: 4
name: flow-canvas-validation
parallel_group: 2
depends_on: [1]
issue: 21
---

# Task 4: Wire validation into the flow canvas

## What to build

Replace the flow canvas's single hardcoded validation rule with the full two-tier validation
delivered by task 1, and expose the canvas's unsaved-changes state to its parent.

Today the canvas checks exactly one thing — that every source node has a phone mapping — and uses it
to gate saving. That check becomes one error among many.

**The validation panel.** Render the errors and warnings from the validation module as two grouped
lists, errors first, each group with a count and a heading that says what the group means: errors
are problems that must be fixed before the flow can go live; warnings are things that will stall
leads that reach them. Every row is clickable and selects the offending node on the canvas, so
fixing a problem is one click from reading about it. A graph with no problems shows no panel.

**Gating.** Publish is blocked while any error is present. Save draft is blocked **only** by the two
errors the module marks as blocking a save (duplicate node ids and dangling edges) — every other
error must still allow saving, because half-built flows have to be saveable. When a button is
blocked, the reason must be visible; a disabled button with no explanation is the bug being fixed
here, not a pattern to copy.

**Dirty state.** The canvas already computes whether the current graph differs from the last
published version. Expose that to the parent through a callback prop, following the same pattern as
the existing validity callback. The parent will use it to mark a tab — this task only publishes the
signal.

Everything in this task is confined to the flow canvas component and the stylesheet. Do not modify
the campaign detail page — task 5 owns that.

## Acceptance criteria

- [ ] The canvas uses the task-1 validation module; the old single phone-mapping check no longer
      exists as a standalone rule.
- [ ] Errors and warnings render as two labelled, counted groups, errors first, hidden entirely when
      the graph is clean.
- [ ] Clicking any problem row selects that node on the canvas.
- [ ] Publish is disabled while any error is present, with the reason visible.
- [ ] Save draft is disabled only by duplicate node ids and dangling edges; all other errors still
      permit saving, with the reason visible when blocked.
- [ ] A new callback prop reports dirty state to the parent, following the existing validity-callback
      pattern.
- [ ] The existing save, publish, preset, and drag-and-drop behaviour is otherwise unchanged.
- [ ] No changes to the campaign detail page.
- [ ] `npm run build` and `npm run lint` succeed in `frontend/admin-ui`.

## Commit convention

Your commit message MUST include `Closes #21` so the task's GitHub issue closes when
the commit lands on the default branch.
