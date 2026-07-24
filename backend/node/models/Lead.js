const { Schema, model } = require("mongoose");

const leadSchema = new Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    email: { type: String, trim: true },
    leadMagnet: { type: String, required: true, index: true },
    extra: { type: Map, of: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

leadSchema.index({ leadMagnet: 1, phone: 1 }, { unique: true });

module.exports = model("Lead", leadSchema);
