---
task: 2
name: unified-source-resolver
parallel_group: 1
depends_on: []
issue: 3
---

# Task 2: Collapse the two source resolvers into one canonical `sourceResolver.js`

## What to build

Today the same "what is this source and how do I read it" concern is implemented twice, and a heuristic stands in for configuration that should exist on the connection itself:

- `backend/node/lib/campaignEngine.js` has a static `adapters` object (lines 38-63, covering `Contact` / `Lead` / `AdMagnetStudent`), a `dynamicAdapter` for `"datasource:<id>"` sources (lines 82-106), and `getAdapter` (lines 108-113) that dispatches between them.
- `backend/node/lib/sourceData.js` has `getSourceHandle` (lines 12-33) doing the same source-type switch independently, returning `{ kind: "model"|"collection", model|collection }`.
- The phone field is *guessed* rather than configured: `PHONE_FIELD_CANDIDATES` + `guessPhoneField` in `campaignEngine.js` (lines 69-77) is duplicated **verbatim** in `backend/node/lib/leadActivity.js` (lines 46-54), including the comment claiming it's shared logic when it is in fact copy-pasted.

Build one module, `backend/node/lib/sourceResolver.js`, exporting `resolveSource(sourceId, map)` that returns:

```
{ find(filter), findById(id), mapDoc(doc), kind, collection|model }
```

- `sourceId` is one of `"Contact"`, `"Lead"`, `"AdMagnetStudent"`, or `"datasource:<id>"` (the existing `DYNAMIC_PREFIX` convention from `lib/sourceFields.js`).
- `map` is a canonical field map, e.g. `{ phone: "phoneNumber", name: "firstName", stage: "caStatus" }`. This map is the keystone of the wider node-graph plan: every downstream consumer (message templates, condition nodes, filters) reads canonical keys only (`phone`, `name`, `stage`, ...), which is what lets a single Message node serve differently-shaped sources without per-node field wiring. This task only needs to thread the map through and apply it — the graph-side authoring of the map is task 3/graph-schema and later UI tasks.
- `mapDoc(doc)` applies the canonical map to a raw document and always yields at least `{ _id, phone }`, plus whichever other canonical keys `map` declares.
- When `map.phone` is absent, fall back to the existing candidate-name guess (`PHONE_FIELD_CANDIDATES` against the connection's `fieldsCache`, checked case-insensitively) for backward compatibility during migration — but that guess must live in exactly **one** place: inside `sourceResolver.js`. An explicit canonical map always takes precedence over the fallback guess when both could apply.
- Preserve the existing `enrich` wrapping: when a `datasource:<id>` connection has `doc.enrich` configured, wrap the raw collection with `wrapWithEnrichment` from `lib/enrichedCollection.js` exactly as both current implementations do, so enrich-derived virtual fields keep resolving through `find`/`findById`/`mapDoc`.
- Preserve the pooled connection lookup via `getConnectionFor` in `lib/dataSourcePool.js` — do not open new connections per call or change pooling/eviction behavior.
- Keep the `kind`-based return shape (`"model"` vs `"collection"`) so existing `kind`-dispatching call sites keep working without their own logic changes. `Contact`/`Lead` resolve to `kind: "model"` with a `.model` handle; `AdMagnetStudent` and `datasource:<id>` resolve to `kind: "collection"` with a `.collection` handle — matching what `sourceData.js`'s `getSourceHandle` returns today, so the routes that key off `kind` don't need to change their branching.

Then re-point every current caller at `resolveSource` instead of their own copy of this logic:

- `backend/node/lib/campaignEngine.js` — replace `adapters`, `dynamicAdapter`, and `getAdapter` with calls into `sourceResolver.js`. Every call site that currently does `await getAdapter(campaign.targetModel)` then `.find(...)` / `.findById(...)` keeps working with the same method names.
- `backend/node/lib/sourceData.js` — replace `getSourceHandle` with a thin call into `sourceResolver.js` that still returns `{ kind, model|collection }` for its existing callers.
- `backend/node/lib/leadActivity.js` — remove its own `PHONE_FIELD_CANDIDATES`/`guessPhoneField` copy (lines 46-54) and get the phone field via `sourceResolver.js` instead.
- `backend/node/routes/messageEvents.js` (around line 130, the `GET /api/enrollments/:id` handler that calls `getAdapter(enrollment.targetModel)` then `adapter.findById(enrollment.targetId)`) — switch to `resolveSource`.
- `backend/node/routes/campaigns.js` (`distinctValues` at line 45 and `listMembers` at line 79, both of which call `getSourceHandle` from `sourceData.js` and then branch on `handle.kind`) — keep using `sourceData.js`'s wrapper (which itself now delegates to `sourceResolver.js`), so these two functions need no behavioral changes, only to keep working against the now-shared implementation underneath.

Delete **both** copies of `guessPhoneField` / `PHONE_FIELD_CANDIDATES` (the one in `campaignEngine.js` and the one in `leadActivity.js`) once `sourceResolver.js` owns the single copy.

**Boundary — do not do this in task 2:**
- Do not delete the `AdMagnetStudent` source or `backend/node/routes/adMagnet.js` — that is task 13 (retire-admagnet), which depends on this task.
- Do not change the `Campaign` schema, add `draft`/`versions`, or touch node/graph shapes — that is task 3 (graph-schema).
- Do not build any UI for authoring the canonical `map` — later frontend tasks own that; this task only needs `resolveSource` to accept and apply a map that's passed in (or fall back to the guess when it's absent), so those tasks have something to call.

## Acceptance criteria

- [ ] `backend/node/lib/sourceResolver.js` exists and exports `resolveSource(sourceId, map)`, returning `{ find(filter), findById(id), mapDoc(doc), kind, collection|model }` for all four source kinds: `Contact`, `Lead`, `AdMagnetStudent`, and `datasource:<id>`.
- [ ] `mapDoc(doc)` always returns at least `{ _id, phone }`, applies every key in `map` when provided, and falls back to the candidate-name phone guess only when `map.phone` is absent.
- [ ] An explicit `map.phone` always takes precedence over the fallback guess — verified for a source where both a canonical map and a guessable field name are present.
- [ ] Neither copy of `guessPhoneField`/`PHONE_FIELD_CANDIDATES` remains anywhere in the codebase outside `sourceResolver.js` (confirm via a full-repo grep after the change).
- [ ] `campaignEngine.js`, `sourceData.js`, `leadActivity.js`, `routes/messageEvents.js`, and `routes/campaigns.js` all resolve sources through `sourceResolver.js` (directly or via `sourceData.js`'s thin wrapper) — no independent source-type switch statements remain in any of them.
- [ ] The existing preview-targets and enroll-targets flows in `campaignEngine.js` behave identically to before for all four source kinds (same matched targets, same phone cleaning behavior downstream).
- [ ] `GET /api/enrollments/:id` in `routes/messageEvents.js` still resolves the lead record (or reports `leadError`) identically to before.
- [ ] The `distinctValues` and `listMembers` functions in `routes/campaigns.js`, and the segment-members / filter-fields / filter-values endpoints that depend on them, behave identically to before for all source kinds, including `kind`-based branching.
- [ ] Enrich-derived virtual fields (from `doc.enrich` on a `datasource:<id>` connection) still resolve correctly through `find`, `findById`, and `mapDoc` after wrapping with `wrapWithEnrichment`.
- [ ] Connection pooling via `getConnectionFor` (`lib/dataSourcePool.js`) is preserved — no new connections opened per call, existing eviction behavior unchanged.
- [ ] `AdMagnetStudent` and `routes/adMagnet.js` are untouched (out of scope for this task); the `Campaign` schema is untouched (out of scope for this task).

## Commit convention

Your commit message MUST include `Closes #3` so the task's GitHub issue closes when the commit lands on the default branch.
