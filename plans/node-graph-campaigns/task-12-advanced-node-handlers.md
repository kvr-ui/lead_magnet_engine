---
task: 12
name: advanced-node-handlers
parallel_group: 4
depends_on: [5, 9]
issue: 13
---

# Task 12: Implement the split, goal, and action node handlers

## What to build

This is the WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node`, Mongoose). Task 5 replaced `advanceEnrollment` with a graph walker (`backend/node/lib/campaignEngine.js`) that dispatches on `node.kind` and evaluates the four condition kinds (`field`, `engagement`, `activity`, `elapsed`) for `filter`/`condition` nodes. Task 5 deliberately left three node kinds as clearly-marked stubs rather than guessing at behavior: `split`, `goal`, and `action` each park the enrollment with an explanatory reason string (e.g. `"split node handling not yet implemented"`) instead of doing anything. Task 9 built `backend/node/tools/verify-graph-walk.js`, a harness that runs the walker in dry-run mode (injected clock, no-op sender) against constructed campaigns/enrollments and exits non-zero if any case's actual outcome doesn't match its expected outcome.

This task's job is to replace those three stubs with real handlers and extend the verify harness to exercise all three. Do not touch the core walk loop, the per-tick hop limit, or dry-run mode — those are task 5's territory and are done. Do not add canvas config panels for these node kinds — that is task 14.

**1. `split`** — config `{ ratio }` (per task 3's schema, `ratio` is the percentage, 0–100, that should take branch `"a"`; the remainder takes `"b"`). The branch must be chosen by a **stable, deterministic hash of the enrollment's `targetId`**, never by `Math.random()` or any other non-deterministic source. Something as simple as a string hash (e.g. FNV-1a or a similar cheap accumulator) of `String(enrollment.targetId)` reduced `mod 100` and compared against `ratio` is sufficient — the specific algorithm doesn't matter, but it must be pure and depend only on `targetId`. This matters because a lead re-evaluated at a later node visit (or re-walked after a park/resume) must land on the same side every time; a lead who flips sides mid-flow would receive both variants of an A/B test and contaminate the result. Once the branch is computed, follow the outgoing edge whose `branch` is `"a"` or `"b"` exactly like the existing `condition`/`goal` edge-matching code path — reuse that matching logic rather than duplicating it.

**2. `goal`** — an activity-threshold node (config is `Mixed` per task 3; define and document the concrete shape you use here, e.g. `{ metric, threshold, windowHours }` or similar, consistent with what `lib/leadActivity.js` already models). Use `backend/node/lib/leadActivity.js` to roll up the connected source's activity rows — the per-row, timestamped engagement records configured on a `DataSourceConnection`'s `activity` config (collection/foreignField/timestampField, see `DataSourceConnection.js` around the `activity` subschema). Only count rows stamped **after the enrollment's last send** (i.e. `history[history.length - 1].sentAt`, or the enrollment's creation time if it has never sent) — this mirrors the attribution logic `leadActivity.js` already uses elsewhere (`fetchActivityRows`'s `since` cutoff, `creditFor`'s last-touch window), so prefer extending/reusing that module's helpers over reimplementing the query. If the rolled-up count/metric meets or exceeds the configured threshold, follow the `"yes"` edge to an exit that records a conversion outcome (reuse the `exit` node's existing "set status completed, record outcome/reason" behavior with an outcome value that clearly denotes a goal conversion, e.g. `"goal_met"`); otherwise follow `"no"`. If no activity source is configured at all (`leadActivity.getActivitySource()` returns null), treat this as a park-with-reason case rather than silently choosing a branch — a goal node with no attached activity source cannot honestly evaluate anything.

**3. `action`** — the only node kind in the entire system that writes anything (every other node kind reads or branches). Config is `{ url, method, body }` for an outbound HTTP call with canonical lead values interpolated into `url`/`body` (resolve interpolation the same way the `message` node resolves template params: re-read the live target document via `sourceResolver` and substitute canonical field values), or a source-field write-back shape (a field name plus a value/expression to write back to the source document via the source's connection) — per task 3's schema. Implement both. Non-negotiable requirements, all of which must be independently testable:
   - **Gated behind `isSendingEnabled()`** exactly like a real message send (`lib/sendingSwitch.js`, `sendingDisabledError()`). When sending is off, the action must not fire, and per the kill-switch semantics already established in task 5, the enrollment must be left completely untouched (no status change, no history append, no advance) and remain queued — same as a message send hitting a closed gate.
   - **Defaults to disabled** independent of the global kill switch — an `action` node needs its own explicit opt-in (e.g. a `config.enabled` flag, or equivalent) so that publishing a graph containing an action node never fires a write by accident; document and enforce whichever mechanism you choose.
   - **Has a request timeout** on the outbound HTTP call (and, for the source-database write-back path, whatever bounded-time equivalent applies to that connection) so a hung external endpoint or database cannot hang a poller tick indefinitely.
   - **Records its outcome on the enrollment history** — success or failure, with enough detail (status code / error message) to debug later, in the same `history[]` array shape the `message` node already appends to.
   - **A failure must NOT silently advance the lead to the next node.** On timeout, non-2xx response, or write-back error, park the enrollment (paused/failed, consistent with how the walker already parks on other error conditions) rather than following the outgoing edge as if the action succeeded.

**Verify harness.** Extend `backend/node/tools/verify-graph-walk.js` (built in task 9) with new cases:
- A `split` case with many synthetic enrollments (many distinct `targetId`s) at a configured `ratio`, asserting (a) each enrollment resolves to the same branch across repeated dry-run evaluations, and (b) the aggregate distribution across the set approximates the configured ratio within a reasonable tolerance.
- A `goal` case with fabricated activity rows both before and after the enrollment's last-send timestamp, asserting only the after-send rows count, and cases straddling the threshold boundary (just under → `"no"`, exactly at/over → `"yes"`).
- An `action` case covering: kill switch off → enrollment untouched; action node `enabled` defaulted/false → no fire, enrollment untouched or explicitly parked (whichever this task settles on — make the harness assert whatever the implementation actually contracts to); a slow/hanging endpoint → times out rather than hanging the harness, and the enrollment is left un-advanced; a successful call → outcome recorded on history and the edge is followed; a failing call (error status) → outcome recorded on history and the lead is NOT advanced to the next node.

The harness must still exit non-zero if any case (old or new) fails, per task 9's existing contract.

## Acceptance criteria

- [ ] The same enrollment (same `targetId`) always resolves to the same `split` branch across repeated dry-run evaluations — no `Math.random()` or other non-deterministic input feeds the branch decision.
- [ ] Across a large synthetic set of distinct `targetId`s, the aggregate `split` distribution approximates the configured `ratio` within a reasonable tolerance.
- [ ] The `goal` node counts only activity rows timestamped strictly after the enrollment's last send (or creation time if never sent), using `lib/leadActivity.js`'s rollup rather than a reimplemented query.
- [ ] The `goal` node branches to `"yes"` when the threshold is met/exceeded and `"no"` otherwise, correctly at the boundary value itself.
- [ ] A `goal` node evaluated with no activity source configured parks the enrollment with a clear reason instead of guessing a branch.
- [ ] Reaching `"yes"` on a `goal` node follows through to an exit that records a conversion outcome on the enrollment/history.
- [ ] The `action` node does nothing and leaves the enrollment completely untouched when `isSendingEnabled()` is false, matching the same kill-switch semantics as a message send.
- [ ] The `action` node does not fire unless explicitly enabled in its own config — an action node with no explicit opt-in never fires even when the global kill switch is on.
- [ ] The outbound HTTP call (and the source write-back path) has an enforced timeout; a hanging endpoint does not hang the poller tick.
- [ ] Both success and failure outcomes of an `action` node are recorded on the enrollment's `history[]`.
- [ ] A failed (or timed-out) `action` node does NOT advance the enrollment to the next node — the lead is parked rather than proceeding as if the write succeeded.
- [ ] `backend/node/tools/verify-graph-walk.js` includes passing cases for all three handlers described above, in addition to its existing task-9 cases, and still exits non-zero if any case fails.
- [ ] No changes were made to the walker's core loop structure, the per-tick hop limit, or dry-run mode's injected-clock/no-op-sender contract from task 5.
- [ ] No canvas/config-panel UI was added for `split`, `goal`, or `action` (deferred to task 14).

## Commit convention

Your commit message MUST include `Closes #13` so the task's GitHub issue closes when the commit lands on the default branch.
