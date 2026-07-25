const { Schema, model } = require("mongoose");

/**
 * A drip campaign: an ordered sequence of WhatsApp template messages sent to
 * enrolled targets (Contacts or Leads), one step per send cycle.
 *
 * Every message WATI sends outside the customer-initiated 24h window must use
 * a WhatsApp-approved template (created in the WATI dashboard first) — so
 * each step references a template by name rather than free-form text.
 */
const stepSchema = new Schema(
  {
    templateName: { type: String, required: true, trim: true },
    broadcastName: { type: String, required: true, trim: true }, // WATI's required broadcast_name field
  },
  { _id: false }
);

const campaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true },
    targetModel: { type: String, enum: ["Contact", "Lead", "AdMagnetStudent"], required: true },
    // WhatsApp number this campaign sends from, e.g. "+916383514285" (see
    // watiClient.getChannels()) — "" sends from the account's default number.
    channelNumber: { type: String, default: "", trim: true },
    steps: {
      type: [stepSchema],
      validate: (v) => Array.isArray(v) && v.length > 0,
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = model("Campaign", campaignSchema);
