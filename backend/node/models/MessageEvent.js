const { Schema, model } = require("mongoose");

/**
 * One inbound event from the WATI webhook (POST /api/wati/webhook) —
 * delivery/read receipts, replies, template button clicks, etc. for a
 * template message sent via campaigns. Matched to a CampaignEnrollment by
 * provider message id where possible and by phone otherwise (see
 * routes/wati.js); enrollment/campaign are left null when nothing matches,
 * so no event is ever dropped — traffic from outside a campaign (chatbot
 * replies, manual sends) is kept too and simply reads as unattributed.
 */
// Provider event names vary ("sentMessageREPLIED", "templateMessageFailed",
// a bare messageStatus with statusString "DELIVERED", ...). `status` is the
// normalized form everything downstream counts on; `eventType` keeps the raw
// name so nothing is lost in translation.
const STATUSES = ["sent", "delivered", "read", "replied", "received", "failed", "unknown"];

const messageEventSchema = new Schema(
  {
    phone: { type: String, required: true, trim: true, index: true },
    eventType: { type: String, required: true, trim: true }, // raw WATI event name, not normalized
    status: { type: String, enum: STATUSES, default: "unknown", index: true },
    // The provider's own id for the message this event is about. When present
    // it links every event in one message's lifecycle together, which is far
    // more reliable than matching on phone number alone.
    providerMessageId: { type: String, trim: true, index: true },
    // The wamid of OUR message this inbound event is answering — WATI's
    // "replyContextId" on a quoted reply or a template button tap. Lets a
    // later flow condition ask "did they reply to *this* message node"
    // instead of approximating with "any inbound message after this node's
    // send time" (wrong the moment two message nodes fire close together, since
    // a reply to the first would be attributed to the second). Only ever set on
    // inbound events; absent on send/status events and on historical rows
    // recorded before this field existed — both read as "no data".
    inReplyToProviderMessageId: { type: String, trim: true, index: true },
    // The raw payload `type` field on an inbound event — "button", "list",
    // "text", or absent. This is how a quick-reply tap is told apart from
    // typed text: both land in `text` below, identically.
    interactiveType: { type: String, trim: true },
    // The tapped button/list option's machine-stable id, captured
    // opportunistically when the payload happens to carry one under a field
    // name we recognize. UNCONFIRMED: the one real captured button fixture in
    // this repo has no such field at all — just
    // { eventType: "message", type: "button", text: "<button label>" }. Nothing
    // in this codebase depends on this field being populated. Confirm the real
    // field name by sending one live quick-reply template and reading the
    // `[wati/webhook] ... body:` log line the handler already prints, then
    // tighten extractInteractivePayloadId() in routes/wati.js accordingly.
    interactivePayloadId: { type: String, trim: true },
    text: { type: String }, // reply / inbound message body, when the event carries one
    failedCode: { type: String, trim: true }, // Meta's error code on a failed send
    failedDetail: { type: String },
    enrollment: { type: Schema.Types.ObjectId, ref: "CampaignEnrollment", index: true },
    campaign: { type: Schema.Types.ObjectId, ref: "Campaign" },
    // Set instead of enrollment/campaign when the event belongs to a manual
    // single-number send. The two are mutually exclusive: an event is about a
    // campaign message or a hand-sent one, never both.
    directMessage: { type: Schema.Types.ObjectId, ref: "DirectMessage", index: true },
    payload: { type: Schema.Types.Mixed },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// A non-2xx makes WATI retry, and a retry can also arrive after a successful
// response was lost — so the same event can land twice.
//
// Dedupe on the NORMALIZED status, not the raw event name: WATI reports sent,
// delivered and read all under one eventType ("messageStatus"), with the real
// state in statusString, so keying on eventType would throw away every
// transition after the first.
//
// Only delivery-state transitions are deduped. They're idempotent — a message
// reaches "delivered" once, and a second report of it is genuinely redundant.
//
// "replied" belongs here despite naming a reply: it comes from WATI's
// sentMessageREPLIED, which is a status stamped on the message WE sent, and
// that message is answered once. The lead's actual reply text arrives as a
// separate inbound event.
//
// "received" — those inbound messages — is excluded, because a lead who
// answers three times must keep all three. Each carries its own message id, so
// they would not collide anyway; leaving it out makes that guarantee explicit
// rather than incidental.
const IDEMPOTENT_STATUSES = ["sent", "delivered", "read", "replied", "failed"];

messageEventSchema.index(
  { providerMessageId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: {
      providerMessageId: { $type: "string" },
      status: { $in: IDEMPOTENT_STATUSES },
    },
  }
);

messageEventSchema.index({ enrollment: 1, receivedAt: -1 });
messageEventSchema.index({ directMessage: 1, receivedAt: -1 });

// "When did this number last message us?" — the 24-hour session window
// (lib/sessionWindow.js). Ordered phone → status → receivedAt so the newest
// inbound event for one number is an index seek rather than a scan of that
// number's whole event history, which for an engaged lead is every delivery
// and read receipt we ever recorded for them.
messageEventSchema.index({ phone: 1, status: 1, receivedAt: -1 });

module.exports = model("MessageEvent", messageEventSchema);
module.exports.STATUSES = STATUSES;
