const MessageEvent = require("../models/MessageEvent");
const { cleanPhone } = require("./phone");

/**
 * Whether a phone number's WhatsApp customer-service window is open.
 *
 * Meta allows a free-typed ("session") message only within 24 hours of the
 * customer's last inbound message; outside that window the only thing that can
 * be sent is an approved template. A window is opened by exactly one thing —
 * the customer messaging us — and by nothing else. A lead appearing in a CRM or
 * a lead-magnet database does not open one: Meta never saw that row.
 *
 * Nothing new is recorded to answer this. Every inbound message already lands
 * as a MessageEvent with status "received" and a receivedAt, keyed on a phone
 * cleaned by the same cleanPhone() used here (routes/wati.js), so the two sides
 * match exactly. Two properties of that model make the log trustworthy for this
 * purpose, and both are deliberate:
 *
 *   - "received" is excluded from the dedupe index, so a lead who answers three
 *     times keeps all three rows rather than collapsing to the first.
 *   - Inbound traffic that matches no enrollment is kept and simply reads as
 *     unattributed, so a chatbot reply or a message about something else still
 *     counts. That is correct: the window belongs to the phone number, not to
 *     a campaign.
 *
 * The window is DERIVED on each read rather than stored as a flag. Nothing
 * emits an event when a window expires — it just runs out — so a stored flag
 * would need a sweeper to clear it, and any gap in that sweeper leaves stale
 * "open" flags that make us attempt a free-form send into a closed window. A
 * timestamp answers the question by itself and cannot go stale.
 *
 * Unknown reads as CLOSED. A phone we have never seen an inbound message from,
 * or one whose events never arrived because the webhook was down, is treated as
 * template-only. That is the safe direction: sending a template when a session
 * message would have been allowed costs slightly more, while the inverse would
 * be rejected by the provider.
 */

const WINDOW_HOURS = Number(process.env.SESSION_WINDOW_HOURS) > 0 ? Number(process.env.SESSION_WINDOW_HOURS) : 24;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;

function resolveNow(now) {
  if (now instanceof Date) return now;
  if (now === undefined || now === null) return new Date();
  return new Date(now);
}

/**
 * Latest inbound instant for many numbers at once, as a Map of cleaned phone
 * to Date. One aggregation for the whole set — the members table calls this
 * with a page of 50 rows, and a per-row query would be 50 round trips.
 *
 * Input may be raw source values in any format the source happens to store
 * ("+91 98765 43210", 9876543210 as a number); they are cleaned here so the
 * caller does not have to know. Values that clean to nothing are dropped.
 */
async function lastInboundFor(phones) {
  const cleaned = [...new Set((Array.isArray(phones) ? phones : []).map((p) => cleanPhone(p)).filter(Boolean))];
  if (!cleaned.length) return new Map();

  const rows = await MessageEvent.aggregate([
    { $match: { phone: { $in: cleaned }, status: "received" } },
    { $group: { _id: "$phone", lastInboundAt: { $max: "$receivedAt" } } },
  ]);

  return new Map(rows.map((r) => [r._id, r.lastInboundAt]));
}

/** Latest inbound instant for one number, or null if it has never messaged us. */
async function lastInboundAt(phone) {
  const cleaned = cleanPhone(phone);
  if (!cleaned) return null;
  const row = await MessageEvent.findOne({ phone: cleaned, status: "received" })
    .sort({ receivedAt: -1 })
    .select("receivedAt")
    .lean();
  return row ? row.receivedAt : null;
}

/**
 * The shape the API and UI speak in. Kept as one function so "open" is decided
 * in a single place rather than by each caller comparing timestamps its own way.
 */
function describeWindow(at, now) {
  const asOf = resolveNow(now);
  if (!at) return { open: false, lastInboundAt: null, expiresAt: null, msRemaining: 0, everMessaged: false };
  const expiresAt = new Date(new Date(at).getTime() + WINDOW_MS);
  const msRemaining = expiresAt.getTime() - asOf.getTime();
  return {
    open: msRemaining > 0,
    lastInboundAt: at,
    expiresAt,
    msRemaining: Math.max(0, msRemaining),
    everMessaged: true,
  };
}

/** True when this number can be sent a free-typed message right now. */
async function isWindowOpen(phone, now) {
  return describeWindow(await lastInboundAt(phone), now).open;
}

/**
 * Every number whose window is currently open, cleaned.
 *
 * This set is always small and self-limiting — it can only contain people who
 * messaged us in the last 24 hours — which is what makes "show me only
 * open-window leads" cheap to answer across a whole source: resolve this short
 * list first, then read only those leads, instead of scanning every lead and
 * asking about each one.
 */
async function openWindowPhones(now) {
  const cutoff = new Date(resolveNow(now).getTime() - WINDOW_MS);
  return MessageEvent.distinct("phone", { status: "received", receivedAt: { $gte: cutoff } });
}

module.exports = {
  WINDOW_HOURS,
  WINDOW_MS,
  lastInboundFor,
  lastInboundAt,
  isWindowOpen,
  openWindowPhones,
  describeWindow,
};
