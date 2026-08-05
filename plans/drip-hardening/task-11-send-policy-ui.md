---
task: 11
name: send-policy-ui
parallel_group: 3
depends_on: [7]
issue:
---

# Task 11: Send-policy admin UI

## What to build

The account-level sending policy from task 7 is inert until an operator can see and change
it. Expose it.

Add read and update routes for the policy beside the existing settings routes, delegating
all validation and defaulting to the policy module rather than re-implementing either in
the route.

Add a **Sending policy** panel to the Integrations tab, which already owns the
WhatsApp-adjacent operator controls:

- an on/off switch for the whole policy, clearly showing that off means no capping and no
  quiet hours;
- the max-per-contact count and its window;
- quiet hours: window start and end, timezone, and skipped weekdays — reuse the wait
  node's existing window sub-form rather than building a second set of these inputs;
- the toggle for whether manual one-off sends count toward the cap.

Two things the panel must communicate, because both are surprising otherwise: the policy
applies across *all* campaigns for a contact, not per campaign; and a blocked send is
deferred to the next allowed slot, never dropped or failed.

Invalid input — an inverted quiet-hours window, a zero or negative cap, an unknown
timezone — must be rejected with a message that says what is wrong, not saved and
discovered later as a parked enrollment.

**Boundary:** this task is routes and UI only. The policy module, its defaults, and the
enforcement in the walker all belong to task 7.

## Acceptance criteria

- [ ] Read and update routes for the policy exist and delegate validation to the policy module
- [ ] The Integrations tab has a Sending policy panel covering the switch, cap, quiet hours and manual-send toggle
- [ ] The wait node's existing window sub-form is reused rather than duplicated
- [ ] The panel states that the policy spans all campaigns and that blocked sends are deferred rather than dropped
- [ ] Saving with the policy off makes no behavioral change to sending
- [ ] An inverted quiet-hours window, a non-positive cap, or an unknown timezone is rejected with a specific message
- [ ] Values persist across a reload and are picked up by the engine without a restart
- [ ] The frontend builds clean

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
