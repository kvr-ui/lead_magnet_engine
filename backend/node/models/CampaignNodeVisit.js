const { Schema, model } = require("mongoose");

/**
 * One lead having ever passed through one node of one pinned graph version.
 *
 * Per-node funnel counts ("how many leads reached this filter", "how many hit
 * this condition") cannot be reconstructed from CampaignEnrollment.history:
 * that array only ever gains an entry for a `message` or `action` node - a
 * `filter`, `condition`, `split`, `goal`, `wait`, `source` or `exit` node
 * decides and moves on within the same tick, deliberately writing nothing.
 * The walker (lib/campaignEngine.js's runWalk) already computes the full set
 * of nodes a tick passed through, of every kind, as `result.visited`; this
 * collection is where that gets persisted instead of thrown away.
 *
 * One row per (campaign, graphVersion, nodeId, enrollment), ever. Written
 * with $setOnInsert so a revisit - a loop back through a wait node, most
 * commonly - is a no-op: it neither creates a second row nor moves
 * firstVisitedAt. This counts distinct leads reaching a node, the same thing
 * the existing delivery rollups count via `$addToSet` over an aggregation
 * (see routes/campaigns.js, routes/messageEvents.js) - just persisted ahead
 * of time as rows instead of computed after the fact from an array that was
 * never populated for decision nodes in the first place.
 *
 * graphVersion is the enrollment's pinned version, not the campaign's current
 * live one - a lead walking an older published version must not be counted
 * against a newer version's node ids, which may not even mean the same thing.
 *
 * Written fire-and-forget from walkEnrollment's outer wrapper, beside (not
 * inside) applyWalkResult's commit, and only when the tick was not a dry run.
 * A failure here is caught and logged; it must never affect the walk's result
 * or the enrollment itself.
 */
const campaignNodeVisitSchema = new Schema(
  {
    campaign: { type: Schema.Types.ObjectId, ref: "Campaign", required: true },
    graphVersion: { type: Number, required: true },
    nodeId: { type: String, required: true, trim: true },
    enrollment: { type: Schema.Types.ObjectId, ref: "CampaignEnrollment", required: true },
    // When this lead first reached this node in this graph version. Set once,
    // on insert, and never touched again - see the $setOnInsert upsert in
    // lib/campaignEngine.js.
    firstVisitedAt: { type: Date, required: true },
  },
  { timestamps: false }
);

// One row per lead per node per graph version, ever - what makes a revisit
// (a loop back through a wait node, a re-walk of the same tick after a park)
// a no-op instead of a duplicate.
campaignNodeVisitSchema.index(
  { campaign: 1, graphVersion: 1, nodeId: 1, enrollment: 1 },
  { unique: true }
);

// The funnel-aggregation access path (task 10): "for this campaign's this
// graph version, how many distinct leads reached each node".
campaignNodeVisitSchema.index({ campaign: 1, graphVersion: 1 });

module.exports = model("CampaignNodeVisit", campaignNodeVisitSchema);
