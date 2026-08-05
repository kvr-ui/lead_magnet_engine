---
task: 5
name: webhook-secret-rotation
parallel_group: 2
depends_on: [1]
issue:
---

# Task 5: Rotate the webhook secret from the Integrations tab

## What to build

Once inbound webhooks are authenticated by a shared secret, an operator needs a way to
change that secret — after sharing a URL too widely, after a suspected leak, or as
routine hygiene. Today the secret is generated once on first connect and preserved
across every reconnect, so there is no way to change it short of editing MongoDB.

Add rotation end to end:

- A `rotateWebhookSecret()` function in the WhatsApp provider module, mirroring the shape
  of the existing `connect` / `disconnect` functions: load the active integration, throw
  the module's existing not-connected error if there is none, generate a new secret with
  the same `crypto.randomBytes(24).toString("hex")` the connect path uses, save, and
  return the same status shape the other functions return.
- A `POST /api/integrations/whatsapp/rotate-secret` route alongside the existing
  integration routes.
- A **Rotate** button in the Integrations tab, beside the existing webhook-URL copy
  field, behind a confirmation dialog. The confirmation must be explicit about the
  consequence: the previous URL stops working immediately, and until the new URL is
  pasted into WATI's webhook configuration, delivery/read/reply tracking and STOP
  opt-outs will silently stop arriving. After rotating, the displayed URL must refresh
  to the new secret so the operator can copy it in the same visit.

**Boundary:** this task does not change the verification logic added in task 1, and does
not touch anything in the campaign engine.

## Acceptance criteria

- [ ] `rotateWebhookSecret()` exists in the provider module and follows the existing connect/disconnect shape, including the not-connected error path
- [ ] Rotating produces a new secret of the same form and length as the one generated at connect
- [ ] `POST /api/integrations/whatsapp/rotate-secret` returns the refreshed status
- [ ] After rotation, a webhook call with the old secret returns `401` and one with the new secret returns `200`
- [ ] The Integrations tab exposes a Rotate button behind a confirmation that names the consequence for delivery tracking and opt-outs
- [ ] The displayed webhook URL updates to the new secret without a page reload
- [ ] Rotation while WhatsApp is disconnected fails cleanly with the module's existing not-connected error rather than creating a document
- [ ] The frontend builds clean

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
