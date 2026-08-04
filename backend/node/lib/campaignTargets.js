const CampaignEnrollment = require("../models/CampaignEnrollment");
const OptOut = require("../models/OptOut");
const { cleanPhone } = require("./phone");
const { resolveSource } = require("./sourceResolver");
const { validateFilter } = require("./sourceData");

/**
 * Who enters a campaign's graph, and on which node.
 *
 * This is the enrol side of the engine, split out from lib/campaignEngine.js
 * (which owns sending and the poller) because the two stopped being one
 * question when campaigns became graphs. Enrolling used to be "resolve the
 * campaign's single targetModel, run its single filter": one source, one
 * filter, one entry point (step 0). A graph can carry several `source` nodes,
 * each with its own sourceId, canonical field map, filter, and its own
 * outgoing edge naming the node its leads start on. Answering "who enrols, as
 * what, starting where" is now a walk of the graph, not a property read.
 *
 * Everything here runs against a *published* version, never the draft. An
 * enrollment records the graphVersion it entered on and walks that snapshot
 * for its whole life (see models/CampaignEnrollment.js), so creating one
 * against an unpublished draft would produce a row pinned to a version that
 * does not exist. That is why enrolling a never-published campaign is an
 * error rather than a silent fall back to `draft`, and why preview resolves
 * the same published graph enroll would use: preview exists to show the
 * numbers the confirm button is about to act on, and numbers taken from a
 * different graph than the one that will run are worse than stale ones.
 */

// Two source nodes can legitimately feed the same drip from the same source
// (two filters over Contact, say). Identity for de-duplication is therefore
// (targetModel, targetId), exactly the CampaignEnrollment unique index, and
// not the node that produced the row. Two *different* sources holding "the
// same person" are two different identities and stay two rows; nothing here
// can know they are one human.
const identity = (targetModel, targetId) => `${targetModel} ${String(targetId)}`;

/**
 * The published graph an enrol/preview run must use: the versions[] entry
 * liveVersion points at.
 */
function liveGraph(campaign) {
  const live = campaign && campaign.liveVersion;
  if (live === null || live === undefined) {
    throw new Error(
      `Campaign "${campaign && campaign.name}" has never been published. Publish a version before enrolling, so enrollments pin to a graph that exists`
    );
  }
  const version = (campaign.versions || []).find((v) => v.version === live);
  if (!version) {
    throw new Error(`Campaign "${campaign.name}" is live on version ${live}, which is missing from its published versions`);
  }
  return version;
}

/**
 * Every `source` node of a graph, paired with the node its outgoing edge leads
 * to: the node an enrollment created from it starts on.
 *
 * Both "no source node at all" and "a source node wired to nothing" are hard
 * errors rather than empty results. A graph with nowhere to enter enrols
 * nobody, and a source with no outgoing edge would mint enrollments with no
 * currentNodeId: rows that exist, count against the unique index, and can
 * never move. Failing the whole call keeps that from being discovered later by
 * a poller that quietly parks them.
 */
function sourceEntryPoints(graph) {
  const nodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];
  const sources = [];

  for (const node of nodes) {
    if (node.kind !== "source") continue;
    const config = node.config || {};
    if (!config.sourceId) {
      throw new Error(`Source node "${node.id}" has no sourceId configured`);
    }
    if (config.filter !== undefined && (config.filter === null || typeof config.filter !== "object" || Array.isArray(config.filter))) {
      throw new Error(`Source node "${node.id}" has a filter that is not an object`);
    }
    // A source node has at most one outgoing edge (branch labels belong to
    // condition/split/goal), so the first edge leaving it is the entry point.
    const edge = edges.find((e) => e.from === node.id);
    if (!edge) {
      throw new Error(`Source node "${node.id}" is not connected to anything. Wire it to the node its leads should start on`);
    }
    sources.push({
      nodeId: node.id,
      sourceId: config.sourceId,
      map: config.map || {},
      filter: config.filter || {},
      entryNodeId: edge.to,
    });
  }

  if (!sources.length) {
    throw new Error("This campaign's graph has no source node. Add one and publish before enrolling");
  }
  return sources;
}

async function optedOutPhones(cleaned) {
  if (!cleaned.length) return new Set();
  const rows = await OptOut.find({ phone: { $in: cleaned.map((c) => c.phone) } })
    .select("phone")
    .lean();
  return new Set(rows.map((o) => o.phone));
}

/**
 * Shared by previewCampaignTargets (read-only) and enrollCampaignTargets
 * (writes): for every source node of `graph`, finds everything matching that
 * node's own filter, cleans phone numbers, excludes anyone who has opted out,
 * de-duplicates across source nodes, and checks which of what is left is
 * already enrolled in this campaign.
 *
 * Counts come back both unioned (what the confirm dialog shows) and per source
 * node (which lead magnet actually contributed anybody).
 */
async function matchTargets(campaign, graph) {
  const sources = sourceEntryPoints(graph);

  const seen = new Set();
  const candidates = [];
  const perSource = [];
  const totals = { matched: 0, skippedNoPhone: 0, skippedBadPhone: 0, skippedOptedOut: 0, skippedDuplicate: 0 };

  for (const src of sources) {
    // A filter reaching a query, from a node config just as much as from a
    // query string, clears the source's field whitelist and the safe-value
    // shapes first. Validated per source node, because "is this field
    // filterable" is a question about that node's own source.
    const filter = await validateFilter(src.sourceId, src.filter);
    const source = await resolveSource(src.sourceId, src.map);
    const targets = await source.find(filter);

    const counts = {
      nodeId: src.nodeId,
      sourceId: src.sourceId,
      entryNodeId: src.entryNodeId,
      filter,
      matched: targets.length,
      skippedNoPhone: 0,
      skippedBadPhone: 0,
      skippedOptedOut: 0,
      skippedDuplicate: 0,
      alreadyEnrolled: 0,
      willEnroll: 0,
    };

    const cleaned = [];
    for (const t of targets) {
      if (!t.phone) {
        counts.skippedNoPhone++;
        continue;
      }
      const phone = cleanPhone(t.phone);
      if (!phone) {
        counts.skippedBadPhone++;
        continue;
      }
      cleaned.push({ _id: t._id, phone });
    }

    // Opt-out is checked before the already-enrolled check and against every
    // campaign's history at once: it is a global, per-phone concern (see
    // models/OptOut.js), not something scoped to this campaign. Filtering
    // here, ahead of the enrol write, is what guarantees an opted-out phone is
    // never (re-)enrolled, whatever filter a source node carries.
    const optedOut = await optedOutPhones(cleaned);

    for (const c of cleaned) {
      if (optedOut.has(c.phone)) {
        counts.skippedOptedOut++;
        continue;
      }
      const key = identity(src.sourceId, c._id);
      if (seen.has(key)) {
        // Reachable through an earlier source node too. Counted and enrolled
        // once, on the first node that reached it, which also keeps the upsert
        // batch below free of two ops for one unique key.
        counts.skippedDuplicate++;
        continue;
      }
      seen.add(key);
      candidates.push({
        targetModel: src.sourceId,
        targetId: c._id,
        phone: c.phone,
        sourceNodeId: src.nodeId,
        entryNodeId: src.entryNodeId,
      });
    }

    for (const key of Object.keys(totals)) totals[key] += counts[key];
    perSource.push(counts);
  }

  // One already-enrolled lookup per distinct source, not per candidate.
  const idsByModel = new Map();
  for (const c of candidates) {
    if (!idsByModel.has(c.targetModel)) idsByModel.set(c.targetModel, []);
    idsByModel.get(c.targetModel).push(c.targetId);
  }
  const enrolled = new Set();
  for (const [targetModel, ids] of idsByModel) {
    const rows = await CampaignEnrollment.find({ campaign: campaign._id, targetModel, targetId: { $in: ids } })
      .select("targetId")
      .lean();
    for (const row of rows) enrolled.add(identity(targetModel, row.targetId));
  }

  const fresh = [];
  const bySourceNode = new Map(perSource.map((c) => [c.nodeId, c]));
  for (const c of candidates) {
    const counts = bySourceNode.get(c.sourceNodeId);
    if (enrolled.has(identity(c.targetModel, c.targetId))) {
      counts.alreadyEnrolled++;
      continue;
    }
    counts.willEnroll++;
    fresh.push(c);
  }

  return {
    ...totals,
    alreadyEnrolled: candidates.length - fresh.length,
    willEnroll: fresh.length,
    sources: perSource,
    targets: fresh, // internal: enrollCampaignTargets turns these into rows
  };
}

// Read-only: same matching and counting as enrollCampaignTargets, no writes.
// Powers the UI's preview step before the "Send campaign" confirm.
async function previewCampaignTargets(campaign) {
  const graph = liveGraph(campaign);
  const { targets, ...counts } = await matchTargets(campaign, graph);
  return { graphVersion: campaign.liveVersion, ...counts };
}

/**
 * Enrol every target the published graph's source nodes match. Re-running is
 * safe: already-enrolled targets are skipped, not restarted, which is what
 * makes the 5-minute auto-enrol rescan idempotent.
 */
async function enrollCampaignTargets(campaign) {
  const graph = liveGraph(campaign);
  const graphVersion = campaign.liveVersion;
  const { targets, ...counts } = await matchTargets(campaign, graph);
  const nextSendAt = new Date();

  const rowFor = (t) => ({
    campaign: campaign._id,
    targetModel: t.targetModel,
    targetId: t.targetId,
    phone: t.phone,
    status: "active",
    // The version this lead walks for the rest of its life, and the node it
    // starts on: the far end of its source node's outgoing edge.
    graphVersion,
    currentNodeId: t.entryNodeId,
    nextSendAt,
    history: [],
  });

  // bulkWrite goes straight to the driver, so none of the schema's validators
  // run on these rows. That is how the pre-graph code silently wrote
  // enrollments carrying no graphVersion at all. The fields that could be
  // invalid (targetModel, currentNodeId, graphVersion) are per source node
  // rather than per lead, so one representative row per source node is
  // validated up front and the batch is only sent once they all pass.
  const validated = new Set();
  for (const t of targets) {
    if (validated.has(t.sourceNodeId)) continue;
    validated.add(t.sourceNodeId);
    const error = new CampaignEnrollment(rowFor(t)).validateSync();
    if (error) throw error;
  }

  const ops = targets.map((t) => ({
    updateOne: {
      filter: { campaign: campaign._id, targetModel: t.targetModel, targetId: t.targetId },
      update: { $setOnInsert: rowFor(t) },
      upsert: true,
    },
  }));

  if (!ops.length) return { ...counts, graphVersion, enrolled: 0 };

  const CHUNK = 1000;
  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const res = await CampaignEnrollment.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    upserted += res.upsertedCount || 0;
  }
  return { ...counts, graphVersion, enrolled: upserted };
}

module.exports = {
  liveGraph,
  sourceEntryPoints,
  matchTargets,
  previewCampaignTargets,
  enrollCampaignTargets,
};
