---
task: 8
name: wire-confirm-dialog
parallel_group: 4
depends_on: [2, 5]
issue: 25
---

# Task 8: Replace window.confirm on send and delete

## What to build

Two campaign actions carry real, irreversible consequences and both currently confirm through a raw
browser dialog:

- **Send campaign** — enrolls real leads and starts real WhatsApp messages. Its current confirmation
  builds a string of statistics that run together with no separation, in a popup that cannot be
  styled and barely formats.
- **Delete campaign** — also deletes every enrollment, stopping any lead mid-drip.

Replace both with the dialog component from task 2.

**Send.** Present the preview numbers as structured, labelled content rather than a run-on sentence:
how many matched, how many will actually be enrolled, how many are already enrolled, and how many
were skipped and why (no phone, invalid phone). When the "keep this segment running" option is
armed, the dialog must say what that means — the segment stays live and future matches join
automatically — because that is the part with lasting consequences. The confirm button uses the
dialog's pending state so a slow send cannot be double-fired.

**Delete.** Keep everything the current warning tells the user, presented legibly: the campaign name,
the number of enrollments that will be deleted and their breakdown by status, that any lead still
mid-drip stops receiving messages, that recorded delivery history is kept, and that it cannot be
undone. Mark the action as destructive so it is styled as such. A campaign with no enrollments gets
the simpler warning it gets today.

Both dialogs must be cancellable without side effects, and cancelling must leave the page exactly as
it was.

Leave the remaining `window.confirm` calls elsewhere in the app alone — the preset library's
confirmations and the header sending toggle keep theirs for now. Do **not** touch the create form
(task 6) or the enrollment table (task 7).

## Acceptance criteria

- [ ] Send campaign confirms through the task-2 dialog, showing matched / will-enroll /
      already-enrolled / skipped as structured labelled content.
- [ ] When auto-enroll is armed, the send dialog states that the segment stays live and future
      matches join automatically.
- [ ] The send confirm button uses the dialog's pending state and cannot be double-fired.
- [ ] Delete campaign confirms through the same dialog, preserving every fact the current warning
      states, and is marked destructive.
- [ ] A campaign with no enrollments shows the simpler delete warning.
- [ ] Cancelling either dialog leaves the page unchanged and performs no request.
- [ ] `window.confirm` no longer appears in the send or delete paths.
- [ ] Confirmations elsewhere in the app are untouched.
- [ ] `npm run build` and `npm run lint` succeed in `frontend/admin-ui`.

## Commit convention

Your commit message MUST include `Closes #25` so the task's GitHub issue closes when
the commit lands on the default branch.
