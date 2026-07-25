const { Schema, model } = require("mongoose");
const { DYNAMIC_PREFIX } = require("../lib/sourceFields");

const STATIC_TARGET_MODELS = ["Contact", "Lead", "AdMagnetStudent"];
const isValidTargetModel = (v) => STATIC_TARGET_MODELS.includes(v) || v.startsWith(DYNAMIC_PREFIX);

/**
 * One target's (Contact or Lead) progress through a Campaign. Created in bulk
 * when a campaign is enrolled against a filter (see POST /api/campaigns/:id/enroll),
 * then advanced step-by-step by the poller in lib/campaignEngine.js.
 */
const historyEntrySchema = new Schema(
  {
    stepIndex: { type: Number, required: true },
    templateId: { type: String, required: true },
    sentAt: { type: Date, required: true },
    status: { type: String, enum: ["sent", "error"], required: true },
    error: { type: String },
  },
  { _id: false }
);

const enrollmentSchema = new Schema(
  {
    campaign: { type: Schema.Types.ObjectId, ref: "Campaign", required: true, index: true },
    targetModel: {
      type: String,
      required: true,
      validate: { validator: isValidTargetModel, message: (props) => `"${props.value}" is not a valid targetModel` },
    },
    targetId: { type: Schema.Types.ObjectId, required: true },
    phone: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["active", "completed", "paused", "cancelled", "failed"],
      default: "active",
      index: true,
    },
    currentStepIndex: { type: Number, default: 0 }, // step about to be (or last) sent
    nextSendAt: { type: Date, required: true, index: true },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One enrollment per target per campaign — re-enrolling is a no-op via upsert.
enrollmentSchema.index({ campaign: 1, targetModel: 1, targetId: 1 }, { unique: true });

module.exports = model("CampaignEnrollment", enrollmentSchema);
