---
task: 2
name: send-error-classification
parallel_group: 1
depends_on: []
issue:
---

# Task 2: Classify send errors and retry with backoff

## What to build

Today any error thrown by the provider during a message-node send — other than the
kill-switch and allowlist errors, which correctly abandon the tick without writing
anything — parks the enrollment as `failed` permanently. A 429, a provider 5xx, or a DNS
blip burns that contact for the life of the campaign. There is no attempt counter
anywhere on the enrollment.

Add error classification and bounded retry with backoff.

**Classification** lives in a new pure module, `lib/errorClassification.js` — no
database, no network, so the harness can exercise it directly:

- `retryable` — no HTTP status at all (DNS failure, timeout, connection refused: `fetch`
  itself threw before any response), plus 429, 500, 502, 503, 504.
- `undeliverable` — provider error codes indicating the number cannot receive the
  message.
- `terminal` — everything else (bad template, malformed params, auth failure).

Backoff schedule is `[1m, 5m, 15m, 1h, 4h]`, with the attempt ceiling overridable by
`CAMPAIGN_MAX_SEND_ATTEMPTS`.

**Structured error fields.** The WATI client currently throws a plain `Error` with the
HTTP status interpolated into the message string, and a genuine network failure never
reaches that line at all. Attach `httpStatus`, `providerErrorCode` and `providerResponse`
to the error at the throw site and classify off those fields. Never regex the message
string. This follows the convention already used for `err.sendingDisabled` and
`err.notAllowlisted`.

**Enrollment fields.** Add `sendAttempts` (Number, default 0) and `lastAttemptClass`
(String) to `CampaignEnrollment`. No migration is needed: Mongoose applies schema
defaults when hydrating documents whose path is absent, which is the same reasoning the
existing `historyEntrySchema.kind` default relies on.

**Walker change**, in the message node's catch block:

- The `sendingDisabled` / `notAllowlisted` short-circuit stays exactly as it is. A closed
  gate must still write nothing at all.
- `retryable` and still under the attempt budget: append the failed attempt to history
  with an `attempt N/M` detail, set `currentNodeId` back to *this* node (decision nodes
  may have chained earlier in the tick, so it must be set explicitly), push `nextSendAt`
  by the backoff for this attempt number, record the incremented counter, set
  `stop = "retrying"`, and **leave `status` untouched** so the lead stays `active`.
- `terminal`, `undeliverable`, or retries exhausted: park as `failed` exactly as today,
  but with a reason naming the attempt count and the classification.
- On a successful send, reset `sendAttempts` to 0 so the streak does not leak across
  nodes.

`applyWalkResult` gains two conditional writes and no restructuring — it already only
writes fields that are defined, and it must remain the single write point.

**Explicit decision to honor:** an `undeliverable` classification parks the enrollment
with a distinct `statusReason` and does **not** call `recordOptOut`. A delivery failure
is not the customer asking to stop, and auto-unsubscribing someone across every campaign
based on a provider error code is a one-way action an operator should make deliberately.

**Boundary:** this task owns the message node's catch block. It does NOT add the
frequency cap or quiet-hours check that runs *before* the send — that is task 7, which
depends on this task precisely because it edits the same block. It does NOT add the
requeue API or any UI — that is task 6.

## Acceptance criteria

- [ ] `lib/errorClassification.js` is pure (no I/O) and classifies retryable / undeliverable / terminal as described
- [ ] A network failure with no HTTP status classifies as `retryable`
- [ ] The WATI client attaches `httpStatus`, `providerErrorCode` and `providerResponse` at its throw sites; nothing classifies by parsing a message string
- [ ] `CampaignEnrollment` has `sendAttempts` (default 0) and `lastAttemptClass`, with no migration script
- [ ] A retryable failure under budget leaves `status` as `active`, restores `currentNodeId` to the message node, and sets `nextSendAt` to exactly the scheduled backoff instant
- [ ] A terminal failure parks as `failed` immediately regardless of remaining attempt budget
- [ ] Exhausting the attempt budget parks as `failed` with a reason naming the count and classification
- [ ] A successful send resets `sendAttempts` to 0
- [ ] The `gated` path (kill switch, allowlist) still writes nothing at all — byte-for-byte unchanged enrollment
- [ ] `walkEnrollment` still never throws, and `applyWalkResult` remains the single write point
- [ ] An `undeliverable` classification does not create an `OptOut` or cancel enrollments
- [ ] `backend/node/tools/verify-retry-backoff.js` drives 503 → 429 → success across ticks with an injected frozen clock and asserts every point above

## Commit convention

Your commit message MUST include `Closes #<issue-number>` so the task's GitHub issue
closes when the commit lands on the default branch.
