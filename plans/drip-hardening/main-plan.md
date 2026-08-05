# Plan: drip-hardening

## Goal

Close the five gaps that stand between the campaign engine and a production drip tool:
transient send errors permanently burning contacts, an unauthenticated webhook, no
branching on what a contact actually says, no cross-campaign frequency cap or quiet
hours, and no per-node numbers on the canvas.

## Approach

Everything is additive to the existing graph walker — no new node kinds, no change to
the version-pinning model, no migration. Two new "defer, don't fail" outcomes
(`retrying`, `throttled`) join the walker's existing `gated`/`waiting` family; two new
condition `on` values join the existing four; one new collection carries the funnel
counts the walker already computes and throws away.

**Invariants every task must preserve:** `walkEnrollment` never throws;
`applyWalkResult` is the single write point; a `gated` result writes nothing at all;
a dry run has zero outbound side effects.

## Decisions & Rejected Alternatives

- **Use the existing DB-backed webhook secret, not a new env var** — `WhatsAppIntegration.webhookSecret` is already required, generated on connect, exposed by `findBySecret()`, and rendered as a copy-ready `?secret=` URL in the Integrations tab. Nothing calls it. Rejected: a `WATI_WEBHOOK_SECRET` env var (`.env.example` documents that WATI config deliberately moved out of env into Mongo; a parallel mechanism fragments that).
- **Fail closed structurally, not behind a config flag** — `findBySecret` only matches an *active* integration, so a disconnected install rejects everything, which is correct because no legitimate traffic can exist then either. Rejected: a log-only bake-in window (blast radius is one operator action).
- **Track node visits in a new collection, not `history[]`** — `historyEntrySchema.kind` is `enum: ["message","action"]`; decision nodes write no history by design, so the funnel cannot be built from it. The walker already computes a full per-tick `result.visited` of every kind and discards it. Rejected: logging every decision visit into `history[]` (unbounded growth on loop-heavy graphs, mutates a user-facing document).
- **Count frequency-cap sends from `CampaignEnrollment.history`, not `MessageEvent`** — history is written synchronously in the same tick as the send. `MessageEvent` depends on a webhook arriving, so a lagging or misconfigured webhook would make the cap under-count and let *more* messages through: a safety feature failing open.
- **An `undeliverable` provider code parks as `failed` with a distinct reason; it does NOT auto-fire `recordOptOut`** — a delivery failure is not the customer asking to stop, and auto-unsubscribing across every campaign off a guessed code is a one-way foot-gun. Rejected: auto-opt-out on 131026/131047.
- **Scope the funnel strictly by `graphVersion`** — a node id means something only inside the version that declared it; painting v1 traffic onto a v3 node is misleading. Other-version enrollments report as one `legacyVersionEnrollments` total, mirroring `graphNodeIndex`'s existing version-pinned resolution.
- **Button matching keys on normalized text; payload-id capture is best-effort** — the only real fixture in the repo shows `{ type: "button", text: "Final Session" }` with no separate id field. Rejected: guessing a payload field name and depending on it.
- **Defer, never fail** — the frequency cap and the retry both push `nextSendAt` and leave `status` alone rather than introducing a new failure mode.

## Tasks

| # | Task | Phase | Type | Depends on | Status |
|---|------|-------|------|------------|--------|
| 1 | Verify the webhook shared secret on inbound calls | 1 | backend | — | pending |
| 2 | Classify send errors and retry with backoff | 1 | backend | — | pending |
| 3 | Capture reply-context id and interactive type | 1 | backend | — | pending |
| 4 | Track per-node visits in CampaignNodeVisit | 1 | backend | — | pending |
| 5 | Rotate the webhook secret from the Integrations tab | 2 | ui | 1 | pending |
| 6 | Requeue parked enrollments (API + stuck-leads UI) | 2 | backend | 2 | pending |
| 7 | Global frequency cap and quiet hours | 2 | backend | 2 | pending |
| 8 | Route the marketing opt-out button into OptOut | 2 | backend | 3 | pending |
| 9 | Reply-text and button condition evaluators | 2 | backend | 3 | pending |
| 10 | Per-node funnel aggregation endpoint | 2 | backend | 4 | pending |
| 11 | Send-policy admin UI | 3 | ui | 7 | pending |
| 12 | Reply/button condition config UI + validation | 3 | ui | 9 | pending |
| 13 | Funnel badges on the flow canvas | 3 | ui | 10 | pending |

## Execution phases

- **Phase 1 (parallel):** task-1, task-2, task-3, task-4
- **Phase 2 (parallel):** task-5, task-6, task-7, task-8, task-9, task-10
- **Phase 3 (parallel):** task-11, task-12, task-13

## File-ownership boundaries

Stated in each task file so parallel agents do not collide:

- `lib/campaignEngine.js` is touched by tasks 2, 4, 7 and 9 in **different functions**.
  Tasks 2 and 7 both edit the **message-node block**, which is exactly why task 7
  depends on task 2. Task 4 edits only `walkEnrollment`'s outer wrapper; task 9 edits
  only the `evaluateCondition` family.
- `routes/wati.js` is touched by tasks 1, 3 and 8 in different regions: task 1 at the
  top of the handler, task 3 in the `MessageEvent.create` call, task 8 in the
  STOP-keyword block.

## Testing convention

There is no test framework. Each task ships its own standalone
`backend/node/tools/verify-*.js` in the same commit, following the existing pattern
(`verify-graph-walk.js`, `verify-webhook.js`, `verify-direct-send.js`,
`verify-preset-reuse.js`): connects to local Mongo, `check()`-based assertions,
`__verify_*__`-prefixed fixtures, cleans up after itself, non-zero exit on failure.

## End-to-end verification once the plan lands

Restart the backend (past sessions hit stale-process issues), then: connect WhatsApp →
copy the webhook URL with its secret into WATI → publish a two-message flow with a
button condition between them → enroll one allowlisted test number → confirm the first
message arrives in seconds, the button tap routes to the right branch, canvas badges
increment, a forged webhook POST without the secret 401s, turning the frequency cap on
defers a second campaign's send instead of failing it, and a deliberately broken
template parks the lead as retryable and then recovers via Retry all.
