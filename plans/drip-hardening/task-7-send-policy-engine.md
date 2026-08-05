---
task: 7
name: send-policy-engine
parallel_group: 2
depends_on: [2]
issue:
---

# Task 7: Global frequency cap and quiet hours

## What to build

Nothing stops a contact enrolled in three campaigns from receiving three marketing
messages within an hour, and quiet hours exist only as per-wait-node configuration — a
setting an operator must remember to repeat on every wait node of every campaign, and
which does nothing at all for the first message after enrollment.

Add an account-level sending policy, enforced at send time, across all campaigns.

**Storage** — a new `lib/sendPolicy.js` backed by the existing schemaless `AppSetting`
key/value store under a `sendPolicy` key, holding: an on/off switch, a max-per-contact
count and window, quiet-hours settings (window, timezone, skipped weekdays), and a toggle
for whether manual one-off sends count against the same cap.

**Default off.** Until an operator turns it on, behavior is byte-for-byte what it is
today. This matches how the kill switch and the action node's `enabled` gate already
work: the safe default is inert.

**Reuse the walker's timezone arithmetic.** The wait node's window/skip-day clamping
function already does exactly "push this instant forward until it lands inside the window
and off a skipped day", with correct DST handling. It is currently not exported — export
it and use it. Do not write a second implementation of this, and do not fake a
zero-length wait node to reach it.

**Count sends from enrollment history, not message events.** History is written
synchronously in the same tick as the send. Message events depend on a webhook arriving,
so a lagging or misconfigured webhook would make the cap under-count and let *more*
messages through — a safety feature failing open. Include manual one-off sends under the
toggle, since the operator's goal is "don't spam this person", not "don't spam this
person from campaigns specifically".

**Where the check runs** — in the message node, after the target document is read and
**before** rendering params or calling the provider, and only when sending is globally
enabled. That last condition matters: if the kill switch is off, no history is being
written at all, and the quiet-hours clock would otherwise defer a lead for a block that
is not the real reason nothing is going out.

**How it blocks** — it defers, it never fails. Set `currentNodeId` explicitly back to
this node (decision nodes may have chained earlier in the tick), set `nextSendAt` to the
next allowed instant, set `stop = "throttled"`, and leave `status` and history untouched.
This joins the walker's existing family of deferral outcomes — `gated`, `waiting`, and
the `retrying` outcome from task 2 — and needs no special case in the single write point.

Add the policy read and the send-count query to the walker's injectable dependency set,
so the harness can drive the whole feature without touching the settings collection —
exactly as the activity lookup is injected today.

**Boundary:** this task edits the message-node block *before* the provider call. Task 2
owns the catch block *after* it; that is why this task depends on task 2 rather than
running beside it. This task does not build the admin UI — that is task 11.

## Acceptance criteria

- [ ] `lib/sendPolicy.js` reads and writes the policy through `AppSetting` with no schema migration
- [ ] The policy is off by default, and with it off the walk is byte-for-byte unchanged
- [ ] The wait node's existing window-clamping function is exported and reused; no second timezone implementation is added
- [ ] Send counts come from enrollment history, cross-campaign, scoped to the phone number
- [ ] Manual one-off sends count toward the cap only when the toggle is on
- [ ] Exceeding the cap sets `stop = "throttled"`, leaves `status` as `active`, writes no history entry, and pushes `nextSendAt` to the next eligible instant
- [ ] A send inside quiet hours defers to exactly the instant the shared clamping function returns
- [ ] The provider is never called on a throttled tick
- [ ] With sending globally disabled, the policy check is skipped entirely and existing gated behavior is unchanged
- [ ] The policy read and send-count query are injectable through the walker's dependency seam
- [ ] `backend/node/tools/verify-send-policy.js` covers the cap across two campaigns sharing one phone, the quiet-hours deferral, and the kill-switch-off case, asserting zero calls reached the injected sender

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
