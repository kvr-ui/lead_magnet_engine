---
task: 5
name: graph-walker
parallel_group: 2
depends_on: [2, 3]
issue: 6
---

# Task 5: Replace advanceEnrollment with a versioned graph walker

## What to build

This is the WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node`, Mongoose). Task 3 replaced the Campaign model's flat `steps[]` array with a versioned graph: a `draft` (nodes/edges being edited) plus a `versions[]` array of immutable published snapshots, each containing its own nodes/edges across nine node kinds. `CampaignEnrollment` now carries `currentNodeId` (String), `history[].nodeId`, and `graphVersion` (the version number the enrollment is walking). Task 2 collapsed the old two-layer source-resolution code into `lib/sourceResolver.js`, which exposes `resolveSource(sourceId, map) -> { find, findById, mapDoc }`, driven by a canonical field map, so any node that needs live data from a lead/contact/whatever source document goes through one resolver instead of duplicated per-source logic.

This task's job is to delete the old flat-array stepper and grow a graph walker in its place, so enrollments actually traverse the new node/edge structure end to end.

Replace `advanceEnrollment` (`backend/node/lib/campaignEngine.js`, roughly lines 249–308) with a graph walker built along these lines:

**Version pinning.** Load the campaign, then select the version from `versions[]` whose version number matches `enrollment.graphVersion`. Never walk `draft` — an enrollment walks the exact snapshot it entered on. This is what makes editing a live flow safe: a campaign designer can publish a new version (task 3/12 territory) while enrollments already in flight keep executing the graph they started on, unaffected. If `versions[]` has no entry matching `enrollment.graphVersion`, treat this the same as a missing node (see below) — park, don't crash.

**Dispatch on node kind.** Look up `enrollment.currentNodeId` in the pinned version's node list and switch on `node.kind`:

- **`filter` / `condition` / `split` / `goal`** — evaluate the node, follow the edge whose `branch` field matches the computed outcome, and CONTINUE walking in the same tick (do not return to the caller — keep looping so a chain of decision nodes resolves in one pass, exactly like a synchronous state machine step).
- **`message`** — send via `whatsappProvider`, resolving template params from the canonical field map by re-reading the *live* target document through `sourceResolver` (`resolveSource(...).findById(...)` or equivalent) rather than from a stale snapshot. This is the piece that finally fills in the `params` array that is hardcoded to `[]` today — walk the template's declared param list, map each to a canonical field key, and pull the current value off the freshly-read document. Append a history entry shaped `{ nodeId, templateId, sentAt, status, providerMessageId, providerLocalMessageId }`, preserving the existing snake_case/camelCase id-extraction behavior from the current code (WATI's response uses inconsistent casing depending on endpoint/version; keep whatever normalization logic already handles that). Then follow the node's single outgoing edge and END the tick — a message send is the one point where the walker yields control back to the poller, since it represents real-world side effects that shouldn't be bundled with further automatic progress.
- **`wait`** — compute `nextSendAt = now + amount/unit` from the node's config, then clamp the result into `config.window` (a `from`/`to` time-of-day pair interpreted in `config.tz`) and skip forward past any weekday listed in `config.skipDays`. END the tick (the poller picks the enrollment back up once `nextSendAt` arrives). Worked example to encode in tests/docs: an enrollment arms on a Friday at 23:10 with a 2-day wait; the window is 10:00–20:00 Asia/Kolkata; `skipDays` is `[0]` (Sunday). Friday 23:10 + 2 days lands on Sunday 23:10, which both falls outside the window and on a skipped day, so the resolved `nextSendAt` is Monday 10:00 (Asia/Kolkata).
- **`exit`** — set enrollment `status` to `"completed"` and record the node's configured outcome/reason on the enrollment or its history.

**Edge/graph edge cases:**
- A chosen branch that has no matching outgoing edge is treated as an implicit exit (complete the enrollment) rather than an error.
- A `currentNodeId` that does not exist in the pinned version parks the enrollment as `"paused"` with a clear, specific reason string (e.g. which node id was missing and which graph version was pinned) — this must never throw/crash the tick.
- **Per-tick hop limit** (e.g. 50 node visits per call to the walker): exceeding it parks the enrollment as `"failed"` with a clear error message identifying that the hop limit was hit. This is the deliberate runtime backstop against a cycle of filter/condition/split/goal nodes with no intervening `wait` node — there is intentionally no publish-time graph validation to prevent cycles, so the walker itself must be the safety net.
- **Kill-switch semantics must be preserved exactly as they exist today**: if sending throws an error carrying `sendingDisabled` (or `notAllowlisted`, added by task 4), the enrollment must be left completely untouched — no status change, no history append, no `currentNodeId` advance — and remain queued for the next poll. A closed gate must never cause an enrollment to be burned as failed; it should look, from the enrollment's perspective, like the tick simply didn't happen.

**Condition kinds.** A `condition` node's `config.on` selects one of four evaluation kinds. Implement all four (they belong to `condition` nodes; `split` and `goal` decide their branch by their own rules, which task 12 owns):
- `"field"` — re-read the target document live via `sourceResolver` and compare using the existing filter-shape/operator semantics already used elsewhere in the codebase (reuse, don't reinvent, the comparison logic).
- `"engagement"` — query `MessageEvent` for the delivery status (`delivered` / `read` / `replied` / `failed`) of a named upstream `message` node, identified by that node's `nodeId`.
- `"activity"` — use `lib/leadActivity.js` to roll up source activity rows recorded since the enrollment's last send.
- `"elapsed"` — days elapsed since the enrollment started, or since its last send, per the node's config.

**Dry-run mode.** Add a mode where the walker accepts an injected clock (so "now" is controllable) and a no-op sender (so no real provider call is ever made), and returns the sequence of visited nodes plus a description of what would have been sent at each `message` node it passed through. Dry-run must make ZERO calls to `whatsappProvider` or any other outbound side effect. Task 9 (not part of this task) builds its verification harness on top of this dry-run capability, so the injected clock/sender interface needs to be clean and reusable rather than a one-off internal hack.

**processDueEnrollments stays structurally the same.** Do not restructure the poller: keep `BATCH_SIZE`, `SEND_GAP_MS`, the existing poll interval, the `isSendingEnabled()` early return, and the existing behavior of skipping enrollments whose campaign is inactive. Only the per-enrollment advance logic (the old `advanceEnrollment`) is being replaced by the graph walker described above.

**Boundary — stubs, not implementations.** This task builds the walk loop, the edge-following mechanism, and the handlers for `source`, `filter`, `message`, `wait`, `condition` and `exit` only. The `split`, `goal` and `action` node kinds get clearly marked stubs: the walker must recognise the kind and park the enrollment with an explanatory reason (e.g. `"split node handling not yet implemented"`), never guess at an outcome, pick a default branch, or silently no-op. Task 12 replaces each stub with its real handler and is the sole owner of how those three kinds decide their branch — do not pre-empt that decision here, even with a placeholder heuristic. This task does not write the verification script (task 9) and does not write the enrollment migration script that backfills `graphVersion`/`currentNodeId` for pre-existing enrollments (task 6) — assume those fields are already populated correctly on the enrollments this walker reads.

## Acceptance criteria

- [ ] A linear graph (message → wait → message → exit, no branching) walks end to end across multiple ticks, producing the expected history and reaching `status: "completed"`.
- [ ] A `wait` node honours `window`, `tz`, and `skipDays`, including the worked example: armed Friday 23:10, 2-day wait, window 10:00–20:00 Asia/Kolkata, `skipDays: [0]`, resolves to `nextSendAt` = Monday 10:00 Asia/Kolkata.
- [ ] Each of the four condition kinds (`field`, `engagement`, `activity`, `elapsed`) branches correctly to the edge matching its computed outcome.
- [ ] `filter`/`condition`/`split`/`goal` nodes chain within a single tick (no unnecessary yield back to the poller between them); a `message` node ends the tick after sending.
- [ ] A cycle of decision nodes with no `wait` node trips the per-tick hop limit and parks the enrollment as `"failed"` with an explanatory error, rather than looping forever or crashing.
- [ ] Dry-run mode (injected clock + no-op sender) makes zero provider calls and returns the visited node sequence plus what would have been sent.
- [ ] When `isSendingEnabled()`/allowlist checks throw `sendingDisabled` or `notAllowlisted`, the enrollment is left completely unmodified and remains queued — no status change, no history append.
- [ ] An enrollment pinned to `graphVersion: 1` keeps walking version 1's nodes/edges even after version 2 is published to the same campaign.
- [ ] `message` node template params render using values pulled from the canonical field map via a live `sourceResolver` read, not an empty/hardcoded array.
- [ ] A `currentNodeId` missing from the pinned version parks the enrollment as `"paused"` with a clear reason instead of throwing.
- [ ] A chosen branch with no outgoing edge completes the enrollment instead of erroring.
- [ ] `split`, `goal`, and `action` node kinds hit clearly marked stubs that park the enrollment with an explanatory reason, not silent no-ops or guessed behavior.
- [ ] `processDueEnrollments`'s existing `BATCH_SIZE`, `SEND_GAP_MS`, poll interval, `isSendingEnabled()` early return, and inactive-campaign skip behavior are unchanged.

## Commit convention

Your commit message MUST include `Closes #6` so the task's GitHub issue closes when the commit lands on the default branch.
