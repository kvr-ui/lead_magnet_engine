---
task: 9
name: verify-graph-walk-harness
parallel_group: 3
depends_on: [5, 6]
issue: 10
---

# Task 9: Standalone verification script for the graph walker and migration

## What to build

This is the WhatsApp drip-campaign admin tool (Node/Express backend at `backend/node`, Mongoose). This repository has no test framework and no tests at all — adding one was explicitly discussed and declined. Verification instead follows the existing script pattern already established by `backend/node/tools/verify-webhook.js` and `backend/node/tools/verify-direct-send.js`: standalone Node scripts, run manually (or from a deploy gate) with `node tools/verify-whatever.js`, that connect straight to Mongo, seed throwaway data under an unmistakable `__verify_*__` name, exercise a real code path, assert invariants one at a time with a `check(name, pass, detail)` helper that prints `PASS`/`FAIL` per line, clean up everything they seeded in both the pass and fail path, print a final `N/M checks passed` summary, and `process.exit(1)` if anything failed. Match that pattern exactly — same connection style (`mongoose.connect` against the local dev Mongo URI), same `check()`/`results[]` bookkeeping, same top-level `(async () => { ... })().catch(...)` wrapper with cleanup, same non-zero exit on failure.

Task 5 built the graph walker (replacing `advanceEnrollment` in `backend/node/lib/campaignEngine.js`) with a dry-run mode: an injected clock (so "now" is controllable) and a no-op sender (so zero real provider calls are ever made), returning the sequence of visited nodes plus a description of what would have been sent at each `message` node passed through. Task 6 wrote the enrollment migration script that backfills `graphVersion`/`currentNodeId` on pre-existing enrollments, translating the old flat `steps[]`/`currentStepIndex` model into deterministic linear message-node chains (`currentStepIndex` maps to `currentNodeId` via 1-indexed node ids — old index 1 resolves to node `n2`).

Deliver `backend/node/tools/verify-graph-walk.js`. It does not modify the walker or the migration script — it drives them as black boxes and asserts on their outputs, the same way `verify-webhook.js` drives the live webhook endpoint rather than reimplementing its logic.

**Seed data.** Build one throwaway campaign (name prefixed `__verify_graph_walk__` or similar, cleaned up at the end either way) whose published version's graph is:

```
source -> message -> wait -> condition -> (branch A) -> ... -> exit
                                        -> (branch B) -> ... -> exit
```

i.e. a `source` node feeding a `message` node, then a `wait` node, then a `condition` node with two outgoing edges (branch `a` / branch `b`) that each eventually reach an `exit` node. Seed one lead/target document the graph's `source` node can resolve, and one `CampaignEnrollment` pinned to that campaign's graph version.

**Drive the walker in dry-run mode**, per task 5's contract: pass an injected clock and a no-op sender, make assertions against the returned visited-node sequence and the "what would have been sent" description — never against real sends. This script must make zero calls to `whatsappProvider` or any other outbound side effect from end to end; that is the whole point of building on dry-run mode rather than the live poller.

**Checks to assert and report individually (one `check()` call per invariant, not bundled):**

1. **Both condition branches** — run the walker twice against the same graph with inputs/clock state engineered so the condition resolves to branch `a` once and branch `b` once, and assert the visited-node sequence matches the expected node-id list for each branch exactly.
2. **Wait clamping into window/timezone/skipDays** — the concrete worked case from task 5: an enrollment armed Friday 23:10, a 2-day wait, window `10:00`–`20:00` in `Asia/Kolkata`, `skipDays: [0]` (Sunday). Friday 23:10 + 2 days lands on Sunday 23:10, which is both outside the window and on a skipped day, so the resolved `nextSendAt` must be Monday 10:00 Asia/Kolkata. Assert the walker's computed `nextSendAt` equals that exact instant.
3. **Per-tick hop limit trips on a cycle with no wait node** — construct a second, deliberate throwaway graph containing a cycle among `filter`/`condition`/`split`/`goal`-style decision nodes with no intervening `wait` node, run the walker against it, and assert that it parks the enrollment (does not loop forever, does not crash) rather than completing — per task 5, parked as `"failed"` with an explanatory hop-limit error, not silently stuck or thrown as an uncaught exception.
4. **Zero provider calls across the whole run** — instrument or wrap the no-op sender passed to the walker so it counts invocations that would have hit a real provider, and assert that count is zero across every scenario exercised above, including the hop-limit scenario.
5. **Version pinning survives a republish** — with an enrollment pinned to `graphVersion: 1`, publish a `graphVersion: 2` onto the same campaign (differing from version 1 in some observable way, e.g. a different node/edge), rerun the walker against the pinned enrollment, and assert it still walks version 1's nodes, not version 2's.
6. **Migration spot-check** — seed (or reuse task 6's migration function directly) a legacy-shaped enrollment with `currentStepIndex: 1`, run it through the migration, and assert the resulting `currentNodeId` is exactly `n2`, matching the deterministic linear-chain id scheme task 6 establishes.

**Cleanup.** Every campaign, enrollment, lead/target document, and any other row this script inserts must be deleted at the end, on both the pass and the fail path — mirror `verify-webhook.js`'s `wipe()`-then-`try`-equivalent shape (top-level `.catch()` plus an explicit cleanup call before the final exit) so a failed run never leaves the throwaway `__verify_graph_walk__` campaign or its enrollment sitting in the dev database.

**Exit behavior.** On any failed check, print which specific invariant broke (via the existing `check(name, pass, detail)` pattern — `detail` should name the expected vs. actual value) and `process.exit(1)`. On all-green, `process.exit(0)`.

**Boundary.** This task does not modify `backend/node/lib/campaignEngine.js` (the walker, task 5) or the migration script (task 6) — it exercises them exactly as written. It also does not attempt to cover the `split`, `goal`, or `action` node kinds' full behavior; task 5 leaves those as stubs and task 12 implements their real handlers. Task 12 will extend this harness with new cases for those kinds once they exist — this script's structure (seed helper, `check()` bookkeeping, cleanup routine) should be straightforward for that later task to extend rather than something it has to rewrite.

## Acceptance criteria

- [ ] `backend/node/tools/verify-graph-walk.js` exists, follows the `verify-webhook.js`/`verify-direct-send.js` pattern (Mongo connect, seed under a `__verify_*__` name, `check()`/`results[]`, final `N/M checks passed` summary, `process.exit(1)` on any failure).
- [ ] It seeds a throwaway campaign whose graph is `source -> message -> wait -> condition -> (two branches) -> exit`, plus one lead and one enrollment, and drives task 5's walker in dry-run mode with an injected clock and no-op sender.
- [ ] It asserts the visited-node sequence for both condition branches independently.
- [ ] It asserts the Friday-23:10 + 2-day-wait + Asia/Kolkata 10:00–20:00 window + `skipDays: [0]` case resolves `nextSendAt` to Monday 10:00 Asia/Kolkata exactly.
- [ ] It constructs a cycle with no wait node and asserts the per-tick hop limit parks the enrollment instead of looping or throwing uncaught.
- [ ] It asserts zero calls reached the injected sender/provider across the entire run, including the hop-limit scenario.
- [ ] It asserts an enrollment pinned to `graphVersion: 1` keeps walking version 1 after version 2 is published to the same campaign.
- [ ] It asserts a legacy enrollment with `currentStepIndex: 1` migrates to `currentNodeId: "n2"`.
- [ ] The script runs green (exit 0) against a correct walker and migration script.
- [ ] Deliberately breaking any single one of the above invariants makes the script fail loudly with a message naming which specific invariant broke, and still exits non-zero.
- [ ] All seeded data (campaign, enrollment, lead/target rows) is removed on both the pass path and the fail path — nothing named `__verify_graph_walk__` (or equivalent) is left in the database after a run either way.
- [ ] The script does not modify `campaignEngine.js` or the migration script; it only calls into them.

## Commit convention

Your commit message MUST include `Closes #10` so the task's GitHub issue closes when the commit lands on the default branch.
