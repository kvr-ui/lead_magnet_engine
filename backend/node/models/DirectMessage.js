const { Schema, model } = require("mongoose");

/**
 * One WhatsApp template message sent by hand to a single number
 * (POST /api/campaigns/send-message), outside any campaign.
 *
 * These used to be fire-and-forget: the send happened and nothing recorded it,
 * so the delivery/read events that came back by webhook had nothing to attach
 * to and were stored unattributed. Kept as a record purely so that matching
 * has a target — a manual send is as worth tracking as a campaign one, and by
 * carrying the same provider ids it reuses the same id-first matching the
 * campaign path relies on (see routes/wati.js).
 *
 * Deliberately not a CampaignEnrollment: that requires a campaign, a target
 * model and a target document, none of which exist here. Faking them to reuse
 * the collection would corrupt every campaign-scoped count.
 */
const directMessageSchema = new Schema(
  {
    phone: { type: String, required: true, trim: true, index: true },
    templateId: { type: String, required: true, trim: true },
    broadcastName: { type: String, trim: true },
    channelId: { type: String, trim: true },
    sentAt: { type: Date, default: Date.now },
    // "error" means the provider rejected the send outright. A send the
    // provider accepted and WhatsApp later failed to deliver stays "sent"
    // here — that outcome lives in the MessageEvent stream, not on this row.
    status: { type: String, enum: ["sent", "error"], required: true },
    error: { type: String },
    // Same two ids, for the same reason, as CampaignEnrollment's history
    // entries: the WhatsApp-native "wamid.…" that every event shape carries,
    // and WATI's own GUID that only the "_v2" variants do. Both are often
    // empty right after the send and get backfilled from the *MessageSent
    // webhook.
    providerMessageId: { type: String, trim: true },
    providerLocalMessageId: { type: String, trim: true },
  },
  { timestamps: true }
);

// Every inbound webhook event tries these before falling back to phone.
directMessageSchema.index({ providerMessageId: 1 });
directMessageSchema.index({ providerLocalMessageId: 1 });
directMessageSchema.index({ phone: 1, sentAt: -1 });

module.exports = model("DirectMessage", directMessageSchema);
