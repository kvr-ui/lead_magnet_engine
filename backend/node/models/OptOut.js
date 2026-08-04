const { Schema, model } = require("mongoose");

/**
 * A phone number that has asked (or been told) not to receive WhatsApp
 * messages from us.
 *
 * Deliberately global and independent of any campaign: a phone lands here
 * once — from an inbound STOP-style reply (see routes/wati.js) or a manual
 * add (see routes/optOuts.js) — and from then on lib/campaignEngine.js's
 * matchTargets() excludes it from every campaign's candidate list, no matter
 * which campaign(s) the phone would otherwise match. Opt-out is a per-phone
 * concern, not a per-campaign one; modeling it as a node on the campaign
 * graph instead would mean a flow that forgot to wire in a STOP-handling
 * node would keep messaging someone who explicitly asked to stop.
 */
const optOutSchema = new Schema(
  {
    phone: { type: String, required: true, trim: true },
    source: { type: String, enum: ["inbound-keyword", "manual"], required: true },
    // The literal inbound text that triggered the opt-out (e.g. "STOP",
    // "बंद"), when the source is inbound-keyword. Left unset for manual adds.
    keyword: { type: String, trim: true },
  },
  { timestamps: true }
);

// One opt-out per phone — upserted on repeat STOP messages rather than
// accumulating duplicates.
optOutSchema.index({ phone: 1 }, { unique: true });

module.exports = model("OptOut", optOutSchema);
