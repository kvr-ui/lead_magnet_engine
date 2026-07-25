const { Schema, model } = require("mongoose");

/**
 * A drip campaign: an ordered sequence of WhatsApp template messages sent to
 * enrolled targets (Contacts or Leads) with a delay between each step.
 *
 * Every message WATI sends outside the customer-initiated 24h window must use
 * a WhatsApp-approved template (created in the WATI dashboard first) — so
 * each step references a template by name rather than free-form text.
 *
 * Template params can pull from the target document at send time (e.g. the
 * lead's name) or be a fixed string — see `resolveParams` in lib/campaignEngine.js.
 */
const paramSchema = new Schema(
  {
    type: { type: String, enum: ["field", "static"], required: true },
    value: { type: String, required: true, trim: true }, // field name (e.g. "name") or literal text
  },
  { _id: false }
);

const stepSchema = new Schema(
  {
    delayHours: { type: Number, required: true, min: 0 }, // delay from the previous step (0 for the first step = send on enrollment)
    templateName: { type: String, required: true, trim: true },
    broadcastName: { type: String, required: true, trim: true }, // WATI's required broadcast_name field
    params: { type: [paramSchema], default: [] },
  },
  { _id: false }
);

const campaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true },
    targetModel: { type: String, enum: ["Contact", "Lead", "AdMagnetStudent"], required: true },
    steps: {
      type: [stepSchema],
      validate: (v) => Array.isArray(v) && v.length > 0,
    },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = model("Campaign", campaignSchema);
