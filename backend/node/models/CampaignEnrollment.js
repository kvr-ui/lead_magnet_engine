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
    // The provider's ids for this message, kept so inbound webhook events
    // (delivered / read / replied / failed) can be tied back to the exact
    // send they belong to rather than guessed at by phone number.
    //
    // Two ids because WATI uses two: the WhatsApp-native "wamid.…" carried by
    // every event shape, and its own GUID carried only by the "_v2" variants.
    // providerMessageId is the wamid and is what matching keys on; the local
    // id is a fallback for the case where a send response gives only that.
    //
    // Both may be empty right after a send — the provider's send response
    // doesn't always echo an id — and get backfilled from the *MessageSent
    // webhook, which always carries both (see routes/wati.js).
    providerMessageId: { type: String, trim: true },
    providerLocalMessageId: { type: String, trim: true },
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

// Every inbound webhook event does a lookup by one of these to find the
// enrollment it belongs to; without them that's a collection scan per event.
enrollmentSchema.index({ "history.providerMessageId": 1 });
enrollmentSchema.index({ "history.providerLocalMessageId": 1 });
enrollmentSchema.index({ phone: 1, updatedAt: -1 });

module.exports = model("CampaignEnrollment", enrollmentSchema);
