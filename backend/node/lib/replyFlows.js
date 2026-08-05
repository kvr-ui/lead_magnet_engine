const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const OptOut = require("../models/OptOut");

/**
 * What an inbound reply does to this phone's running drips. Driven from the
 * WATI webhook (routes/wati.js) the moment a lead's message arrives, not from
 * the poll loop — a lead who replies should see the effect immediately, the
 * same way STOP handling works.
 *
 * Precedence, per inbound message:
 *
 *   1. STOP keyword — handled by the CALLER before this module is reached.
 *      An opt-out cancels enrollments outright and skips everything below;
 *      a STOP must never be treated as "engagement" that stops-with-outcome
 *      or, worse, resumes a parked drip.
 *   2. Campaigns with stopOnReply — the reply ends the lead's drip there:
 *      enrollment completed with outcome "replied". Applies to active rows
 *      AND to rows parked on a closed window; a reply ends a stop-on-reply
 *      drip whether or not it happened to be parked at that moment.
 *   3. Everything else — enrollments parked because a free-text send found
 *      the 24-hour window closed are resumed: the reply just re-opened the
 *      window, so the parked send can go out on the next poll tick. Guarded
 *      by the OptOut collection so a previously opted-out phone is never
 *      resurrected by a later message.
 *
 * Every write here is an idempotent updateMany, so WATI redelivering the same
 * webhook event is harmless.
 */

// Enrollments the walker parked because a free-text send needed an open
// conversation window. New rows carry the machine-readable code; rows parked
// before statusReasonCode existed carry only the walker's prose, matched by
// the stable fragment of that message (see the windowClosed park in
// lib/campaignEngine.js).
const LEGACY_WINDOW_PARK = /could not send free text/;

const WINDOW_PARKED_OR = [
  { statusReasonCode: CampaignEnrollment.REASON_WINDOW_CLOSED },
  { statusReasonCode: { $in: [null, ""] }, statusReason: LEGACY_WINDOW_PARK },
];

async function stopOnReplyCampaignIds() {
  const campaigns = await Campaign.find({ stopOnReply: true }).select("_id").lean();
  return campaigns.map((c) => c._id);
}

// End this phone's drip in every stop-on-reply campaign: active rows and
// window-parked rows alike become completed with outcome "replied". Other
// paused rows (broken graph, missing node) are left alone — those are
// operator problems, and "the lead replied" doesn't make them resolved.
async function completeRepliedEnrollments(phone, campaignIds) {
  if (!campaignIds.length) return 0;
  const { modifiedCount } = await CampaignEnrollment.updateMany(
    {
      phone,
      campaign: { $in: campaignIds },
      $or: [{ status: "active" }, { status: "paused", $or: WINDOW_PARKED_OR }],
    },
    { $set: { status: "completed", outcome: "replied", statusReason: null, statusReasonCode: null } }
  );
  return modifiedCount;
}

// The reply that just arrived re-opened this phone's 24-hour window, so every
// enrollment parked waiting for exactly that can go again. currentNodeId
// still points at the message node that was refused, so making the row due
// now means the next poll tick re-attempts that exact send.
async function resumeWindowParkedEnrollments(phone, excludeCampaignIds, now) {
  // recordOptOut also cancels paused rows, but that only covers opt-outs that
  // arrive after this code shipped — this guard covers the ones already on
  // file, and makes "opted out means never resumed" not depend on ordering.
  if (await OptOut.exists({ phone })) return 0;
  const query = { phone, status: "paused", $or: WINDOW_PARKED_OR };
  if (excludeCampaignIds.length) query.campaign = { $nin: excludeCampaignIds };
  const { modifiedCount } = await CampaignEnrollment.updateMany(query, {
    $set: { status: "active", nextSendAt: now, statusReason: null, statusReasonCode: null },
  });
  return modifiedCount;
}

async function handleInboundReply(phone, now = new Date()) {
  const stopIds = await stopOnReplyCampaignIds();
  const stopped = await completeRepliedEnrollments(phone, stopIds);
  const resumed = await resumeWindowParkedEnrollments(phone, stopIds, now);
  if (stopped || resumed) {
    console.log(
      `[wati/webhook] reply from ${phone}: completed ${stopped} stop-on-reply enrollment(s), resumed ${resumed} window-parked enrollment(s)`
    );
  }
  return { stopped, resumed };
}

module.exports = {
  handleInboundReply,
  completeRepliedEnrollments,
  resumeWindowParkedEnrollments,
  stopOnReplyCampaignIds,
  LEGACY_WINDOW_PARK,
};
