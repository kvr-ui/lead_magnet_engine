const { Schema, model } = require("mongoose");

/**
 * The WhatsApp provider connection ("node") that campaigns send through.
 * Only one row is ever active at a time — lib/whatsappProvider.js queries
 * {active: true} for the live config. Disconnecting sets active: false
 * rather than deleting, so reconnecting doesn't require re-entering
 * credentials.
 */
const channelSchema = new Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
  },
  { _id: false }
);

const whatsAppIntegrationSchema = new Schema(
  {
    type: { type: String, enum: ["wati"], default: "wati" },
    apiEndpoint: { type: String, required: true, trim: true },
    apiTokenEncrypted: { type: String, required: true },
    channels: { type: [channelSchema], default: [] },
    active: { type: Boolean, default: false },
    connectedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = model("WhatsAppIntegration", whatsAppIntegrationSchema);
