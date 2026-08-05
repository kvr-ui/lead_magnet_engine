---
task: 1
name: webhook-secret-verification
parallel_group: 1
depends_on: []
issue: 29
---

# Task 1: Verify the webhook shared secret on inbound calls

## What to build

`POST /api/wati/webhook` currently accepts any caller. A comment in the handler says so
outright. That means anyone who learns the URL can forge delivered/read/replied events,
poison the delivery funnel, and — worse — forge a STOP message that opts a real customer
out of every campaign.

The secret mechanism already exists and is simply not wired up:

- `WhatsAppIntegration.webhookSecret` is a required schema field.
- `whatsappProvider.connect()` generates it with `crypto.randomBytes(24).toString("hex")`
  and preserves it across reconnects.
- `whatsappProvider.findBySecret(secret)` is written and exported, with a comment saying
  `routes/wati.js` is meant to call it. Nothing does.
- The Integrations tab already renders and copies the full webhook URL including
  `?secret=<value>`, and `tools/webhook-bridge.js` already forwards an
  `x-webhook-secret` header end-to-end.

Wire it up. At the very top of the webhook handler — before any classification, before
any `MessageEvent` is written, before the STOP-keyword path runs — read the secret from
`req.query.secret` or the `x-webhook-secret` header, look it up with `findBySecret`, and
respond `401` when it does not match. Log every rejection with `console.warn` including
the length of what was supplied (never the value itself); WATI retries on non-2xx, so a
misconfigured operator shows up in the logs immediately rather than as silent data loss.

Do **not** introduce a `WATI_WEBHOOK_SECRET` environment variable. `.env.example`
documents that WATI configuration deliberately lives in MongoDB and that env vars are
one-time bootstrap only; a parallel env-based secret would fragment that convention.
Use the existing DB-backed secret.

The check fails closed by construction rather than through a config flag: `findBySecret`
only matches an integration with `active: true`, so an install with WhatsApp
disconnected rejects everything. That is correct — no legitimate webhook traffic can
exist for a disconnected integration either.

**One regression case must be documented in the commit message**: an operator who
registered a bare webhook URL with WATI *before* ever opening the Integrations tab has
been sending unauthenticated calls that used to be accepted and will now be rejected.
The fix is one step — reopen Integrations, re-copy the webhook URL, re-paste it into
WATI's webhook configuration. Say this explicitly in the commit body.

**Boundary:** this task touches only the top of the webhook handler. It does NOT change
event classification, does NOT change what fields land on `MessageEvent` (task 3), and
does NOT touch the STOP-keyword block (task 8). It does NOT add the rotation endpoint or
any UI — that is task 5.

## Acceptance criteria

- [ ] A POST to `/api/wati/webhook` with no secret returns `401` and writes zero `MessageEvent` documents
- [ ] A POST with an incorrect secret returns `401`
- [ ] A POST with the correct secret as `?secret=` returns `200` and writes the event
- [ ] A POST with the correct secret as an `x-webhook-secret` header returns `200` and writes the event
- [ ] A secret belonging to an inactive/disconnected integration is rejected
- [ ] Every rejection emits a `console.warn` that identifies the endpoint and the supplied length, never the supplied value
- [ ] No new environment variable is introduced
- [ ] `backend/node/tools/verify-webhook-auth.js` exists, follows the existing harness pattern, and covers all of the above
- [ ] The commit body documents the bare-URL regression and its one-step fix

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
