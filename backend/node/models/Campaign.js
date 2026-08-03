const { Schema, model } = require("mongoose");
const { DYNAMIC_PREFIX } = require("../lib/sourceFields");

const STATIC_TARGET_MODELS = ["Contact", "Lead", "AdMagnetStudent"];
// Besides the built-in sources, any user-connected Data Source ("datasource:<id>") is a valid target.
const isValidTargetModel = (v) => STATIC_TARGET_MODELS.includes(v) || v.startsWith(DYNAMIC_PREFIX);

/**
 * A drip campaign: an ordered sequence of WhatsApp template messages sent to
 * enrolled targets (Contacts or Leads), one step per send cycle.
 *
 * Every message sent outside the customer-initiated 24h window must use a
 * WhatsApp-approved template (created in the connected provider's dashboard
 * first) — so each step references a template by id rather than free-form
 * text. providerMeta carries whatever extra field the connected provider
 * needs (e.g. WATI's required broadcast_name) — optional because not every
 * provider has an equivalent concept.
 */
const stepSchema = new Schema(
  {
    templateId: { type: String, required: true, trim: true },
    providerMeta: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false }
);

const campaignSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    description: { type: String, trim: true },
    targetModel: {
      type: String,
      required: true,
      validate: { validator: isValidTargetModel, message: (props) => `"${props.value}" is not a valid targetModel` },
    },
    // Channel identifier from the connected provider (see
    // whatsappProvider.getChannels()) — "" sends from the provider's
    // default channel.
    channelId: { type: String, default: "", trim: true },
    steps: {
      type: [stepSchema],
      validate: (v) => Array.isArray(v) && v.length > 0,
    },
    active: { type: Boolean, default: true },
    // Re-run this campaign's segment on a schedule, so targets that appear in
    // the source *after* the manual "Send campaign" click still enter the drip.
    //
    // Without this, enrollment is a one-time snapshot: enrollTargets matches
    // whoever fits the filter at that instant, writes their enrollments, and
    // nothing ever rescans the source. A lead added to a connected Data Source
    // an hour later is invisible to the campaign until someone clicks Send again.
    //
    // autoEnrollFilter is only ever written from a segment the admin previewed
    // and confirmed, never a filter posted straight at the API — an empty
    // filter here means "everyone in the source", which is not something to
    // arrive at by accident.
    autoEnroll: { type: Boolean, default: false },
    autoEnrollFilter: { type: Schema.Types.Mixed, default: {} },
    // Outcome of the last auto-enroll tick, so an armed campaign that has
    // quietly stopped picking anyone up (source credentials rotated, phone
    // field renamed) shows why in the UI instead of just looking idle.
    lastAutoEnrollAt: { type: Date },
    lastAutoEnrollCount: { type: Number },
    lastAutoEnrollError: { type: String },
  },
  { timestamps: true }
);

module.exports = model("Campaign", campaignSchema);
