const { Schema, model } = require("mongoose");
const Campaign = require("./Campaign");

/**
 * A saved, reusable node configuration — the "welcome message with the usual
 * two params", the "wait 2 days, weekdays only, 10:00-20:00 IST" — so an admin
 * drops it onto a canvas instead of re-authoring the same node for every new
 * lead magnet.
 *
 * COPY SEMANTICS, NOT A LIVE LINK. Inserting a preset copies its `config` into
 * a brand-new campaign node at insertion time and the two have nothing to do
 * with each other afterwards. Editing a preset here changes what *future*
 * insertions get; it must never reach a node already sitting in a campaign's
 * draft, and certainly not one baked into a published versions[] entry that
 * enrollments are walking right now.
 *
 * That was a deliberate choice over live-linked shared nodes. A live link makes
 * a typo fix on a shared node silently rewrite the flow underneath every lead
 * mid-drip — ~951 of them on this install the day the decision was made — with
 * no publish step, no version bump and nothing in the campaign's history saying
 * it happened. The versioned draft/publish split (models/Campaign.js) exists
 * precisely so a flow cannot change under a walking lead; a live-linked preset
 * would have been a hole straight through it.
 *
 * The enforcement of that is an absence, and it is deliberately total: nothing
 * in routes/nodePresets.js or in the canvas's insert-from-library flow writes a
 * preset id — or any other back-reference — onto a campaign node. There is no
 * `presetId` field on nodeSchema to write it to, and there must never be one. A
 * node that came from a preset is byte-for-byte indistinguishable, in storage,
 * from one an admin typed by hand.
 *
 *   name   - admin-facing label for the preset library.
 *   kind   - one of the same node kinds a graph node may be (Campaign.NODE_KINDS),
 *            so a preset can only ever be dropped in as a node the walker
 *            knows how to handle. The library groups by this.
 *   config - a snapshot of a node's config, in exactly the per-kind shape
 *            documented on models/Campaign.js's nodeSchema. Mixed for the same
 *            reason it is Mixed there: the shape per kind is the walker's
 *            contract, not the storage layer's. Never a node's `id` or
 *            `position` — both are per-instance and meaningless off the canvas
 *            they were placed on.
 */
const nodePresetSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    kind: { type: String, required: true, enum: Campaign.NODE_KINDS },
    config: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = model("NodePreset", nodePresetSchema);
