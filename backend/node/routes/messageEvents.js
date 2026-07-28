const { Types } = require("mongoose");
const MessageEvent = require("../models/MessageEvent");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

// Read side of the WhatsApp message tracking that routes/wati.js writes.
//
// Mounted behind admin auth, unlike the webhook itself — the webhook has to
// stay open for WATI to reach it, so nothing that reads the data back belongs
// in that router.

// The delivery funnel, widest first. These are not mutually exclusive: a lead
// who read a message also had it delivered, so it appears in both stages.
// "received" (inbound messages from the lead) sits outside the funnel — it
// counts their traffic, not the fate of ours.
const FUNNEL_ORDER = ["sent", "delivered", "read", "replied"];
const OUTCOME_ORDER = [...FUNNEL_ORDER, "failed", "received", "unknown"];

const asObjectId = (v) => (Types.ObjectId.isValid(v) ? new Types.ObjectId(v) : null);

// Roll a set of events up into { sent: n, delivered: n, ... } counting both
// raw events and the distinct leads behind them. Leads is the number worth
// showing: three read receipts for one lead is one lead who read.
async function rollup(match, groupBy) {
  const rows = await MessageEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: { key: groupBy ? `$${groupBy}` : null, status: "$status" },
        events: { $sum: 1 },
        leads: { $addToSet: "$enrollment" },
      },
    },
  ]);

  const out = new Map();
  for (const row of rows) {
    const key = String(row._id.key ?? "all");
    if (!out.has(key)) out.set(key, {});
    // A null enrollment means the event matched no campaign, so it contributes
    // events but no identifiable lead.
    out.get(key)[row._id.status] = {
      events: row.events,
      leads: row.leads.filter(Boolean).length,
    };
  }
  return out;
}

// Fill in the statuses that produced no events at all, so the UI always gets a
// complete shape and never has to guess whether a zero means "none" or "not
// reported".
function withZeroes(counts = {}) {
  const full = {};
  for (const status of OUTCOME_ORDER) {
    full[status] = counts[status] || { events: 0, leads: 0 };
  }
  return full;
}

// GET /api/campaigns/:id/delivery — the funnel for one campaign.
router.get("/campaigns/:id/delivery", async (req, res) => {
  const campaign = asObjectId(req.params.id);
  if (!campaign) return res.status(400).json({ error: "Invalid campaign id" });

  const [counts, enrolled, attempted] = await Promise.all([
    rollup({ campaign }),
    CampaignEnrollment.countDocuments({ campaign }),
    // Leads the engine has actually tried to send to. This is the funnel's
    // real denominator — enrolled-but-not-yet-sent leads would otherwise read
    // as delivery failures.
    CampaignEnrollment.countDocuments({ campaign, "history.0": { $exists: true } }),
  ]);

  res.json({
    campaign: req.params.id,
    enrolled,
    attempted,
    funnelOrder: FUNNEL_ORDER,
    counts: withZeroes(counts.get("all")),
  });
});

// GET /api/enrollments/:id/events — full event timeline for one lead, oldest
// first so it reads as a story.
router.get("/enrollments/:id/events", async (req, res) => {
  const enrollment = asObjectId(req.params.id);
  if (!enrollment) return res.status(400).json({ error: "Invalid enrollment id" });

  const events = await MessageEvent.find({ enrollment })
    .sort({ receivedAt: 1 })
    .select("-payload") // the raw provider blob is large and nothing renders it
    .lean();

  res.json({ count: events.length, events });
});

// GET /api/direct-messages — manual single-number sends, newest first, each
// with whatever WhatsApp has reported back about it.
//
// The campaign funnel counts distinct leads because one lead can generate three
// read receipts. Here each row IS one message, so the counts are plain event
// counts and no de-duplication by person is wanted.
router.get("/direct-messages", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const filter = {};
  if (req.query.phone) filter.phone = new RegExp(escapeRegex(req.query.phone));

  const [messages, total] = await Promise.all([
    DirectMessage.find(filter)
      .sort({ sentAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    DirectMessage.countDocuments(filter),
  ]);

  // One aggregate for the whole page rather than a query per row.
  const rows = messages.length
    ? await MessageEvent.aggregate([
        { $match: { directMessage: { $in: messages.map((m) => m._id) } } },
        { $group: { _id: { id: "$directMessage", status: "$status" }, events: { $sum: 1 } } },
      ])
    : [];

  const byMessage = new Map();
  for (const row of rows) {
    const key = String(row._id.id);
    if (!byMessage.has(key)) byMessage.set(key, {});
    byMessage.get(key)[row._id.status] = row.events;
  }

  res.json({
    total,
    count: messages.length,
    page,
    pageSize: limit,
    funnelOrder: FUNNEL_ORDER,
    messages: messages.map((m) => ({ ...m, delivery: byMessage.get(String(m._id)) || {} })),
  });
});

// GET /api/direct-messages/:id/events — the same audit trail the enrollment
// timeline shows, for one hand-sent message.
router.get("/direct-messages/:id/events", async (req, res) => {
  const directMessage = asObjectId(req.params.id);
  if (!directMessage) return res.status(400).json({ error: "Invalid message id" });

  const events = await MessageEvent.find({ directMessage })
    .sort({ receivedAt: 1 })
    .select("-payload")
    .lean();

  res.json({ count: events.length, events });
});

// GET /api/message-events — raw feed, newest first. The debugging view: shows
// unattributed traffic (chatbot replies, manual sends) alongside campaign
// events, which a campaign-scoped view by definition cannot.
router.get("/message-events", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.phone) filter.phone = new RegExp(escapeRegex(req.query.phone));
  if (req.query.eventType) filter.eventType = req.query.eventType;
  if (req.query.campaign) {
    const campaign = asObjectId(req.query.campaign);
    if (!campaign) return res.status(400).json({ error: "Invalid campaign id" });
    filter.campaign = campaign;
  } else if (req.query.linked === "yes") {
    filter.$or = [{ campaign: { $ne: null } }, { directMessage: { $ne: null } }];
  } else if (req.query.linked === "no") {
    // Exactly the events that attached to nothing we sent — the first thing to
    // look at when tracking looks wrong. A manual send counts as attached, so
    // both links have to be absent before an event is genuinely orphaned.
    filter.campaign = null;
    filter.directMessage = null;
  }

  const [events, total] = await Promise.all([
    MessageEvent.find(filter)
      .sort({ receivedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("campaign", "name")
      .select("-payload")
      .lean(),
    MessageEvent.countDocuments(filter),
  ]);

  res.json({ total, count: events.length, page, pageSize: limit, events });
});

// GET /api/message-events/stats — headline numbers for the feed.
router.get("/message-events/stats", async (_req, res) => {
  const [counts, total, unlinked] = await Promise.all([
    rollup({}),
    MessageEvent.countDocuments({}),
    MessageEvent.countDocuments({ campaign: null, directMessage: null }),
  ]);

  res.json({
    total,
    linked: total - unlinked,
    unlinked,
    counts: withZeroes(counts.get("all")),
  });
});

// A phone filter is a user-typed substring; without escaping, a stray "(" or
// "+" makes an invalid regex and 500s the request.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = router;
module.exports.FUNNEL_ORDER = FUNNEL_ORDER;
module.exports.OUTCOME_ORDER = OUTCOME_ORDER;
