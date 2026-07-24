const { Schema, model } = require("mongoose");

const fieldSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ["string", "number", "boolean", "date"], default: "string" },
    required: { type: Boolean, default: false },
  },
  { _id: false }
);

const leadMagnetConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    label: { type: String, required: true, trim: true },
    fields: { type: [fieldSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = model("LeadMagnetConfig", leadMagnetConfigSchema);
