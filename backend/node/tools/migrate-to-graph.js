#!/usr/bin/env node
/**
 * ONE-TIME migration: flat `steps[]` campaigns -> versioned node/edge graphs.
 *
 * Run once, in place, against the live database, after models/Campaign.js and
 * models/CampaignEnrollment.js switched to the graph shape and before anything
 * else starts reading it:
 *
 *     node tools/migrate-to-graph.js --dry-run     # reads + prints, writes nothing
 *     node tools/migrate-to-graph.js               # the real thing
 *
 * Stop the campaign poller first. Every write here is guarded against a
 * concurrent change (see applyUpdate), so a running poller cannot corrupt an
 * enrollment — but it will make the migration report those rows as failures,
 * and a poller running mid-migration is reading a half-converted collection
 * anyway.
 *
 * WHAT IT DOES
 *
 * Per campaign, the old `targetModel` + `steps[]` become a straight line with
 * no branches — one source node, one message node per step, one exit node:
 *
 *     n0(source) -> n1(message) -> … -> nN(message) -> exit
 *
 * written as `versions[0]` (`version: 1`), pointed at by `liveVersion: 1`, and
 * copied into `draft` so the campaign opens in the canvas editor showing what
 * is actually live instead of a blank sheet. `autoEnroll` / `autoEnrollFilter`
 * keep their old meaning and their old values and are never written.
 *
 * Per enrollment, `currentStepIndex` becomes `currentNodeId` and every
 * `history[].stepIndex` becomes `history[].nodeId`. The index -> id rule is
 * `n{index + 1}` — offset by one because n0 is the source node, so the lead
 * that was sitting on step 1 waiting for its second message lands on `n2`, the
 * node representing the message it had NOT yet received. This is the whole
 * point of the migration: ~951 of these are `active` with a `nextSendAt`
 * already due, and they must resume mid-drip on the existing schedule. Nothing
 * touches `status`, `nextSendAt`, `phone`, `targetModel`, `targetId`, or any
 * history field other than that rename.
 *
 * WHY THE RAW DRIVER AND NOT THE MONGOOSE MODELS
 *
 * The models no longer declare `targetModel`, `steps`, `currentStepIndex` or
 * `history[].stepIndex`, so Mongoose (strict mode) would hand us documents with
 * exactly the fields this script needs to read stripped out. Every read and
 * every write here therefore goes through the raw collection handles. That also
 * means no Mongoose validator runs on our writes, so the structural checks the
 * schema would have applied (`graphIntegrityErrors` in models/Campaign.js:
 * unique node ids, no edge pointing at an unknown node) are re-implemented
 * below and run against every graph BEFORE it is written.
 *
 * SAFETY PROPERTIES, in rough order of how much they matter
 *
 *  - Idempotent. An already-migrated campaign (non-empty `versions` or a set
 *    `liveVersion`) and an already-migrated enrollment (`currentNodeId` +
 *    `graphVersion`, no legacy leftovers) are skipped and counted separately.
 *    A second full run changes zero documents. A run that finds a partially
 *    finished earlier run continues it: campaigns already done are read for
 *    their existing version-1 graph so their enrollments can still be migrated.
 *  - `--dry-run` writes nothing. Every write goes through one helper that
 *    returns early when dry, and on top of that the collection handles are
 *    wrapped in a proxy that throws if any write method is called at all.
 *  - Every write is guarded on the document's `updatedAt` being unchanged since
 *    we read it. If the poller advanced an enrollment underneath us, the update
 *    matches nothing, the document is left alone and it is reported as a
 *    failure rather than silently overwritten with our stale copy — clobbering
 *    a freshly appended history entry is how a lead gets a message twice.
 *    (Corollary: our own writes deliberately do NOT bump `updatedAt`.)
 *  - Nothing is skipped silently. Every campaign and every enrollment lands in
 *    exactly one of migrated / skipped / failed, each with a printed reason,
 *    and the process exits non-zero if anything failed.
 *
 * NOT this script's job: deleting the AdMagnetStudent source (it stays a valid
 * `sourceId` and migrates like any other `targetModel`), resolving sources,
 * populating `config.map` (no historical data to derive it from — a later admin
 * action fills it in), or changing how enrollments are advanced.
 */

const path = require("path");

// Same .env the server reads, resolved off __dirname so the script behaves the
// same whether it is run from backend/node or from the repo root.
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const { connectDB, mongoose } = require("../db");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// The version every migrated graph is published as, and therefore the version
// every migrated enrollment is pinned to. There is exactly one snapshot to
// create per campaign, so this is a constant rather than a computed max.
const MIGRATION_VERSION = 1;

// Terminal node id. Deliberately not of the form n{i} so it can never collide
// with the message-node sequence however many steps a campaign had.
const EXIT_NODE_ID = "exit";

// Canvas layout. There was never a canvas before, so any deterministic
// non-overlapping arrangement will do; a left-to-right line matches the shape.
const NODE_X_SPACING = 240;
const NODE_Y = 0;

// How many offending document ids to print per reason before summarising.
const MAX_IDS_PER_REASON = 10;

const COLLECTION_CAMPAIGNS = "campaigns";
const COLLECTION_ENROLLMENTS = "campaignenrollments";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const isNonEmptyObject = (v) => isPlainObject(v) && Object.keys(v).length > 0;

const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

// The id a 0-based old step index maps to. n0 is the source node, so step 0 —
// the first message — is n1.
const messageNodeId = (stepIndex) => `n${stepIndex + 1}`;

/**
 * Reasons are accumulated as counts plus a capped sample of document ids, so a
 * failure affecting 400 documents prints one line and ten ids rather than 400
 * lines, while a failure affecting three prints all three.
 */
function tally(map, reason, id) {
  let entry = map.get(reason);
  if (!entry) {
    entry = { count: 0, ids: [] };
    map.set(reason, entry);
  }
  entry.count += 1;
  if (id !== undefined && id !== null && entry.ids.length < MAX_IDS_PER_REASON) {
    entry.ids.push(String(id));
  }
  return entry;
}

function printTally(log, label, map, indent = "  ") {
  if (!map.size) return;
  log(`${indent}${label}:`);
  const rows = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [reason, entry] of rows) {
    const hidden = entry.count - entry.ids.length;
    const sample = entry.ids.length
      ? `  [${entry.ids.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}]`
      : "";
    log(`${indent}  ${String(entry.count).padStart(6)}  ${reason}${sample}`);
  }
}

/** "n1=812  n2=94  exit=45" — where the migrated leads ended up sitting. */
function formatNodeTally(map) {
  return [...map.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }))
    .map(([id, n]) => `${id}=${n}`)
    .join("  ");
}

// ---------------------------------------------------------------------------
// Dry-run enforcement
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set([
  "insertOne", "insertMany", "updateOne", "updateMany", "replaceOne",
  "deleteOne", "deleteMany", "bulkWrite", "findOneAndUpdate",
  "findOneAndReplace", "findOneAndDelete", "drop", "rename",
  "createIndex", "createIndexes", "dropIndex", "dropIndexes",
]);

/**
 * Belt and braces for --dry-run: the write helper already returns before
 * touching Mongo, and this makes any write that somehow gets past it a loud
 * crash instead of a silent mutation of production data.
 */
function readOnlyCollection(collection, name) {
  return new Proxy(collection, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && WRITE_METHODS.has(prop)) {
        return () => {
          throw new Error(`--dry-run: refused to call ${name}.${prop}() — this run must not write`);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ---------------------------------------------------------------------------
// Graph construction (pure)
// ---------------------------------------------------------------------------

/**
 * Structural checks mirroring models/Campaign.js's graphIntegrityErrors. Kept
 * as a local copy on purpose: this script writes with the raw driver, which
 * runs no Mongoose validator, and requiring the model here would register it on
 * the shared connection (and with it, index builds against production).
 */
function graphIntegrityErrors(nodes, edges) {
  const errors = [];
  const ids = new Set();
  const duplicates = new Set();

  for (const node of nodes) {
    if (!isNonEmptyString(node.id)) {
      errors.push("a node has no id");
      continue;
    }
    if (ids.has(node.id)) duplicates.add(node.id);
    ids.add(node.id);
  }
  if (duplicates.size) errors.push(`duplicate node id(s): ${[...duplicates].join(", ")}`);

  for (const edge of edges) {
    const label = edge.id || "(unnamed)";
    if (!ids.has(edge.from)) errors.push(`edge "${label}" starts at unknown node "${edge.from}"`);
    if (!ids.has(edge.to)) errors.push(`edge "${label}" points at unknown node "${edge.to}"`);
  }

  return errors;
}

/**
 * Build the linear graph for one legacy campaign document.
 *
 * Returns { nodes, edges } for `steps.length + 2` nodes and `steps.length + 1`
 * edges. Values lifted off the campaign (`autoEnrollFilter`, each step's
 * `providerMeta`) are carried by reference, never cloned: they are Mixed BSON
 * and may hold ObjectIds or Dates that a structural clone would flatten into
 * plain objects. The same node/edge arrays are stored in both `draft` and
 * `versions[0]`, which is exactly what "the draft shows what is live" means.
 */
function buildGraph(campaign) {
  const steps = Array.isArray(campaign.steps) ? campaign.steps : [];
  const nodes = [];
  const edges = [];

  const position = (column) => ({ x: column * NODE_X_SPACING, y: NODE_Y });

  // n0 — where the leads came from. `map` is intentionally empty: the old flat
  // model had no canonical field map to carry over, and inventing one here
  // would be a guess at which source field held the phone number.
  nodes.push({
    id: "n0",
    kind: "source",
    label: String(campaign.targetModel),
    position: position(0),
    config: {
      sourceId: campaign.targetModel,
      filter: isNonEmptyObject(campaign.autoEnrollFilter) ? campaign.autoEnrollFilter : {},
      map: {},
    },
  });

  // n1..nN — one per old step, in order. `params` starts empty: flat steps had
  // no per-recipient variable slots to migrate.
  steps.forEach((step, index) => {
    nodes.push({
      id: messageNodeId(index),
      kind: "message",
      label: `Step ${index + 1}`,
      position: position(index + 1),
      config: {
        templateId: step.templateId,
        providerMeta: isPlainObject(step.providerMeta) ? step.providerMeta : {},
        params: [],
      },
    });
  });

  nodes.push({
    id: EXIT_NODE_ID,
    kind: "exit",
    label: "Done",
    position: position(steps.length + 1),
    config: { outcome: "completed" },
  });

  // One edge per hop, no branches — a flat sequence is all the old shape could
  // express, so inventing anything else would be inventing behaviour.
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const from = nodes[i].id;
    const to = nodes[i + 1].id;
    edges.push({ id: `e-${from}-${to}`, from, to });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Campaign planning (pure)
// ---------------------------------------------------------------------------

/** The version-1 snapshot of an already-migrated campaign, or null. */
function publishedVersionOne(campaign) {
  const versions = Array.isArray(campaign.versions) ? campaign.versions : [];
  return versions.find((entry) => entry && entry.version === MIGRATION_VERSION) || null;
}

/**
 * Decide what to do with one campaign document. Returns
 *   { action: "migrate" | "skip" | "fail", reason, graph, update }
 * where `graph` is the graph its enrollments should be resolved against —
 * freshly built when migrating, read back out of versions[1] when skipping —
 * or null when there is no usable graph.
 */
function planCampaign(campaign, now) {
  const versions = Array.isArray(campaign.versions) ? campaign.versions : [];
  const hasLiveVersion = campaign.liveVersion !== null && campaign.liveVersion !== undefined;

  // --- already migrated? ---------------------------------------------------
  if (versions.length > 0 || hasLiveVersion) {
    const existing = publishedVersionOne(campaign);
    return {
      action: "skip",
      reason: `already migrated (versions: ${versions.length}, liveVersion: ${campaign.liveVersion ?? "unset"})`,
      graph: existing ? { nodes: existing.nodes || [], edges: existing.edges || [] } : null,
      graphNote: existing ? null : `has no version ${MIGRATION_VERSION} snapshot`,
      update: null,
    };
  }

  // Never had a steps[] field at all: not a legacy campaign, so there is
  // nothing to convert and publishing a graph for it would publish a flow no
  // admin ever wrote.
  if (!hasOwn(campaign, "steps")) {
    return {
      action: "skip",
      reason: "no legacy steps[] field and no published version — nothing to migrate",
      graph: null,
      update: null,
    };
  }

  // --- refuse to migrate a campaign we would have to guess about -----------
  if (!isNonEmptyString(campaign.targetModel)) {
    return {
      action: "fail",
      reason: `cannot build a source node: targetModel is ${JSON.stringify(campaign.targetModel)}`,
      graph: null,
      update: null,
    };
  }

  const steps = Array.isArray(campaign.steps) ? campaign.steps : [];
  if (!Array.isArray(campaign.steps)) {
    return {
      action: "fail",
      reason: `steps is not an array (${typeof campaign.steps})`,
      graph: null,
      update: null,
    };
  }
  for (let i = 0; i < steps.length; i += 1) {
    if (!isPlainObject(steps[i]) || !isNonEmptyString(steps[i].templateId)) {
      return {
        action: "fail",
        reason: `steps[${i}] has no templateId — a message node without one cannot send`,
        graph: null,
        update: null,
      };
    }
  }

  const { nodes, edges } = buildGraph(campaign);

  // These two should be unfailable given the loop above; they are asserted
  // anyway because the whole contract downstream (enrollment node ids, the
  // walker, the canvas) is "N + 2 nodes, N + 1 edges, chained".
  if (nodes.length !== steps.length + 2 || edges.length !== steps.length + 1) {
    return {
      action: "fail",
      reason: `built graph has ${nodes.length} nodes / ${edges.length} edges, expected ${steps.length + 2} / ${steps.length + 1}`,
      graph: null,
      update: null,
    };
  }
  const errors = graphIntegrityErrors(nodes, edges);
  if (errors.length) {
    return { action: "fail", reason: `built graph is invalid: ${errors.join("; ")}`, graph: null, update: null };
  }

  // publishedAt is the campaign's own updatedAt where it has one, so the
  // publish history reads as "this is the flow as it last stood" rather than
  // "everything was published the minute the migration ran".
  const publishedAt = campaign.updatedAt instanceof Date ? campaign.updatedAt : now;

  return {
    action: "migrate",
    reason: `${steps.length} step(s) -> ${nodes.length} nodes / ${edges.length} edges`,
    graph: { nodes, edges },
    update: {
      $set: {
        draft: { nodes, edges },
        versions: [{ version: MIGRATION_VERSION, nodes, edges, publishedAt }],
        liveVersion: MIGRATION_VERSION,
      },
      // The graph replaces these two outright; they are recoverable from
      // versions[0] (n0.config.sourceId is the old targetModel, the message
      // nodes are the old steps in order) if this ever has to be reversed.
      // autoEnroll / autoEnrollFilter are NOT touched — they keep their old
      // meaning and are still read as-is.
      $unset: { steps: "", targetModel: "" },
    },
  };
}

// ---------------------------------------------------------------------------
// Enrollment planning (pure)
// ---------------------------------------------------------------------------

/**
 * Decide what to do with one enrollment document, given its campaign's graph.
 *
 * `graph` is { nodeIds: Set<string> } or null when the campaign has no usable
 * version-1 snapshot. Returns
 *   { action: "migrate" | "skip" | "fail", reason, update, stats }.
 */
function planEnrollment(enrollment, graph) {
  const hasNodeId = isNonEmptyString(enrollment.currentNodeId);
  const hasVersion = Number.isFinite(enrollment.graphVersion);
  const legacyIndexPresent = hasOwn(enrollment, "currentStepIndex");
  const history = Array.isArray(enrollment.history) ? enrollment.history : [];
  const legacyHistoryPresent = history.some((entry) => isPlainObject(entry) && hasOwn(entry, "stepIndex"));

  // Already migrated, with nothing legacy left behind. Checking the leftovers
  // too means a half-finished write by some other tool gets repaired rather
  // than mistaken for a finished one; our own writes clear both, so a second
  // run of this script skips here.
  if (hasNodeId && hasVersion && !legacyIndexPresent && !legacyHistoryPresent) {
    return { action: "skip", reason: "already migrated (currentNodeId + graphVersion set)", update: null };
  }

  if (!graph || !graph.nodeIds || graph.nodeIds.size === 0) {
    return {
      action: "fail",
      reason: "campaign has no migrated graph to resolve node ids against",
      update: null,
    };
  }

  // An enrollment pinned to a version other than 1 cannot have come from the
  // old flat model, so its currentNodeId is authoritative and we have not
  // loaded its version's graph to check against. Only relabel its history.
  const pinnedElsewhere = hasVersion && enrollment.graphVersion !== MIGRATION_VERSION;
  if (pinnedElsewhere && !hasNodeId) {
    return {
      action: "fail",
      reason: `graphVersion ${enrollment.graphVersion} but no currentNodeId — cannot tell which node it sits on`,
      update: null,
    };
  }

  // --- currentStepIndex -> currentNodeId -----------------------------------
  let currentNodeId;
  if (hasNodeId) {
    currentNodeId = enrollment.currentNodeId;
    if (!pinnedElsewhere && !graph.nodeIds.has(currentNodeId)) {
      return {
        action: "fail",
        reason: `existing currentNodeId "${currentNodeId}" is not a node of the campaign's version ${MIGRATION_VERSION} graph`,
        update: null,
      };
    }
  } else {
    const index = enrollment.currentStepIndex;
    if (!Number.isInteger(index) || index < 0) {
      return {
        action: "fail",
        reason: `currentStepIndex is ${JSON.stringify(index)} — cannot derive a node id from it`,
        update: null,
      };
    }
    // The old index named the step ABOUT to be sent (campaignEngine only
    // incremented it when there was a next step), so n{index + 1} is the
    // message this lead has not received yet — that is what it must resume on.
    // An index at or past the end of the old steps[] means the lead had run out
    // of sequence, which is the exit node.
    const candidate = messageNodeId(index);
    currentNodeId = graph.nodeIds.has(candidate) ? candidate : EXIT_NODE_ID;
    if (!graph.nodeIds.has(currentNodeId)) {
      return {
        action: "fail",
        reason: `neither "${candidate}" nor the exit node exists in the campaign's graph`,
        update: null,
      };
    }
  }

  // --- history[].stepIndex -> history[].nodeId -----------------------------
  // A pure relabel of what was already sent, not a re-derivation: entry i keeps
  // its own recorded index, mapped through the same +1 offset.
  let historyChanged = false;
  let relabelled = 0;
  let dangling = 0;
  const newHistory = [];
  for (let i = 0; i < history.length; i += 1) {
    const entry = history[i];
    if (!isPlainObject(entry)) {
      return { action: "fail", reason: `history[${i}] is not an object`, update: null };
    }
    if (hasOwn(entry, "stepIndex")) {
      const index = entry.stepIndex;
      if (!Number.isInteger(index) || index < 0) {
        return {
          action: "fail",
          reason: `history[${i}].stepIndex is ${JSON.stringify(index)} — cannot derive a node id from it`,
          update: null,
        };
      }
      // Rebuilt rather than patched so the old key is dropped instead of
      // sitting alongside the new one; every other field is carried across
      // untouched, by reference, including any the schema never declared.
      const { stepIndex, nodeId, ...rest } = entry;
      const newEntry = { nodeId: messageNodeId(index), ...rest };
      if (!graph.nodeIds.has(newEntry.nodeId)) dangling += 1;
      newHistory.push(newEntry);
      historyChanged = true;
      relabelled += 1;
    } else if (isNonEmptyString(entry.nodeId)) {
      if (!graph.nodeIds.has(entry.nodeId)) dangling += 1;
      newHistory.push(entry);
    } else {
      return {
        action: "fail",
        reason: `history[${i}] has neither a stepIndex nor a nodeId`,
        update: null,
      };
    }
  }

  // --- the update itself ---------------------------------------------------
  // Only fields that actually differ are written, so a repair run touches the
  // minimum and a document that is already correct produces no update at all.
  const $set = {};
  const $unset = {};
  if (enrollment.currentNodeId !== currentNodeId) $set.currentNodeId = currentNodeId;
  if (!hasVersion) $set.graphVersion = MIGRATION_VERSION;
  if (historyChanged) $set.history = newHistory;
  if (legacyIndexPresent) $unset.currentStepIndex = "";

  if (!Object.keys($set).length && !Object.keys($unset).length) {
    return { action: "skip", reason: "already migrated (nothing left to change)", update: null };
  }

  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;

  return {
    action: "migrate",
    reason: `currentNodeId -> ${currentNodeId}`,
    update,
    stats: { currentNodeId, relabelled, dangling },
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The single point where anything is written.
 *
 * Guarded on `updatedAt` so a document the poller advanced between our read and
 * our write is left exactly as the poller left it. Note this writes with the
 * raw driver, so `updatedAt` is NOT bumped by the migration itself — that keeps
 * the guard meaningful across a re-run and keeps the field honest about when
 * the campaign/enrollment last actually changed.
 */
async function applyUpdate(collection, doc, update, dryRun) {
  if (dryRun) return { ok: true, dryRun: true, modified: 0 };

  const filter = { _id: doc._id };
  if (doc.updatedAt instanceof Date) filter.updatedAt = doc.updatedAt;

  const result = await collection.updateOne(filter, update);
  if (result.matchedCount !== 1) {
    return { ok: false, reason: "document changed between read and write (concurrent update) — left untouched", modified: 0 };
  }
  return { ok: true, modified: result.modifiedCount || 0 };
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

function emptyCounts() {
  return {
    found: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    modified: 0,
    noop: 0,
    skipReasons: new Map(),
    failReasons: new Map(),
  };
}

/**
 * @param db      a raw driver Db handle (mongoose.connection.db)
 * @param options { dryRun, log, now }
 * @returns the summary object that was printed
 */
async function migrate(db, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const log = options.log || console.log;
  const now = options.now instanceof Date ? options.now : new Date();

  const wrap = (name) => {
    const collection = db.collection(name);
    return dryRun ? readOnlyCollection(collection, name) : collection;
  };
  const campaignsCol = wrap(COLLECTION_CAMPAIGNS);
  const enrollmentsCol = wrap(COLLECTION_ENROLLMENTS);

  const summary = {
    dryRun,
    startedAt: now,
    campaigns: emptyCounts(),
    enrollments: emptyCounts(),
    enrollmentsInCollection: 0,
    activeMigrated: 0,
    historyEntriesRelabelled: 0,
    danglingHistoryNodes: 0,
    nodeTally: new Map(),
  };

  log("");
  log("=".repeat(72));
  log(`  steps[] -> graph migration   ${dryRun ? "*** DRY RUN — NOTHING WILL BE WRITTEN ***" : "*** REAL RUN — WRITES ENABLED ***"}`);
  log(`  started ${now.toISOString()}`);
  log("=".repeat(72));
  log("");

  const campaignDocs = await campaignsCol.find({}).toArray();
  summary.campaigns.found = campaignDocs.length;
  summary.enrollmentsInCollection = await enrollmentsCol.countDocuments({});
  log(`campaigns found:   ${campaignDocs.length}`);
  log(`enrollments found: ${summary.enrollmentsInCollection}`);
  log("");

  const knownCampaignIds = [];

  for (let i = 0; i < campaignDocs.length; i += 1) {
    const campaign = campaignDocs[i];
    knownCampaignIds.push(campaign._id);

    const header = `[${i + 1}/${campaignDocs.length}] "${campaign.name}" (${campaign._id})`;
    const plan = planCampaign(campaign, now);
    let graph = plan.graph;

    if (plan.action === "migrate") {
      const written = await applyUpdate(campaignsCol, campaign, plan.update, dryRun);
      if (written.ok) {
        summary.campaigns.migrated += 1;
        summary.campaigns.modified += written.modified;
        if (!dryRun && written.modified === 0) summary.campaigns.noop += 1;
        log(`${header}`);
        log(`    MIGRATE   source "${campaign.targetModel}", ${plan.reason}, published as version ${MIGRATION_VERSION}`);
      } else {
        summary.campaigns.failed += 1;
        tally(summary.campaigns.failReasons, written.reason, campaign._id);
        graph = null;
        log(`${header}`);
        log(`    FAILED    ${written.reason}`);
      }
    } else if (plan.action === "skip") {
      summary.campaigns.skipped += 1;
      tally(summary.campaigns.skipReasons, plan.reason, campaign._id);
      log(`${header}`);
      log(`    SKIP      ${plan.reason}${plan.graphNote ? ` — ${plan.graphNote}` : ""}`);
    } else {
      summary.campaigns.failed += 1;
      tally(summary.campaigns.failReasons, plan.reason, campaign._id);
      log(`${header}`);
      log(`    FAILED    ${plan.reason}`);
    }

    const graphInfo = graph ? { nodeIds: new Set(graph.nodes.map((n) => n.id)) } : null;
    const perCampaign = await migrateEnrollmentsOf(
      enrollmentsCol,
      { campaign: campaign._id },
      graphInfo,
      dryRun,
      summary
    );
    log(
      `    enrollments  ${perCampaign.found} found | ${perCampaign.migrated} migrated | ` +
        `${perCampaign.skipped} skipped | ${perCampaign.failed} failed` +
        (perCampaign.nodes.size ? `  (resumed at ${formatNodeTally(perCampaign.nodes)})` : "")
    );
    for (const [reason, entry] of perCampaign.failReasons) {
      log(`      ! ${entry.count} × ${reason}`);
    }
  }

  // Enrollments whose campaign no longer exists: they have no graph and no
  // owner, so they are reported rather than guessed at.
  log("");
  const orphans = await migrateEnrollmentsOf(
    enrollmentsCol,
    { campaign: { $nin: knownCampaignIds } },
    null,
    dryRun,
    summary,
    "campaign document not found"
  );
  if (orphans.found) {
    log(`orphaned enrollments (campaign missing): ${orphans.found} — ${orphans.skipped} skipped, ${orphans.failed} failed`);
  } else {
    log("orphaned enrollments (campaign missing): 0");
  }

  printSummary(log, summary);
  return summary;
}

/**
 * Migrate every enrollment matching `filter`, folding the result into both a
 * per-campaign tally (returned) and the run-wide summary (mutated).
 */
async function migrateEnrollmentsOf(collection, filter, graphInfo, dryRun, summary, forcedFailReason) {
  const local = {
    found: 0,
    migrated: 0,
    skipped: 0,
    failed: 0,
    nodes: new Map(),
    failReasons: new Map(),
  };

  const cursor = collection.find(filter);
  for await (const enrollment of cursor) {
    local.found += 1;
    summary.enrollments.found += 1;

    const plan = planEnrollment(enrollment, graphInfo);
    const reason = plan.action === "fail" && forcedFailReason ? forcedFailReason : plan.reason;

    if (plan.action === "skip") {
      local.skipped += 1;
      summary.enrollments.skipped += 1;
      tally(summary.enrollments.skipReasons, reason, enrollment._id);
      continue;
    }
    if (plan.action === "fail") {
      local.failed += 1;
      summary.enrollments.failed += 1;
      tally(local.failReasons, reason, enrollment._id);
      tally(summary.enrollments.failReasons, reason, enrollment._id);
      continue;
    }

    const written = await applyUpdate(collection, enrollment, plan.update, dryRun);
    if (!written.ok) {
      local.failed += 1;
      summary.enrollments.failed += 1;
      tally(local.failReasons, written.reason, enrollment._id);
      tally(summary.enrollments.failReasons, written.reason, enrollment._id);
      continue;
    }

    local.migrated += 1;
    summary.enrollments.migrated += 1;
    summary.enrollments.modified += written.modified;
    if (!dryRun && written.modified === 0) summary.enrollments.noop += 1;

    const nodeId = plan.stats.currentNodeId;
    local.nodes.set(nodeId, (local.nodes.get(nodeId) || 0) + 1);
    summary.nodeTally.set(nodeId, (summary.nodeTally.get(nodeId) || 0) + 1);
    summary.historyEntriesRelabelled += plan.stats.relabelled;
    summary.danglingHistoryNodes += plan.stats.dangling;
    if (enrollment.status === "active") summary.activeMigrated += 1;
  }

  return local;
}

function printSummary(log, summary) {
  const c = summary.campaigns;
  const e = summary.enrollments;
  const verb = summary.dryRun ? "would be" : "were";

  log("");
  log("-".repeat(72));
  log(`  SUMMARY${summary.dryRun ? "   (DRY RUN — nothing was written)" : ""}`);
  log("-".repeat(72));
  log(`campaigns     found ${c.found} | migrated ${c.migrated} | skipped ${c.skipped} | failed ${c.failed}`);
  printTally(log, "skipped because", c.skipReasons);
  printTally(log, "failed because", c.failReasons);
  log(`enrollments   found ${e.found} | migrated ${e.migrated} | skipped ${e.skipped} | failed ${e.failed}`);
  printTally(log, "skipped because", e.skipReasons);
  printTally(log, "failed because", e.failReasons);

  if (summary.nodeTally.size) {
    log(`  resumed at    ${formatNodeTally(summary.nodeTally)}`);
  }
  log(`  ${summary.activeMigrated} active enrollment(s) ${verb} migrated — status and nextSendAt untouched, they resume on the existing schedule`);
  log(`  ${summary.historyEntriesRelabelled} history entr(ies) ${verb} relabelled stepIndex -> nodeId`);
  if (summary.danglingHistoryNodes) {
    log(`  note: ${summary.danglingHistoryNodes} history entr(ies) name a node not present in the migrated graph (the campaign lost steps after those sends) — recorded history is kept as-is`);
  }

  if (!summary.dryRun) {
    log("");
    log(`documents actually modified: ${c.modified} campaign(s), ${e.modified} enrollment(s)`);
    if (c.noop || e.noop) {
      log(`  (${c.noop} campaign(s) and ${e.noop} enrollment(s) already held the exact values written — counted as migrated, changed nothing)`);
    }
  }

  const failed = c.failed + e.failed;
  log("");
  if (failed === 0) {
    log(summary.dryRun ? "No failures planned. Safe to re-run without --dry-run." : "Done. No failures.");
  } else {
    log(`${failed} document(s) could not be migrated — see the reasons above. Nothing else was left half-written.`);
  }
  log("");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node tools/migrate-to-graph.js [--dry-run]

  --dry-run   read and compute everything, print the full summary, write nothing
  -h, --help  this message

Stop the campaign poller before a real run.

Reads MONGODB_URI (see db.js / .env). Safe to run more than once: already
migrated campaigns and enrollments are skipped, not migrated again.`;

function parseArgs(argv) {
  const options = { dryRun: false, help: false, unknown: [] };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else options.unknown.push(arg);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  // A typo'd flag must never be the reason a "dry run" wrote to production.
  if (options.unknown.length) {
    console.error(`Unrecognised argument(s): ${options.unknown.join(", ")}\n`);
    console.error(USAGE);
    process.exit(2);
  }

  await connectDB();
  let summary;
  try {
    summary = await migrate(mongoose.connection.db, { dryRun: options.dryRun });
  } finally {
    await mongoose.disconnect();
  }
  process.exit(summary.campaigns.failed + summary.enrollments.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("\nMIGRATION ABORTED:", err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

// Exported so the conversion rules can be exercised offline, without a
// database and without connecting to anything. Requiring this file runs
// nothing — main() is guarded by require.main above.
module.exports = {
  migrate,
  buildGraph,
  planCampaign,
  planEnrollment,
  graphIntegrityErrors,
  messageNodeId,
  EXIT_NODE_ID,
  MIGRATION_VERSION,
};
