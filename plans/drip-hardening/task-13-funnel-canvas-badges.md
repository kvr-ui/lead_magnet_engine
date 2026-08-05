---
task: 13
name: funnel-canvas-badges
parallel_group: 3
depends_on: [10]
issue: 41
---

# Task 13: Funnel badges on the flow canvas

## What to build

The flow canvas shows structure and no numbers, so an operator cannot see where leads are
piling up, where they are dropping out, or whether a branch is ever taken. Task 10 exposes
those counts; render them.

Fetch the funnel for the graph version currently being viewed and attach each node's
counts to the node data the canvas already assembles. Render a compact badge on each node
in the style of the existing action-node badge — reached, and where they are non-zero,
errored and parked-here. Keep it readable at a glance on a canvas of twenty nodes; detail
belongs in a tooltip or the node's panel, not in the badge.

Compute per-edge drop-off on the client from the counts of the nodes an edge connects, so
the endpoint stays a dumb counter and the topology math stays where the topology already
lives.

Two honesty requirements:

- **Label the time origin.** Decision-node visits before the tracking in task 4 shipped
  were never recorded and cannot be recovered. The panel must say the counts cover
  activity since that point rather than implying a complete history.
- **Do not silently mix versions.** The counts belong to one graph version. When
  enrollments exist on other versions, say so as a separate note — never fold them into
  the badges, and never leave the operator to assume the numbers cover everyone.

A campaign with no enrollments should show clean zeroes rather than badges full of blanks
or a broken layout, and a failed funnel fetch should leave the canvas fully usable without
numbers rather than blocking the editor.

**Boundary:** rendering only. The aggregation is task 10; the underlying visit records are
task 4.

## Acceptance criteria

- [ ] Each node renders a badge with its reached count, plus errored and parked-here when non-zero
- [ ] Badges follow the existing node-badge styling and stay legible on a large graph
- [ ] Per-edge drop-off is computed client-side from node counts
- [ ] Counts shown correspond to the graph version being viewed
- [ ] The view states that counts cover activity since node-visit tracking shipped
- [ ] Enrollments on other graph versions are surfaced as a separate note, never merged into badges
- [ ] A campaign with no enrollments renders zeroes without layout breakage
- [ ] A failed funnel fetch leaves the canvas fully usable, editing included
- [ ] The frontend builds clean

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
