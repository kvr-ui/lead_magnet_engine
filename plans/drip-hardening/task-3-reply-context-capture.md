---
task: 3
name: reply-context-capture
parallel_group: 1
depends_on: []
issue: 31
---

# Task 3: Capture reply-context id and interactive type on MessageEvent

## What to build

The webhook receiver already extracts a reply-context id from inbound payloads and uses
it transiently to locate the enrollment a reply belongs to — then discards it. It also
never reads the payload's interactive `type` field at all.

Persist both, so a later condition node can ask "did they reply to *this* message node"
rather than approximating with "any inbound message after this node's send time". The
approximation is wrong the moment two message nodes fire close together: a reply to the
first would be attributed to the second.

Add two optional fields to `MessageEvent`:

- `inReplyToProviderMessageId` — indexed, the wamid of *our* message this inbound event
  answers (the reply-context id already being computed).
- `interactiveType` — the raw payload `type` (`"button"`, `"list"`, `"text"`, or absent),
  which is how a quick-reply tap is distinguished from typed text.

Populate both in the existing `MessageEvent.create` call. Both are optional, so
historical rows simply lack them and any future evaluator treats that as "no data",
which is a case the walker already handles everywhere else.

**Button payload is a known unknown, and must be handled honestly.** The only real
captured fixture in this repository shows an inbound button event as
`{ eventType: "message", type: "button", text: "Final Session" }` — the button's display
text, with no separate machine-stable payload id. Capture a payload id opportunistically
if one is present under any of the plausible field names, store it, but do not make
anything depend on it and do not invent a field name in the schema comment as though it
were confirmed. The handler already logs the full raw inbound body; note in the commit
body that the real field name should be confirmed by sending one real quick-reply
template and reading that log.

**Boundary:** this task only captures and persists fields. It does NOT add the webhook
secret check (task 1), does NOT change the STOP-keyword block or add opt-out button
handling (task 8), and does NOT add any condition evaluator that reads these fields
(task 9).

## Acceptance criteria

- [ ] `MessageEvent` has `inReplyToProviderMessageId` (indexed, optional) and `interactiveType` (optional)
- [ ] An inbound reply carrying a reply-context id persists it on the event
- [ ] An inbound button event persists `interactiveType: "button"` and its display text in the existing `text` field
- [ ] A payload id, when present, is captured opportunistically; its absence breaks nothing
- [ ] Inbound events without either field still write successfully, unchanged from today
- [ ] Existing webhook behavior — classification, enrollment matching, provider-id backfill — is unchanged
- [ ] `backend/node/tools/verify-webhook.js` is extended (or a sibling harness added) asserting both fields land from a realistic button payload
- [ ] The commit body notes that the button payload-id field name is unconfirmed and how to confirm it

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
