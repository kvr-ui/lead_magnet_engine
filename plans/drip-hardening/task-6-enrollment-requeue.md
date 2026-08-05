---
task: 6
name: enrollment-requeue
parallel_group: 2
depends_on: [2]
issue: 34
---

# Task 6: Requeue parked enrollments (API + stuck-leads UI)

## What to build

Enrollments park as `paused` (the graph is broken and needs an edit) or `failed` (an
unrecoverable send or a vanished target). Once the operator fixes the underlying cause —
publishes a corrected graph, restores the provider, gets a template approved — there is
no way to put those leads back into motion. The only enrollment-level endpoint today
cancels a single enrollment.

Build the recovery half:

- `POST /campaigns/:id/enrollments/:enrollmentId/retry` — requeue one enrollment.
- `POST /campaigns/:id/enrollments/retry-bulk` with `{ status, ids? }` — requeue every
  enrollment in the given status for the campaign, or just the listed ids. Cap a single
  call at a few hundred so one request cannot rewrite an unbounded collection; report how
  many were requeued and whether the cap truncated the batch. Never silently truncate.
- `GET /campaigns/:id/enrollments/stuck` — a rollup grouped by status and, where present,
  the failure classification recorded by task 2, so the UI can say *why* leads are stuck
  before offering to retry them.

Requeuing resets `status` to `active`, clears `statusReason`, resets the send-attempt
counter added in task 2, and sets `nextSendAt` to now. It must leave `currentNodeId` and
`graphVersion` alone — the lead resumes where it stopped, on the graph version it was
walking, not at the start. After a successful requeue, fire the existing poll kick so the
leads move within seconds rather than waiting for the next scheduled tick.

Surface it in the campaign's results view: a stuck-leads block showing the count with its
breakdown by reason, and a **Retry all** action. When nothing is stuck, the block stays
out of the way rather than rendering an empty shell.

**Boundary:** this task adds routes and UI only. It does not change the walker. It
depends on task 2 for the `sendAttempts` field it resets and the classification it groups
by.

## Acceptance criteria

- [ ] Single-enrollment retry sets `status` to `active`, `nextSendAt` to now, clears `statusReason`, and zeroes the attempt counter
- [ ] Retry preserves `currentNodeId` and `graphVersion` — the lead resumes where it stopped
- [ ] Bulk retry accepts an explicit id list or a whole status, and reports the number requeued
- [ ] Bulk retry is capped per call and reports when the cap truncated the batch
- [ ] Cancelled and completed enrollments are not swept up by a bulk retry of `failed`/`paused`
- [ ] The poll kick fires after a requeue, so a requeued lead sends within seconds
- [ ] `GET .../enrollments/stuck` returns counts grouped by status and failure classification
- [ ] The results view shows the stuck count with its breakdown and a Retry all action, and renders nothing when there is nothing stuck
- [ ] `backend/node/tools/verify-requeue.js` seeds parked enrollments, requeues them, and asserts the field-level outcomes above
- [ ] The frontend builds clean

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
