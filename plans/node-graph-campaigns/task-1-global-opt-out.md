---
task: 1
name: global-opt-out
parallel_group: 1
depends_on: []
issue: 2
---

# Task 1: Global WhatsApp opt-out (STOP keyword handling)

## What to build

This is a WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node` using Mongoose, React 19 + Vite frontend at `frontend/admin-ui`, WATI as the WhatsApp provider). Right now there is zero opt-out handling anywhere in the system. The inbound webhook at `backend/node/routes/wati.js` already classifies inbound replies (its `normalizeStatus` helper returns `"received"` when `body.owner === false`), but the signal is simply discarded — nothing checks whether the inbound message was a STOP request, and nothing stops future sends to that phone. With roughly 5,982 leads currently queued to auto-enroll into campaigns, sending WhatsApp template messages to people who have already asked to stop risks WhatsApp's template-limit throttling and can get the business's WhatsApp number flagged or banned. This task has no dependencies on the other tasks in this plan specifically so that it lands in the first parallel wave and opt-out protection exists as early as possible.

Build the following:

1. **New model `backend/node/models/OptOut.js`.** Fields: `phone` (string, required, unique index), `source` (string enum: `"inbound-keyword"` or `"manual"`), `keyword` (string, optional — the literal keyword text that triggered the opt-out, when applicable). Include Mongoose timestamps (`createdAt`/`updatedAt`).

2. **Webhook STOP detection in `backend/node/routes/wati.js`.** In the `POST /wati/webhook` handler (roughly lines 197–240 today), when the event is inbound and `extractText(body)` matches a STOP keyword, upsert an `OptOut` document for that phone and cancel that phone's active enrollments. Matching rules:
   - Case-insensitive, trimmed, whole-message match (not a substring match) against: `STOP`, `UNSUBSCRIBE`, `UNSUB`, `OPTOUT`, `OPT OUT`, `CANCEL`, `QUIT`, `END`, and the Hindi keywords `बंद` and `रोको`.
   - A message like "stop by tomorrow" must NOT match — only an inbound message whose entire (trimmed) content equals one of the keywords, case-insensitively, counts as an opt-out.
   - On a match: upsert an `OptOut` row for the phone (`source: "inbound-keyword"`, `keyword` set to the matched text), then run `CampaignEnrollment.updateMany({ phone, status: "active" }, { status: "cancelled" })`. This must apply across every campaign the phone is enrolled in, not just whichever campaign the inbound message happens to be associated with — opt-out is a global, per-phone concern, not a per-campaign one.
   - The webhook must still respond 200 to WATI regardless of whether a STOP keyword was matched, and regardless of any error in the opt-out/cancellation logic — a non-2xx response just causes WATI to retry delivery, so opt-out processing failures must not block the ack. Wrap the opt-out handling so it cannot throw past the response.
   - Non-STOP inbound replies must continue to be classified and handled exactly as before (e.g. still recorded as `replied`/`received`) — this change only adds new behavior on top of the existing classification, it does not change how ordinary replies are processed.

3. **Exclude opted-out phones from targeting in `backend/node/lib/campaignEngine.js`.** In the `matchTargets` function (around line 118), add a check against the `OptOut` collection that runs *before* the existing already-enrolled check, so opted-out phones are filtered out earlier in the pipeline. The counts object this function returns (used by the campaign preview UI) must include a new `skippedOptedOut` count reflecting how many candidate phones were excluded specifically because they were opted out. This guarantees `enrollTargets` (or whatever downstream function actually creates enrollments) never re-enrolls a phone that is present in `OptOut`.

4. **New opt-out management routes** (exact file location for these routes should follow the existing route-file conventions in `backend/node/routes/`):
   - `GET /api/opt-outs` — paginated list of opt-outs.
   - `POST /api/opt-outs` with body `{ phone }` — manually add an opt-out (`source: "manual"`).
   - `DELETE /api/opt-outs/:id` — remove an opt-out (re-permit a phone).

**Design note (state this reasoning in the delivered code/comments where relevant):** opt-out is deliberately implemented as a global, always-on mechanism enforced in the webhook and in `matchTargets`, and is NOT modeled as a node type on the campaign flow canvas. If opt-out were just another node a campaign designer could place, a flow where someone forgot to wire in a STOP-handling node would keep messaging people who explicitly asked to stop. Making it global and independent of any particular campaign graph is the whole point.

**Boundary — do not touch:** the campaign graph/node schema (covered by a separate task in this plan) and the graph walker/executor (also a separate task). Do not modify any outbound message-sending code paths in this task; this task is only about detecting STOP replies, recording them, and filtering targets before enrollment.

## Acceptance criteria

- [ ] `backend/node/models/OptOut.js` exists with `phone` (unique index), `source` (`"inbound-keyword"` | `"manual"`), `keyword`, and timestamps.
- [ ] An inbound WATI webhook message whose trimmed body case-insensitively equals a STOP keyword (including `बंद` and `रोको`) creates/upserts an `OptOut` row for that phone.
- [ ] That same event sets `status: "cancelled"` on all of that phone's `CampaignEnrollment` documents that were `status: "active"`, across every campaign, not just one.
- [ ] The webhook endpoint returns HTTP 200 to WATI in all cases — matched STOP, unmatched message, and even if opt-out processing internally errors.
- [ ] An inbound message that merely contains a keyword as a substring (e.g. "stop by tomorrow") does NOT create an opt-out and does NOT cancel enrollments.
- [ ] Ordinary non-STOP inbound replies are unaffected — they still get classified/recorded as `replied`/`received` exactly as before this change.
- [ ] `matchTargets` in `campaignEngine.js` excludes any phone present in `OptOut` from the candidate target list, checked before the already-enrolled check, and never appears in what `enrollTargets` enrolls.
- [ ] `matchTargets`'s returned counts include `skippedOptedOut`, reflecting the number of candidates excluded for being opted out, so the campaign preview UI can surface it.
- [ ] `GET /api/opt-outs` returns a paginated list of opt-outs.
- [ ] `POST /api/opt-outs` with `{ phone }` creates a manual opt-out (`source: "manual"`) and subsequently blocks that phone from enrollment the same way an inbound-keyword opt-out does.
- [ ] `DELETE /api/opt-outs/:id` removes an opt-out record, after which the phone is eligible for enrollment again.

## Commit convention

Your commit message MUST include `Closes #2` so the task's GitHub issue closes when the commit lands on the default branch.
