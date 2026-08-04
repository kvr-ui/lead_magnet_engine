const { Schema, model } = require("mongoose");
const { DYNAMIC_PREFIX } = require("../lib/sourceFields");

// "AdMagnetStudent" was removed when CA Guru stopped being a code-level
// source and became an ordinary DataSourceConnection. New enrollments must
// name a real source; historical rows that still carry the old string are
// read through the documented compatibility shim in lib/sourceResolver.js,
// which is a read path and does not go through this validator.
const STATIC_TARGET_MODELS = ["Contact", "Lead"];
const isValidTargetModel = (v) => STATIC_TARGET_MODELS.includes(v) || v.startsWith(DYNAMIC_PREFIX);

/**
 * One target's (Contact or Lead) progress through a Campaign. Created in bulk
 * when a campaign is enrolled against a filter (see POST /api/campaigns/:id/enroll),
 * then advanced node-by-node by the poller in lib/campaignEngine.js.
 *
 * Progress used to be an index into the campaign's flat `steps[]` array. The
 * campaign is now a versioned graph (see models/Campaign.js), so an enrollment
 * instead names the node it is sitting on (`currentNodeId`) inside the exact
 * published graph version it entered on (`graphVersion`).
 */
const historyEntrySchema = new Schema(
  {
    // Which graph node produced this entry - the graph-era replacement for the
    // old stepIndex. A node id rather than a position, so that reordering or
    // re-publishing a flow can't retroactively relabel what was already sent.
    nodeId: { type: String, required: true },
    // What happened, not just where. History used to hold sends and nothing
    // else; an `action` node's outbound call or source write-back is also
    // something this lead had done to them, and it belongs in the same ordered
    // record rather than in a second log beside it. Defaulted to "message" so
    // every row written before actions existed reads back correctly, and read
    // by anything that means *sends* specifically (GET /api/sends) rather than
    // "everything that happened".
    kind: { type: String, enum: ["message", "action"], default: "message" },
    // Required for a message - a send with no template is not a send - and
    // meaningless for an action, which references no template at all.
    templateId: {
      type: String,
      required: function () {
        return this.kind !== "action";
      },
    },
    sentAt: { type: Date, required: true },
    // "sent" and "error" are the message vocabulary; an action reports "ok" or
    // "error". Kept in one enum rather than split per kind so the whole history
    // is still one queryable shape.
    status: { type: String, enum: ["sent", "error", "ok"], required: true },
    error: { type: String },
    // Whatever the entry needs to be debuggable later: for an action, the
    // status code the endpoint returned or the field that was written.
    detail: { type: String },
    // The provider's ids for this message, kept so inbound webhook events
    // (delivered / read / replied / failed) can be tied back to the exact
    // send they belong to rather than guessed at by phone number.
    //
    // Two ids because WATI uses two: the WhatsApp-native "wamid.…" carried by
    // every event shape, and its own GUID carried only by the "_v2" variants.
    // providerMessageId is the wamid and is what matching keys on; the local
    // id is a fallback for the case where a send response gives only that.
    //
    // Both may be empty right after a send - the provider's send response
    // doesn't always echo an id - and get backfilled from the *MessageSent
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
    // Which of the campaign's versions[] snapshots this enrollment is walking.
    // Pinned to the campaign's liveVersion at the moment the enrollment was
    // created and never changed afterwards, so publishing a new version of a
    // flow can't re-route or strand a lead already mid-drip. Required because
    // an enrollment with no pinned version has no well-defined graph to walk.
    graphVersion: { type: Number, required: true },
    // Node of the pinned version this enrollment is at: about to be processed,
    // or last processed. A node id, not an array index.
    currentNodeId: { type: String, trim: true },
    // The labelled outcome the walk ended on - an `exit` node's configured
    // `outcome`. A graph can end in several places ("converted", "unsubscribed",
    // "no answer") and the status alone flattens all of them to "completed", so
    // the label is kept separately rather than encoded into the status enum.
    outcome: { type: String, trim: true },
    // Why the enrollment is sitting where it is: which node id was missing from
    // which pinned graph version, which node kind isn't implemented yet, which
    // cycle tripped the walker's per-tick hop limit. Written on every tick and
    // cleared on a clean one, so a stale explanation can never outlive the
    // condition that caused it. Without this a paused enrollment is a dead end
    // for whoever has to work out what went wrong.
    statusReason: { type: String, trim: true },
    nextSendAt: { type: Date, required: true, index: true },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true }
);

// One enrollment per target per campaign - re-enrolling is a no-op via upsert.
enrollmentSchema.index({ campaign: 1, targetModel: 1, targetId: 1 }, { unique: true });

// Every inbound webhook event does a lookup by one of these to find the
// enrollment it belongs to; without them that's a collection scan per event.
enrollmentSchema.index({ "history.providerMessageId": 1 });
enrollmentSchema.index({ "history.providerLocalMessageId": 1 });
enrollmentSchema.index({ phone: 1, updatedAt: -1 });

module.exports = model("CampaignEnrollment", enrollmentSchema);
