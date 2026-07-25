const express = require("express");
const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const { enrollTargets, previewTargets, sendSingleMessage } = require("../lib/campaignEngine");
const whatsappProvider = require("../lib/whatsappProvider");
const { getSourceFields, DYNAMIC_PREFIX, DOCUMENT_PROJECTION } = require("../lib/sourceFields");
const { getSourceHandle, validateFilter } = require("../lib/sourceData");

const router = express.Router();

const VALUES_CAP = 200;

// Distinct values (+ counts) for one field of one source — powers the
// filter builder's value dropdown. `field` is checked against the source's
// real fields (a whitelist) before being interpolated into the aggregation
// pipeline.
async function distinctValues(source, field) {
  const fields = await getSourceFields(source);
  if (!fields) throw new Error(`Unknown source "${source}"`);
  if (!fields.some((f) => f.key === field)) {
    throw new Error(`Field "${field}" is not filterable for source "${source}"`);
  }

  const pipeline = [
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $match: { _id: { $nin: [null, ""] } } },
    { $sort: { count: -1 } },
    { $limit: VALUES_CAP },
  ];

  const handle = await getSourceHandle(source);
  const rows =
    handle.kind === "model"
      ? await handle.model.aggregate(pipeline)
      : await handle.collection.aggregate(pipeline).toArray();
  return rows.map((r) => ({ value: r._id, count: r.count }));
}

// Fields to return per document when listing members for the segment
// builder's live preview table — a fixed identity-column subset, independent
// of the full filterable field list from getSourceFields().
const MEMBER_PROJECTIONS = {
  Contact: "name phone caStatus city attempt potential status leadSource ownerName",
  Lead: "name phone email leadMagnet",
  AdMagnetStudent: { name: 1, email: 1, phoneNumber: 1, city: 1, caLevel: 1, attemptGiven: 1 },
};

// Paginated, actual matching documents for a source + filter — powers the
// segment builder's live members table (distinct from previewTargets, which
// only returns counts).
async function listMembers(source, filter, page, limit) {
  const skip = (page - 1) * limit;
  const handle = await getSourceHandle(source);

  if (handle.kind === "model") {
    const projection = MEMBER_PROJECTIONS[source] || "";
    const [members, total] = await Promise.all([
      handle.model.find(filter).select(projection).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      handle.model.countDocuments(filter),
    ]);
    return { members, total };
  }

  const projection = MEMBER_PROJECTIONS[source] || (source.startsWith(DYNAMIC_PREFIX) ? DOCUMENT_PROJECTION : null);
  const cursor = handle.collection.find(filter);
  if (projection) cursor.project(projection);
  const [members, total] = await Promise.all([
    cursor.skip(skip).limit(limit).toArray(),
    handle.collection.countDocuments(filter),
  ]);
  return { members, total };
}

// GET /api/campaigns/meta/members?source=...&filter=<json>&page=1&limit=50
router.get("/campaigns/meta/members", async (req, res) => {
  try {
    const source = req.query.source;
    const filter = await validateFilter(source, req.query.filter ? JSON.parse(req.query.filter) : {});
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const { members, total } = await listMembers(source, filter, page, limit);
    res.json({ members, total, page, pageSize: limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/campaigns/meta/templates — approved template list from the
// connected provider, for the campaign builder's template picker (instead
// of free-typing a name). Returns connected: false instead of erroring when
// nothing's connected, so the UI can point at the Integrations tab.
router.get("/campaigns/meta/templates", async (_req, res) => {
  try {
    if (!(await whatsappProvider.isConfigured())) {
      return res.json({ templates: [], connected: false });
    }
    const templates = await whatsappProvider.getTemplates();
    res.json({ templates, connected: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/campaigns/meta/channels — channels on the connected provider,
// for the campaign builder's "send from" picker.
router.get("/campaigns/meta/channels", async (_req, res) => {
  const connected = await whatsappProvider.isConfigured();
  const channels = connected ? await whatsappProvider.getChannels() : [];
  res.json({ channels, connected });
});

// GET /api/campaigns/meta/fields?source=Contact|Lead|AdMagnetStudent
router.get("/campaigns/meta/fields", async (req, res) => {
  const fields = await getSourceFields(req.query.source);
  if (!fields) return res.status(400).json({ error: `Unknown source "${req.query.source}"` });
  res.json({ fields });
});

// GET /api/campaigns/meta/values?source=...&field=...
router.get("/campaigns/meta/values", async (req, res) => {
  try {
    const values = await distinctValues(req.query.source, req.query.field);
    res.json({ values });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/campaigns — create a drip campaign.
// Body: { name, description?, targetModel: "Contact"|"Lead",
//         steps: [{ templateId, providerMeta? }] }
router.post("/campaigns", async (req, res) => {
  try {
    const campaign = await Campaign.create(req.body);
    res.status(201).json(campaign);
  } catch (err) {
    res.status(400).json({ error: "Failed to create campaign", detail: err.message });
  }
});

// GET /api/campaigns — list all campaigns with enrollment counts.
router.get("/campaigns", async (_req, res) => {
  const campaigns = await Campaign.find().sort({ createdAt: -1 }).lean();
  const counts = await CampaignEnrollment.aggregate([
    { $group: { _id: { campaign: "$campaign", status: "$status" }, count: { $sum: 1 } } },
  ]);
  const byCampaign = {};
  for (const c of counts) {
    const key = String(c._id.campaign);
    byCampaign[key] = byCampaign[key] || {};
    byCampaign[key][c._id.status] = c.count;
  }
  res.json(campaigns.map((c) => ({ ...c, enrollments: byCampaign[String(c._id)] || {} })));
});

// GET /api/campaigns/:id — single campaign detail.
router.get("/campaigns/:id", async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json(campaign);
});

// PATCH /api/campaigns/:id — update fields (e.g. { active: false } to pause sending).
router.patch("/campaigns/:id", async (req, res) => {
  try {
    const campaign = await Campaign.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ error: "Failed to update campaign", detail: err.message });
  }
});

// POST /api/campaigns/:id/preview — count-only dry run of an enroll (no writes).
// Body: { filter?: {...} } — same shape as /enroll. Returns matched/willEnroll/
// skipped counts so the UI can show them before the confirm dialog.
router.post("/campaigns/:id/preview", async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  try {
    const result = await previewTargets(campaign, req.body?.filter || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: "Preview failed", detail: err.message });
  }
});

// POST /api/campaigns/:id/enroll — enroll every target matching `filter` into this campaign.
// Body: { filter?: {...} }  e.g. { filter: { leadMagnet: "ca-guru-ai" } } or { filter: { caStatus: "Final" } }
// Already-enrolled targets are skipped (safe to call again with a wider filter).
router.post("/campaigns/:id/enroll", async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  try {
    const result = await enrollTargets(campaign, req.body?.filter || {});
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: "Enroll failed", detail: err.message });
  }
});

// POST /api/campaigns/send-message — send one WhatsApp template message to
// one phone number directly, no campaign or enrollment involved.
// Body: { phone, templateId, providerMeta?, channelId? }
router.post("/campaigns/send-message", async (req, res) => {
  try {
    const { phone, templateId, providerMeta, channelId } = req.body || {};
    if (!templateId) {
      return res.status(400).json({ error: "templateId is required" });
    }
    if (!(await whatsappProvider.isConfigured())) {
      return res.status(400).json({ error: "No WhatsApp provider connected — connect one from the Integrations tab" });
    }
    const result = await sendSingleMessage({ phone, templateId, providerMeta, channelId });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: "Send failed", detail: err.message });
  }
});

// GET /api/campaigns/:id/enrollments?status=active&page=1&limit=50
router.get("/campaigns/:id/enrollments", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const filter = { campaign: req.params.id };
  if (req.query.status) filter.status = req.query.status;

  const [enrollments, total] = await Promise.all([
    CampaignEnrollment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    CampaignEnrollment.countDocuments(filter),
  ]);
  res.json({ total, count: enrollments.length, page, pageSize: limit, enrollments });
});

// POST /api/campaigns/:id/enrollments/:enrollmentId/cancel — pull one target out of the drip.
router.post("/campaigns/:id/enrollments/:enrollmentId/cancel", async (req, res) => {
  const enrollment = await CampaignEnrollment.findOneAndUpdate(
    { _id: req.params.enrollmentId, campaign: req.params.id },
    { status: "cancelled" },
    { new: true }
  );
  if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });
  res.json(enrollment);
});

module.exports = router;
