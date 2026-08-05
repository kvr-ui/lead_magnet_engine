---
task: 9
name: reply-button-evaluators
parallel_group: 2
depends_on: [3]
issue:
---

# Task 9: Reply-text and button condition evaluators

## What to build

A condition node can currently ask whether a message was sent, delivered, read, replied
to or failed — a delivery-status boolean. It cannot ask *what* the contact said. For a
WhatsApp drip that is the central missing capability: "if they tapped **Interested**,
send the brochure; otherwise wait two days and nudge" is the shape most real flows want,
and today it is unbuildable.

Add two new condition evaluation kinds beside the four that exist:

- **reply** — did the contact's reply to a given upstream message node match one of a set
  of words or phrases, either as a substring or as a whole-value equality.
- **button** — did the contact tap a quick-reply or CTA button matching one of a set of
  labels.

Both take the same shape as the existing engagement kind: they name an upstream message
node, and are scoped to that node's send. Match against the events for that specific send
using the provider message id recorded on the enrollment's history entry, together with
the reply-context id persisted by task 3 — that pairing is what makes "did they reply to
*this* node" exact rather than an approximation. Where no provider id was captured, fall
back to the same time-based scoping the existing engagement evaluator already uses, so
behavior degrades the way the surrounding code already degrades rather than in a new way.

Matching is normalised for case and surrounding whitespace. Button matching keys on the
button's label text as the primary and reliable path; if a machine-stable payload id was
opportunistically captured, it may be checked too, but nothing may depend on it — the
only real fixture in this repository shows a button arriving as display text with no
separate id.

Follow the existing evaluator conventions exactly: a misconfigured node (no upstream node
named, no values to match) throws a descriptive message that the condition handler turns
into a park with a human-readable reason; the evaluator itself performs no writes; and
lookups go through the walker's injectable dependency seam so the harness can drive them
without a live database.

**Boundary:** this task adds evaluators and their dispatch only. It does not touch the
message-node block (tasks 2 and 7), does not change the webhook (tasks 1, 3, 8), and does
not build the configuration UI or validation warnings — that is task 12.

## Acceptance criteria

- [ ] Two new condition kinds are dispatched alongside the existing four, with the existing four unchanged
- [ ] A reply matching a configured phrase routes down the yes branch; a non-matching reply routes down the no branch
- [ ] A button tap matching a configured label routes down the yes branch
- [ ] Matching supports both substring and whole-value modes, and is normalised for case and surrounding whitespace
- [ ] Matching is scoped to the named upstream message node's send, not to any inbound message on the phone
- [ ] When no provider id was captured for that send, the evaluator falls back to the same time-based scoping the existing engagement evaluator uses
- [ ] A node with no upstream message named, or no values configured, parks the enrollment with a descriptive reason rather than silently taking a branch
- [ ] No reply yet evaluates as false rather than parking
- [ ] Evaluators perform no writes and reach the database only through the injectable dependency seam
- [ ] Nothing depends on a button payload id being present
- [ ] `backend/node/tools/verify-reply-branching.js` drives a graph with both new kinds and asserts yes/no routing for matching and non-matching inbound events

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
