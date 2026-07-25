const { Schema, model } = require("mongoose");

/**
 * One inbound event from the WATI webhook (POST /api/wati/webhook) —
 * delivery/read receipts, replies, template button clicks, etc. for a
 * template message sent via campaigns. Matched to a CampaignEnrollment by
 * phone number after insert (see routes/wati.js); enrollment/campaign are
 * left null if no active enrollment matches, so no event is ever dropped.
 */
const messageEventSchema = new Schema(
  {
    phone: { type: String, required: true, trim: true, index: true },
    eventType: { type: String, required: true, trim: true }, // raw WATI event name, not normalized
    enrollment: { type: Schema.Types.ObjectId, ref: "CampaignEnrollment", index: true },
    campaign: { type: Schema.Types.ObjectId, ref: "Campaign" },
    payload: { type: Schema.Types.Mixed },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = model("MessageEvent", messageEventSchema);
