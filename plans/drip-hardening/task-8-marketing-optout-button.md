---
task: 8
name: marketing-optout-button
parallel_group: 2
depends_on: [3]
issue:
---

# Task 8: Route the marketing opt-out button into OptOut

## What to build

Global opt-out today triggers only on an inbound message whose entire trimmed body
matches a STOP keyword. WhatsApp marketing templates also carry a built-in opt-out
button, and a contact who taps it arrives as a button event rather than as typed text —
so today, the clearest possible signal that someone wants out is ignored.

Route it into the opt-out path that already exists.

Add a matcher beside the existing STOP-keyword set that recognises a marketing opt-out
button: it must require the event to be a button interaction (using the interactive type
persisted by task 3), and match the button's label against a small set of known opt-out
labels, normalised for case and surrounding whitespace. OR it into the existing keyword
check so both paths feed the same unchanged opt-out recording — which already writes the
global opt-out row and cancels every active enrollment for that phone across all
campaigns.

Keep the existing isolation properties of that block: it is additive, wrapped so a
failure cannot turn into a webhook error, and non-STOP inbound replies remain completely
unaffected.

**The exact label is a guess and must stay independently revertible.** "Stop promotions"
is the standard label, but nothing in this repository confirms that the provider forwards
it verbatim rather than translating or relabelling it. Keep this change in its own commit
so it can be reverted without touching anything else, and note in the commit body that
the label should be confirmed against a real inbound button event before this is relied
on in production.

**Boundary:** this task touches only the STOP-keyword block. It does not change the
opt-out recording function itself, does not touch the webhook secret check (task 1), and
does not touch what fields are persisted on the event (task 3, which it depends on for
the interactive type).

## Acceptance criteria

- [ ] A button event whose label matches a known marketing opt-out label creates a global opt-out row and cancels that phone's active enrollments across all campaigns
- [ ] Matching requires the interactive type to be a button — typed text that happens to read like a button label does not match through this path (the existing STOP-keyword path is unaffected)
- [ ] Label matching is normalised for case and surrounding whitespace
- [ ] A button event with any other label is not treated as an opt-out and flows through normally
- [ ] The existing STOP-keyword behavior is unchanged
- [ ] The opt-out recording function itself is unmodified
- [ ] A failure inside this block cannot surface as a webhook error
- [ ] The change is confined to one commit whose body flags the label as unconfirmed
- [ ] Harness coverage asserts both the opt-out row and the enrollment cancellation

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
