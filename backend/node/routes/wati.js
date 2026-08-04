const express = require("express");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");
const MessageEvent = require("../models/MessageEvent");
const OptOut = require("../models/OptOut");
const { cleanPhone } = require("../lib/phone");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

// WATI's payload shape varies by event (message status vs. inbound reply vs.
// button click). Pull whatever's there instead of assuming one schema —
// unrecognized fields just land in `payload` for later inspection.
function extractPhone(body) {
  const raw = body.waId || body.whatsappNumber || body.phone || body.senderPhone || body.customerPhone || "";
  return raw ? cleanPhone(String(raw)) : "";
}

function extractEventType(body) {
  return body.eventType || body.type || body.statusString || body.event || "unknown";
}

// The provider's id for the message an event belongs to.
//
// whatsappMessageId (the WhatsApp-native "wamid.…") comes first deliberately.
// WATI fires every event twice — "sentMessageREAD" and "sentMessageREAD_v2" —
// and only the _v2 variant carries localMessageId. Keying on localMessageId
// therefore gave the two halves of one pair different ids, so the dedupe index
// never collapsed them and every state was stored twice. wamid is present on
// both variants, so preferring it makes the pair a genuine duplicate.
function extractProviderMessageId(body) {
  const raw = body.whatsappMessageId || body.localMessageId || body.messageId || body.id;
  return raw ? String(raw) : "";
}

// WATI's own GUID for the message. Only the "_v2" event variants carry it;
// kept as a secondary matching key for the case where a send response echoes
// this and nothing else.
function extractLocalMessageId(body) {
  return body.localMessageId ? String(body.localMessageId) : "";
}

// On an inbound reply or button click, this is the wamid of the message being
// replied TO — i.e. the campaign message we sent. That makes it the link back
// to the enrollment, since the event's own whatsappMessageId belongs to the
// lead's new message and matches nothing we sent.
function extractReplyContextId(body) {
  return body.replyContextId ? String(body.replyContextId) : "";
}

// True for the events that announce a send we made ("templateMessageSent",
// "sessionMessageSent", and their _v2 twins). These are the only events that
// carry both the phone number and the message ids, which is what makes them
// usable to backfill ids onto the enrollment.
function isOutboundSendEvent(eventType) {
  return /messagesent/i.test(eventType || "");
}

// Collapse the provider's many event names onto the handful of states worth
// counting. Matched loosely (and on statusString as well as eventType)
// because WATI spells the same state differently across event shapes.
function normalizeStatus(body, eventType) {
  // `owner: false` marks a message the lead sent us. WATI still stamps those
  // with statusString "SENT" (the lead's phone sent it), which read as one of
  // our own outbound sends — inflating the sent count with inbound traffic and
  // letting a reply occupy the dedupe slot belonging to the real send.
  if (body.owner === false) return "received";

  const hay = `${eventType} ${body.statusString || ""} ${body.status || ""}`.toLowerCase();
  if (hay.includes("fail") || hay.includes("undeliver")) return "failed";
  if (hay.includes("repl")) return "replied";
  if (hay.includes("read") || hay.includes("seen")) return "read";
  if (hay.includes("deliver")) return "delivered";
  if (hay.includes("receiv")) return "received";
  if (hay.includes("sent") || hay.includes("send")) return "sent";
  return "unknown";
}

function extractText(body) {
  const raw = body.text || body.messageText || body.data?.text;
  return typeof raw === "string" ? raw : undefined;
}

// ---------------------------------------------------------------------------
// Global WhatsApp opt-out (STOP-keyword handling)
// ---------------------------------------------------------------------------
// Deliberately implemented here, always-on and independent of any particular
// campaign, rather than as a node type on the campaign flow canvas. If
// opt-out were just another node a campaign designer could place, a flow
// where someone forgot to wire in a STOP-handling node would keep messaging
// people who explicitly asked to stop. Every inbound message on every
// campaign (and every direct send) passes through this one webhook handler,
// so checking here is the only way to guarantee the rule can't be bypassed by
// a campaign's graph shape.
const STOP_KEYWORDS = new Set(
  ["STOP", "UNSUBSCRIBE", "UNSUB", "OPTOUT", "OPT OUT", "CANCEL", "QUIT", "END", "बंद", "रोको"].map((k) =>
    k.toLowerCase()
  )
);

// Case-insensitive, trimmed, WHOLE-message match — deliberately not a
// substring test. "stop by tomorrow" must not opt someone out; only a reply
// whose entire trimmed body equals one of the keywords counts. Returns the
// trimmed original text (for storing as OptOut.keyword) or undefined.
function matchStopKeyword(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return STOP_KEYWORDS.has(trimmed.toLowerCase()) ? trimmed : undefined;
}

// Record the opt-out and cancel every active enrollment for this phone across
// every campaign — opt-out is a global, per-phone concern, not a per-campaign
// one, so this deliberately does not scope to whichever campaign/enrollment
// this particular inbound reply happens to be matched to.
async function recordOptOut(phone, keyword) {
  await OptOut.findOneAndUpdate(
    { phone },
    { $set: { source: "inbound-keyword", keyword }, $setOnInsert: { phone } },
    { upsert: true, setDefaultsOnInsert: true }
  );
  const { modifiedCount } = await CampaignEnrollment.updateMany(
    { phone, status: "active" },
    { $set: { status: "cancelled" } }
  );
  console.log(
    `[wati/webhook] opt-out: ${phone} sent "${keyword}" — cancelled ${modifiedCount} active enrollment(s) across all campaigns`
  );
}

// What an event belongs to — a campaign enrollment or a manual single-number
// send — tried most-exact first. Returns at most one of the two; an event is
// about one message, and that message came from one place or the other.
//
// Message ids win over phone because they name one specific send. Every id is
// tried against both collections before phone is considered at all: an exact
// id match on a manual send is more trustworthy than a phone match on a
// campaign, whatever order the two happened in.
//
// Phone is the last resort and deliberately ignores status — a one-step
// campaign marks a lead "completed" the instant it sends, so a reply arriving a
// minute later would otherwise attach to nothing at all.
async function findTarget({ phone, providerMessageId, localMessageId, replyContextId }) {
  // An inbound reply's own id matches nothing we sent; the id of the message
  // it answers (replyContextId) does.
  const wamids = [providerMessageId, replyContextId].filter(Boolean);

  for (const id of wamids) {
    const match = await CampaignEnrollment.findOne({ "history.providerMessageId": id });
    if (match) return { enrollment: match };
  }
  if (localMessageId) {
    const match = await CampaignEnrollment.findOne({ "history.providerLocalMessageId": localMessageId });
    if (match) return { enrollment: match };
  }

  for (const id of wamids) {
    const match = await DirectMessage.findOne({ providerMessageId: id });
    if (match) return { directMessage: match };
  }
  if (localMessageId) {
    const match = await DirectMessage.findOne({ providerLocalMessageId: localMessageId });
    if (match) return { directMessage: match };
  }

  if (!phone) return {};

  // Nothing matched by id, so fall back to the number — and when the same
  // number has both a campaign enrollment and a manual send, take whichever
  // was touched most recently. Preferring one collection outright would
  // mis-attribute every event belonging to the other.
  const [enrollment, directMessage] = await Promise.all([
    CampaignEnrollment.findOne({ phone }).sort({ updatedAt: -1 }),
    DirectMessage.findOne({ phone }).sort({ sentAt: -1 }),
  ]);
  if (enrollment && directMessage) {
    return directMessage.sentAt > enrollment.updatedAt ? { directMessage } : { enrollment };
  }
  if (enrollment) return { enrollment };
  return directMessage ? { directMessage } : {};
}

// Teach an enrollment the ids of the message it just sent.
//
// The provider's send response doesn't reliably echo an id, so an enrollment's
// history entry is often written without one — and every later status event
// (delivered/read) carries ids but no phone number, leaving nothing to match
// on. The *MessageSent webhook is the one event with both, so it's what closes
// the gap: match it by phone, then stamp its ids onto the most recent sent
// step. Everything downstream then matches by id.
async function backfillMessageIds(enrollment, providerMessageId, localMessageId) {
  if (!enrollment || !providerMessageId) return;

  // The two halves of a send pair arrive separately and carry different
  // subsets of the ids — only the "_v2" half has the local id — so an entry
  // already stamped with the wamid may still be missing it. Top up whichever
  // id is absent rather than treating a known wamid as nothing left to do.
  const known = enrollment.history.find((h) => h.providerMessageId === providerMessageId);
  if (known) {
    if (!localMessageId || known.providerLocalMessageId === localMessageId) return;
    known.providerLocalMessageId = localMessageId;
    await enrollment.save();
    return;
  }

  // The last successful send is the one this event announces. Only fill a slot
  // that has no id yet, so a redelivered event can't overwrite a later step's
  // id with an earlier message's.
  const target = [...enrollment.history].reverse().find((h) => h.status === "sent" && !h.providerMessageId);
  if (!target) return;

  target.providerMessageId = providerMessageId;
  if (localMessageId) target.providerLocalMessageId = localMessageId;
  await enrollment.save();
}

// The same gap-closing for a manual send. Simpler than the enrollment case
// because a DirectMessage is exactly one message — there's no history of steps
// to pick the right slot from.
//
// Only ever fills a blank. The two halves of a send pair arrive separately
// carrying different subsets of the ids, so the second half must be able to top
// up the id the first didn't have, without either overwriting the other.
async function backfillDirectMessageIds(directMessage, providerMessageId, localMessageId) {
  if (!directMessage || !providerMessageId) return;

  let changed = false;
  if (!directMessage.providerMessageId) {
    directMessage.providerMessageId = providerMessageId;
    changed = true;
  }
  if (localMessageId && !directMessage.providerLocalMessageId) {
    directMessage.providerLocalMessageId = localMessageId;
    changed = true;
  }
  if (changed) await directMessage.save();
}

// POST /api/wati/webhook — WATI calls this on message status changes, replies,
// and button clicks. Registered under Integrations > WhatsApp in the admin UI.
//
// This endpoint takes NO secret: any caller that reaches it can write a
// MessageEvent. Nothing here is authenticated, so only expose it through the
// webhook bridge (tools/webhook-bridge.js), never by tunnelling port 3000.
router.post("/wati/webhook", async (req, res) => {
  const body = req.body || {};
  console.log(`[wati/webhook] ${new Date().toISOString()} body:`, JSON.stringify(body));

  const phone = extractPhone(body);
  const eventType = extractEventType(body);
  const providerMessageId = extractProviderMessageId(body);
  const localMessageId = extractLocalMessageId(body);
  const replyContextId = extractReplyContextId(body);
  const { enrollment, directMessage } = await findTarget({ phone, providerMessageId, localMessageId, replyContextId });

  if (isOutboundSendEvent(eventType)) {
    if (enrollment) await backfillMessageIds(enrollment, providerMessageId, localMessageId);
    else if (directMessage) await backfillDirectMessageIds(directMessage, providerMessageId, localMessageId);
  }

  try {
    await MessageEvent.create({
      // Status events (delivered/read/replied) carry no waId at all, which
      // left them stored as "unknown" and unsearchable by lead. Whatever we
      // matched knows the number, so borrow it.
      phone: phone || enrollment?.phone || directMessage?.phone || "unknown",
      eventType,
      status: normalizeStatus(body, eventType),
      providerMessageId: providerMessageId || undefined,
      text: extractText(body),
      failedCode: body.failedCode ? String(body.failedCode) : undefined,
      failedDetail: body.failedDetail,
      enrollment: enrollment?._id,
      campaign: enrollment?.campaign,
      directMessage: directMessage?._id,
      payload: body,
    });
  } catch (err) {
    // Duplicate key = the provider redelivered an event we already stored.
    // That's the dedupe index doing its job, not a failure worth reporting.
    if (err.code !== 11000) throw err;
    console.log(`[wati/webhook] duplicate ${eventType} for ${providerMessageId} — ignored`);
  }

  // STOP-keyword opt-out detection — additive on top of the classification
  // above, and deliberately isolated in its own try/catch. `body.owner ===
  // false` is the same "this is an inbound message from the lead" signal
  // normalizeStatus() uses to classify the event as "received"; ordinary
  // (non-STOP) inbound replies are completely unaffected by this block and
  // continue to be recorded exactly as before via MessageEvent above.
  //
  // A non-2xx response here just makes WATI retry the same event, so a bug or
  // a transient DB error in opt-out processing must never surface as one —
  // that would risk WATI re-delivering the event indefinitely instead of
  // simply skipping opt-out processing for this one event.
  try {
    if (body.owner === false && phone) {
      const keyword = matchStopKeyword(extractText(body));
      if (keyword) await recordOptOut(phone, keyword);
    }
  } catch (err) {
    console.error(`[wati/webhook] opt-out handling failed for ${phone || "unknown"}:`, err.message);
  }

  // WATI expects a 200 regardless of whether we matched an enrollment —
  // a non-2xx here just makes WATI retry the same event.
  res.json({ ok: true });
});

module.exports = router;
