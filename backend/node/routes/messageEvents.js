const { Types } = require("mongoose");
const MessageEvent = require("../models/MessageEvent");
const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");
const { asyncRouter } = require("../lib/asyncRouter");
const { getAdapter } = require("../lib/campaignEngine");

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

// A target document is whatever the connected source happens to hold, and a
// `users` collection can carry password hashes, reset tokens and API keys.
// None of that belongs on a delivery screen, so anything that looks like a
// credential is dropped rather than trusting every source to be free of them.
const SENSITIVE_FIELD = /pass|hash|salt|token|secret|otp|api[-_]?key|credential|auth/i;

function safeFields(doc) {
  if (!doc) return null;
  // Serialising first turns ObjectIds and Dates into strings, so the UI gets
  // values it can render instead of driver objects.
  const plain = JSON.parse(JSON.stringify(doc));
  const out = {};
  for (const [key, value] of Object.entries(plain)) {
    if (key === "__v" || SENSITIVE_FIELD.test(key)) continue;
    out[key] = value;
  }
  return out;
}

// GET /api/enrollments/:id — everything known about one lead's place in a
// campaign: the enrollment, the campaign it belongs to, the lead record it
// targets, and every event recorded against it.
router.get("/enrollments/:id", async (req, res) => {
  const id = asObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid enrollment id" });

  const enrollment = await CampaignEnrollment.findById(id).lean();
  if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });

  const [campaign, events] = await Promise.all([
    Campaign.findById(enrollment.campaign).select("name targetModel steps channelId active").lean(),
    MessageEvent.find({ enrollment: id }).sort({ receivedAt: 1 }).select("-payload").lean(),
  ]);

  // The lead itself lives in whichever collection the campaign targets, so it
  // loads through the same adapter the engine sends through. A source that has
  // since been disconnected or deleted must not take the whole panel down —
  // report why the lead is missing and show everything else.
  let lead = null;
  let leadError = null;
  try {
    const adapter = await getAdapter(enrollment.targetModel);
    lead = safeFields(await adapter.findById(enrollment.targetId));
    if (!lead) leadError = "This lead no longer exists in the source collection";
  } catch (err) {
    leadError = err.message;
  }

  res.json({ enrollment, campaign, lead, leadError, events });
});

// GET /api/direct-messages/:id — the same detail for a hand-sent message.
// There is no lead record behind it: a manual send is addressed to a number,
// not to a row in a source collection.
router.get("/direct-messages/:id", async (req, res) => {
  const id = asObjectId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid message id" });

  const message = await DirectMessage.findById(id).lean();
  if (!message) return res.status(404).json({ error: "Message not found" });

  const events = await MessageEvent.find({ directMessage: id })
    .sort({ receivedAt: 1 })
    .select("-payload")
    .lean();

  res.json({ message, events });
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

// Group events into { <key>: { sent: n, delivered: n, ... } } by one field.
async function groupByField(match, field) {
  const out = new Map();
  const rows = await MessageEvent.aggregate([
    { $match: match },
    { $group: { _id: { key: `$${field}`, status: "$status" }, events: { $sum: 1 } } },
  ]);
  for (const row of rows) {
    const key = String(row._id.key);
    if (!out.has(key)) out.set(key, {});
    out.get(key)[row._id.status] = row.events;
  }
  return out;
}

// GET /api/sends — every message we have sent, campaign and manual alike,
// newest first.
//
// Sends live in two shapes: a step in a CampaignEnrollment's history, and a
// DirectMessage. $unionWith merges them so the sort and the paging happen in
// the database across the combined set — paging each collection separately and
// merging in JS would produce pages that are only locally ordered.
router.get("/sends", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const kind = req.query.kind === "campaign" || req.query.kind === "manual" ? req.query.kind : null;

  // Filtering before the $unwind/$project keeps it on an indexed field.
  const phoneMatch = req.query.phone ? [{ $match: { phone: new RegExp(escapeRegex(req.query.phone)) } }] : [];

  // One row per step actually sent. Steps a lead hasn't reached yet aren't
  // sends and have no history entry, so they correctly never appear.
  const campaignBranch = [
    ...phoneMatch,
    { $unwind: "$history" },
    {
      $project: {
        _id: 0,
        kind: "campaign",
        enrollmentId: "$_id",
        campaignId: "$campaign",
        stepIndex: "$history.stepIndex",
        phone: "$phone",
        templateId: "$history.templateId",
        sentAt: "$history.sentAt",
        status: "$history.status",
        error: "$history.error",
        providerMessageId: "$history.providerMessageId",
      },
    },
  ];

  const manualBranch = [
    ...phoneMatch,
    {
      $project: {
        _id: 0,
        kind: "manual",
        directMessageId: "$_id",
        phone: "$phone",
        templateId: "$templateId",
        sentAt: "$sentAt",
        status: "$status",
        error: "$error",
        providerMessageId: "$providerMessageId",
      },
    },
  ];

  const base = kind === "manual" ? DirectMessage : CampaignEnrollment;
  const stages =
    kind === "manual"
      ? manualBranch
      : kind === "campaign"
        ? campaignBranch
        : [...campaignBranch, { $unionWith: { coll: "directmessages", pipeline: manualBranch } }];

  const [result] = await base.aggregate([
    ...stages,
    { $sort: { sentAt: -1 } },
    {
      $facet: {
        rows: [{ $skip: (page - 1) * limit }, { $limit: limit }],
        total: [{ $count: "n" }],
      },
    },
  ]);

  const rows = result?.rows || [];
  const total = result?.total?.[0]?.n || 0;

  // Delivery, as precisely as each row allows.
  //
  // A row that knows its own provider message id gets the events for THAT
  // message and nothing else. Rows without one — sends made before ids were
  // recorded — fall back to their enrollment or direct-message link. That
  // fallback is exact for a single-step enrollment and a summary across steps
  // for a multi-step one, which is the best that can be said when the send
  // never recorded which message it was.
  const wamids = [...new Set(rows.filter((r) => r.providerMessageId).map((r) => r.providerMessageId))];
  const enrollmentIds = rows.filter((r) => !r.providerMessageId && r.enrollmentId).map((r) => r.enrollmentId);
  const directIds = rows.filter((r) => !r.providerMessageId && r.directMessageId).map((r) => r.directMessageId);

  const [byWamid, byEnrollment, byDirect, campaigns] = await Promise.all([
    wamids.length ? groupByField({ providerMessageId: { $in: wamids } }, "providerMessageId") : new Map(),
    enrollmentIds.length ? groupByField({ enrollment: { $in: enrollmentIds } }, "enrollment") : new Map(),
    directIds.length ? groupByField({ directMessage: { $in: directIds } }, "directMessage") : new Map(),
    Campaign.find({ _id: { $in: rows.filter((r) => r.campaignId).map((r) => r.campaignId) } })
      .select("name")
      .lean(),
  ]);

  const campaignName = new Map(campaigns.map((c) => [String(c._id), c.name]));

  res.json({
    total,
    count: rows.length,
    page,
    pageSize: limit,
    funnelOrder: FUNNEL_ORDER,
    sends: rows.map((r) => ({
      ...r,
      // The table keys on _id; a campaign send is identified by which step of
      // which enrollment it was, since one enrollment holds several sends.
      _id: r.kind === "campaign" ? `${r.enrollmentId}-${r.stepIndex}` : String(r.directMessageId),
      campaignName: r.campaignId ? campaignName.get(String(r.campaignId)) || null : null,
      delivery: r.providerMessageId
        ? byWamid.get(r.providerMessageId) || {}
        : r.enrollmentId
          ? byEnrollment.get(String(r.enrollmentId)) || {}
          : byDirect.get(String(r.directMessageId)) || {},
    })),
  });
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
