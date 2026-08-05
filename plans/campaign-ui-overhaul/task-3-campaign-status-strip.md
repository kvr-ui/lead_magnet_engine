---
task: 3
name: campaign-status-strip
parallel_group: 1
depends_on: []
issue: 20
---

# Task 3: Campaign status strip with global sending awareness

## What to build

A component that answers, in one glance and one sentence, what a campaign is actually doing right
now. Today this information is scattered across four places and one of them is not on the campaign
screen at all.

The four states it must compose:

1. **Global sending** — a system-wide kill switch that currently lives only in the app header. When
   it is off, no campaign sends anything, so a campaign can display "Active" and send nothing. This
   is the single most valuable thing the strip surfaces.
2. **Active vs paused** — the campaign's own flag.
3. **Published version vs draft** — whether the campaign has ever been published, which version is
   live, and whether the draft on the canvas now differs from it.
4. **Auto-enroll** — whether the source is being rescanned for new matches, on what filter, when it
   last ran, how many it added, and whether the last run errored.

Render badges for scanning (reuse the existing badge classes in the global stylesheet — success,
info, warning, neutral) plus a plain-English sentence composed from the above. The sentence is the
point: it must state what is happening and what would change, in the vocabulary an operator uses.
For example, when a draft differs from the live version, it must make clear that enrolled leads keep
walking the published version until a publish happens — that is precisely the misunderstanding this
strip exists to prevent.

When global sending is off, the strip leads with that, styled as a notice, and offers a way to turn
it on rather than sending the user hunting for the header switch.

Describing the auto-enroll filter in human terms must reuse the existing filter-describing helper
that the campaign screen already uses — do not write a second filter formatter.

**Also in this task:** the global sending state is currently fetched and held inside the header
toggle component. Lift that state up to the app root so it can be shared, and pass it down to the
campaigns tab. There must be exactly one fetch of the sending state, not a second poll added
alongside the existing one. The header toggle must keep working exactly as it does today.

This task delivers the component plus the state lift. It does **not** restructure the campaign
detail page or place the strip into it — task 5 consumes this component and removes the scattered
notices it replaces.

## Acceptance criteria

- [ ] A new status component renders badges plus one composed plain-English sentence covering global
      sending, active/paused, live version vs draft, and auto-enroll.
- [ ] When a draft differs from the live version, the sentence states that enrolled leads continue
      on the published version until publish.
- [ ] When global sending is off, that leads the strip as a notice and offers a way to turn it on.
- [ ] Auto-enroll description reuses the existing filter-describing helper; no second formatter is
      written.
- [ ] Auto-enroll's last-run time, count, and error (when present) are shown.
- [ ] Global sending state is lifted to the app root, fetched once, and passed to the campaigns tab.
- [ ] The existing header sending toggle behaves exactly as before, including its queued count and
      its own confirmation on turning sending on.
- [ ] Badges reuse existing badge classes; no new colour literals.
- [ ] `npm run build` and `npm run lint` succeed in `frontend/admin-ui`.

## Commit convention

Your commit message MUST include `Closes #20` so the task's GitHub issue closes when
the commit lands on the default branch.
