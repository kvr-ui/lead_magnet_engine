---
task: 7
name: surface-stuck-leads
parallel_group: 4
depends_on: [5]
issue: 24
---

# Task 7: Surface why leads are stuck

## What to build

The campaign engine's explicit contract is that a broken graph *parks* a lead rather than throwing.
A message node with no template, a wait with no duration, a split with a bad ratio — each ends with
the enrollment quietly marked paused or failed. Every one of those parks records a human-readable
reason on the enrollment, and the enrollments endpoint already returns it unfiltered. The UI has
never displayed it, so from the operator's side leads simply stop, with no explanation anywhere.

Surface it in the Results sub-tab. No backend change is needed or permitted.

**Per row:** add a column to the enrollments table showing each enrollment's recorded reason. Empty
for enrollments that are progressing normally.

**Above the table:** a rollup of the enrollments that are not progressing — paused and failed —
grouped by reason with a count each, so the shape of the problem is visible without reading the
table row by row. Something an operator can act on: how many leads are stuck, and on what.

The rollup must describe the whole campaign, not just the page currently loaded — the enrollments
table is paginated, so a count derived only from the visible page would be wrong and misleading.
Work out how to get a campaign-wide picture from what the existing endpoint offers (it accepts a
status filter and reports totals), and if a complete rollup is not achievable without a backend
change, say so plainly in the UI rather than presenting a partial count as if it were total.

Respect the existing status filter and pager behaviour, and leave the per-lead message timeline as
it is.

Your edits are confined to the Results sub-tab's enrollment section. Do **not** touch the create
form (task 6) or the confirmation dialogs (task 8).

## Acceptance criteria

- [ ] The enrollments table has a column showing each enrollment's recorded reason, blank when there
      is none.
- [ ] A rollup above the table groups non-progressing enrollments by reason with counts.
- [ ] The rollup is campaign-wide, not page-scoped — or, if that is impossible without a backend
      change, its scope is stated plainly in the UI rather than implied to be total.
- [ ] No backend files are modified.
- [ ] The existing status filter, pager, and per-lead message timeline still work.
- [ ] A campaign with no stuck leads shows no rollup rather than an empty box.
- [ ] `npm run build` and `npm run lint` succeed in `frontend/admin-ui`.

## Commit convention

Your commit message MUST include `Closes #24` so the task's GitHub issue closes when
the commit lands on the default branch.
