---
task: 13
name: retire-admagnet
parallel_group: 4
depends_on: [2, 9]
issue: 14
---

# Task 13: Retire the hardcoded AdMagnetStudent source in favor of a generic DataSourceConnection

## What to build

`AdMagnetStudent` is the last hardcoded, code-level lead source left in the app. It exists to read the CA Guru lead-magnet database and was written before `DataSourceConnection` (URI + database + collection, plus an optional `enrich` join config that sums fields from a sibling collection) existed as a generic mechanism. Everything the bespoke code does by hand, `enrich` now does declaratively. This task deletes the special case and replaces it with an ordinary `DataSourceConnection` row, while preserving read access to historical data that was enrolled under the old `"AdMagnetStudent"` target model string.

1. **Seed/migration script — create the CA Guru `DataSourceConnection`.** Add an idempotent script (mirroring the style of task 6's migration script) that creates (or upserts, matched by a stable identifying field such as name/URI/collection) a `DataSourceConnection` row reproducing the bespoke behaviour:
   - `collection: "users"` (the live collection; `adMagnet.js` also referenced a legacy `"users123"` snapshot in its `MAPPED_COLLECTIONS` set at line 13, but only `"users"` was ever used by the campaign/messaging paths being preserved here — do not carry `MAPPED_COLLECTIONS` forward).
   - An `enrich` config that is the generic equivalent of the hardcoded `$lookup`/`$addFields` pipeline in `backend/node/routes/adMagnet.js` lines 102-112: join `mcqprogresses` on `userId` (`localField`/`foreignField` both `userId`), summing `totalAttempted` and `totalCorrect` from the joined docs into the same field names the old pipeline produced (`mcqAttempted`, `mcqCorrect` — check `enrichedCollection.js`'s existing `enrich` config shape from task 2/9 and match its field-naming convention exactly so downstream consumers see the same values as before).
   - This must run automatically as part of app startup or an explicit `npm run migrate`-style step already established by earlier tasks — not as a manual setup step an operator has to remember. Running it twice must be a no-op (no duplicate `DataSourceConnection` rows).

2. **Delete `backend/node/routes/adMagnet.js` entirely**, including the hardcoded `MAPPED_COLLECTIONS` set at line 13, the `/collections` and other ad-magnet-specific routes it defines, and its `getAdMagnetConnection` import. Remove its registration in `backend/node/index.js`:
   - line 41: `const adMagnetRouter = require("./routes/adMagnet");`
   - line 89: `app.use("/api/ad-magnet", requireAdminAuth, adMagnetRouter);`

3. **Delete the `AdMagnetStudent` adapter** from `backend/node/lib/campaignEngine.js` (the `AdMagnetStudent` entry in the `adapters` object, lines 53-62 of the current file, both its `find` and `findById` methods keyed off `adMagnetCollection()`), and delete its branch in `backend/node/lib/sourceData.js`'s `getSourceHandle` (the `if (source === "AdMagnetStudent") { ... }` block, lines 15-19 of the current file). Note task 2 (unified-source-resolver, a dependency of this task) will already have consolidated both of these into `backend/node/lib/sourceResolver.js`'s `resolveSource(sourceId, map)` — so in practice this step means deleting the `AdMagnetStudent` branch inside `resolveSource` itself (the equivalent logic after task 2 lands), not the pre-task-2 files verbatim. Confirm against the actual state of `sourceResolver.js` before deleting.

4. **Remove `"AdMagnetStudent"` from `STATIC_TARGET_MODELS`**:
   - `backend/node/models/Campaign.js` line 4: `const STATIC_TARGET_MODELS = ["Contact", "Lead", "AdMagnetStudent"];` → drop `"AdMagnetStudent"`.
   - `backend/node/models/CampaignEnrollment.js` line 4: same change.
   - This makes `"AdMagnetStudent"` an invalid `targetModel` for **new** campaigns/enrollments going forward (`isValidTargetModel` in both files rejects it, which is correct — new work must go through `datasource:<id>`).

5. **CRITICAL — preserve a compatibility alias for historical data.** Existing `CampaignEnrollment` rows may have `targetModel: "AdMagnetStudent"` from before this migration. These rows must not be orphaned — a lead's target document must still load in the UI (e.g. `GET /api/enrollments/:id` in `routes/messageEvents.js`, and any campaign member/preview listing that resolves a source by `targetModel`). Add a compatibility mapping inside `sourceResolver.js` (built in task 2) so that when `sourceId === "AdMagnetStudent"` is passed in, it resolves to the new `DataSourceConnection` created in step 1 (by its stable id or lookup key) instead of throwing/erroring — i.e. `resolveSource("AdMagnetStudent", map)` internally redirects to the same resolution path as `resolveSource("datasource:<the-ca-guru-connection-id>", map)`. This alias is the **only** place `"AdMagnetStudent"` may still appear in the codebase after this task; document it with a comment explaining why it exists and that it is a read-compatibility shim, not a valid new-campaign target (enforced separately by step 4's schema change).

6. **Clean up now-dead infra.** Once nothing references them (after steps 2, 3, and 5's redirect are all in place — the alias in `sourceResolver.js` should resolve through the generic `DataSourceConnection`/`dataSourcePool` path, not through `getAdMagnetConnection`), remove `getAdMagnetConnection` and the `AD_MAGNET_MONGODB_URI` connection handling from `backend/node/db.js` (currently lines ~18-40: `connectAdMagnetDB`, `getAdMagnetConnection`, and their export). Remove any leftover call to `connectAdMagnetDB()` at startup in `backend/node/index.js` if present. The app must boot cleanly with `AD_MAGNET_MONGODB_URI` unset or absent entirely.

**Boundary:** This task does not touch the graph walker or the canvas UI (those are owned by tasks 5/8/9 and later frontend tasks). It only retires the hardcoded source and its schema/registration footprint, and wires the one required compatibility alias.

## Acceptance criteria

- [ ] A seed/migration script creates a `DataSourceConnection` for CA Guru with `collection: "users"` and an `enrich` config joining `mcqprogresses` on `userId`, summing `totalAttempted`/`totalCorrect` — matching the field-naming convention used by `enrichedCollection.js`. The script runs automatically (startup or established `migrate` step), not as a manual one-off.
- [ ] Running the seed/migration script twice does not create duplicate `DataSourceConnection` rows (idempotent, matched by a stable key).
- [ ] `backend/node/routes/adMagnet.js` no longer exists, and `backend/node/index.js` has no reference to it (no import, no `app.use("/api/ad-magnet", ...)`).
- [ ] No `AdMagnetStudent`-specific branch remains in `sourceResolver.js` (or its pre-task-2 predecessors, if for any reason task 2 hasn't fully landed) other than the single documented compatibility alias described below.
- [ ] `"AdMagnetStudent"` is removed from `STATIC_TARGET_MODELS` in both `backend/node/models/Campaign.js` and `backend/node/models/CampaignEnrollment.js`; new campaigns/enrollments cannot be created with `targetModel: "AdMagnetStudent"`.
- [ ] A full-repo grep for `AdMagnetStudent` after the change returns matches only inside the documented compatibility alias in `sourceResolver.js` (plus comments explaining it) — no other file references the string.
- [ ] Existing `CampaignEnrollment` documents with `targetModel: "AdMagnetStudent"` still resolve their target document correctly end-to-end (e.g. `GET /api/enrollments/:id` returns the lead/target, not an error) by transparently redirecting through the alias to the new `DataSourceConnection`.
- [ ] CA Guru data is reachable through the generic data-source endpoints (`datasource:<id>`) and exposes the same enriched fields (`mcqAttempted`/`totalAttempted`, `mcqCorrect`/`totalCorrect` — whichever names the enrich config settles on) that the old hardcoded `$lookup` pipeline produced.
- [ ] `getAdMagnetConnection` and `AD_MAGNET_MONGODB_URI` handling are removed from `backend/node/db.js` once nothing else references them.
- [ ] The app boots cleanly (no crash, no unhandled connection error) with `AD_MAGNET_MONGODB_URI` unset or entirely absent from the environment.
- [ ] Neither the graph walker nor the canvas UI is modified by this task.

## Commit convention

Your commit message MUST include `Closes #14` so the task's GitHub issue closes when the commit lands on the default branch.
