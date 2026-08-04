const express = require("express");
const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const MessageEvent = require("../models/MessageEvent");
const { sendSingleMessage } = require("../lib/campaignEngine");
const { previewCampaignTargets, enrollCampaignTargets } = require("../lib/campaignTargets");
const whatsappProvider = require("../lib/whatsappProvider");
const DataSourceConnection = require("../models/DataSourceConnection");
const { getSourceFields, BUILT_IN_SOURCES, DYNAMIC_PREFIX, DOCUMENT_PROJECTION } = require("../lib/sourceFields");
const { getSourceHandle, validateFilter } = require("../lib/sourceData");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

const VALUES_CAP = 200;

// Attach each lead's WhatsApp delivery state to the enrollment rows being
// returned. The enrollment's own `status` only says how far the drip got
// ("completed" the instant the last step is handed to the provider) — whether
// the message actually landed, was read, or bounced lives in MessageEvent.
//
// Done as one aggregation over the page rather than per row: a page of 100
// leads would otherwise be 100 queries.
async function withDelivery(enrollments) {
  if (!enrollments.length) return enrollments;

  const ids = enrollments.map((e) => e._id);
  const rows = await MessageEvent.aggregate([
    { $match: { enrollment: { $in: ids } } },
    { $group: { _id: { enrollment: "$enrollment", status: "$status" }, count: { $sum: 1 }, last: { $max: "$receivedAt" } } },
  ]);

  const byEnrollment = new Map();
  for (const row of rows) {
    const key = String(row._id.enrollment);
    if (!byEnrollment.has(key)) byEnrollment.set(key, {});
    byEnrollment.get(key)[row._id.status] = { count: row.count, at: row.last };
  }

  return enrollments.map((e) => ({ ...e, delivery: byEnrollment.get(String(e._id)) || {} }));
}

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
// segment builder's live members table (distinct from the campaign preview,
// which only returns counts).
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

// GET  /api/campaigns/meta/members?source=...&filter=<json>&page=1&limit=50
// POST /api/campaigns/meta/members  { source, filter, page, limit }
//
// Same read either way. POST is what the UI uses: a segment filter with a
// large $in list overflows Node's 16KB header limit as a query string and
// the request is rejected with 431 before reaching this handler.
async function membersHandler(req, res) {
  const body = req.body || {};
  try {
    const source = body.source || req.query.source;
    const rawFilter = body.filter !== undefined ? body.filter : req.query.filter;
    const parsed = typeof rawFilter === "string" ? JSON.parse(rawFilter || "{}") : rawFilter || {};
    const filter = await validateFilter(source, parsed);
    const page = Math.max(1, parseInt(body.page ?? req.query.page, 10) || 1);
    const limit = Math.min(parseInt(body.limit ?? req.query.limit, 10) || 50, 200);

    const { members, total } = await listMembers(source, filter, page, limit);
    res.json({ members, total, page, pageSize: limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

router.get("/campaigns/meta/members", membersHandler);
router.post("/campaigns/meta/members", membersHandler);

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

// GET /api/campaigns/meta/sources — every source a campaign can target right
// now: the built-in ones plus every Data Source an admin has connected and
// left active, each with the label it was named on the Data Sources tab.
//
// This exists so the campaign builder's source picker renders what the backend
// reports rather than a literal list compiled into the frontend. Connecting a
// new lead-magnet database is meant to be pure configuration; a hardcoded
// picker made it a code change, which is the whole reason this endpoint is
// here rather than the two-item array it replaced.
router.get("/campaigns/meta/sources", async (_req, res) => {
  const connected = await DataSourceConnection.find({ active: true }).select("label").sort({ label: 1 }).lean();
  res.json({
    sources: [
      ...BUILT_IN_SOURCES,
      ...connected.map((ds) => ({ value: `${DYNAMIC_PREFIX}${ds._id}`, label: ds.label })),
    ],
  });
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

// A graph as a request body may express it: nodes and edges, nothing else.
// `versions` and `liveVersion` never arrive from a client (publish owns both),
// and an absent draft is an empty graph rather than an error, so a campaign
// can exist before its flow is drawn. What is *inside* the arrays is left to
// the model: the node `kind` enum, duplicate node ids and dangling edges are
// all rejected by the validators task 3 hung off the schema, which is the one
// place that check should live.
function normalizeGraph(graph) {
  if (graph === undefined || graph === null) return { nodes: [], edges: [] };
  if (typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error("draft must be an object shaped { nodes, edges }");
  }
  const { nodes = [], edges = [] } = graph;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new Error("draft.nodes and draft.edges must be arrays");
  }
  return { nodes, edges };
}

// Fields a PATCH may write. Everything else is either owned by another
// endpoint (versions/liveVersion by publish) or written by the engine
// (lastAutoEnroll*), and is refused rather than quietly dropped so a caller
// never believes it saved something it did not.
const PATCHABLE = ["name", "description", "channelId", "active", "autoEnroll", "autoEnrollFilter", "draft"];

// The graph-era shape of autoEnrollFilter: the set of source-node filters
// /enroll previewed and confirmed when auto-enroll was armed, e.g.
// { graphVersion, confirmedAt, sources: [{ nodeId, sourceId, filter }] }. The
// scheduler re-runs the live graph rather than replaying this value, so it is
// a record of what was confirmed and the marker that the campaign is armed at
// all. Validated anyway on the PATCH path, because that path is client
// writable and a stored filter must never name a field its source does not
// expose as filterable.
async function validateAutoEnrollFilter(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("autoEnrollFilter must be an object");
  }
  if (!Object.keys(value).length) return {}; // disarming
  if (!Array.isArray(value.sources)) {
    throw new Error("autoEnrollFilter must be shaped { sources: [{ nodeId, sourceId, filter }] } - the segment /enroll confirmed");
  }
  const sources = [];
  for (const entry of value.sources) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Each autoEnrollFilter source must be an object { nodeId, sourceId, filter }");
    }
    sources.push({
      nodeId: entry.nodeId,
      sourceId: entry.sourceId,
      filter: await validateFilter(entry.sourceId, entry.filter || {}),
    });
  }
  return { ...value, sources };
}

// A filter posted in the body used to be the segment. It is now a property of
// each source node in the published graph, so one arriving here would be
// silently ignored - and silently ignoring a narrowing filter means messaging
// a wider set of people than the caller asked for. Refused loudly instead. An
// empty filter asked for nothing, so a caller that always sends the key still
// works.
function assertNoBodyFilter(body) {
  const filter = body && body.filter;
  if (filter && typeof filter === "object" && Object.keys(filter).length) {
    throw new Error(
      "Filters live on each source node's config.filter in the campaign graph - edit the draft and publish, rather than posting a filter here"
    );
  }
}

// POST /api/campaigns - create a drip campaign.
// Body: { name, description?, channelId?, draft?: { nodes, edges } }
//
// The accepted fields are named rather than the body being handed to
// Campaign.create wholesale: `versions` and `liveVersion` belong to the
// publish endpoint alone, and `autoEnrollFilter` is only ever written by
// /enroll after a previewed, confirmed segment. Either one arriving in a
// create body would route around a rule the rest of this file spends its time
// enforcing.
//
// A new campaign is never live: `versions` starts empty and `liveVersion` stays
// null until the first publish, which is what makes "enroll a campaign nobody
// published" a detectable error instead of a silent run against a half-drawn
// draft.
router.post("/campaigns", async (req, res) => {
  try {
    const { name, description, channelId, draft } = req.body || {};
    const campaign = await Campaign.create({
      name,
      ...(description !== undefined ? { description } : {}),
      ...(channelId !== undefined ? { channelId } : {}),
      draft: normalizeGraph(draft),
    });
    res.status(201).json(campaign);
  } catch (err) {
    res.status(400).json({ error: "Failed to create campaign", detail: err.message });
  }
});

// GET /api/campaigns - list all campaigns with enrollment counts.
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

  // Delivery state per campaign, counted in distinct leads rather than events:
  // one lead who read a message three times is one read, not three.
  const deliveryRows = await MessageEvent.aggregate([
    { $match: { campaign: { $ne: null } } },
    { $group: { _id: { campaign: "$campaign", status: "$status" }, leads: { $addToSet: "$enrollment" } } },
  ]);
  const deliveryByCampaign = {};
  for (const row of deliveryRows) {
    const key = String(row._id.campaign);
    deliveryByCampaign[key] = deliveryByCampaign[key] || {};
    deliveryByCampaign[key][row._id.status] = row.leads.filter(Boolean).length;
  }

  res.json(
    campaigns.map((c) => {
      // nodeCount counts the draft, which is the graph an admin is working on
      // and the one the canvas shows; versionCount says how much of it has
      // been published. The published snapshots themselves are dropped from
      // the payload - every version of every campaign is a lot of graph to
      // ship to a view that renders one row each. GET /api/campaigns/:id and
      // /versions serve them.
      const { versions, ...campaign } = c;
      return {
        ...campaign,
        nodeCount: ((c.draft && c.draft.nodes) || []).length,
        versionCount: (versions || []).length,
        enrollments: byCampaign[String(c._id)] || {},
        delivery: deliveryByCampaign[String(c._id)] || {},
      };
    })
  );
});

// GET /api/campaigns/:id - single campaign detail, including the draft graph,
// every published version and which of them is live.
router.get("/campaigns/:id", async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json(campaign);
});

// PATCH /api/campaigns/:id - update a campaign's non-graph fields and its draft.
// Body: any of { name, description, channelId, active, autoEnroll,
//                autoEnrollFilter, draft: { nodes, edges } }
//   e.g. { active: false } to pause sending, { autoEnroll: false } to stop
//   rescanning the sources.
//
// Graph edits land on `draft` and nowhere else. An enrollment is walking a
// versions[] entry pinned by its graphVersion, so a PATCH that could reach one
// would be able to rewrite a flow under a lead already mid-drip - the exact
// failure the draft/publish split exists to make impossible. `versions` and
// `liveVersion` are refused here outright; only /publish writes them.
router.patch("/campaigns/:id", async (req, res) => {
  try {
    const body = { ...(req.body || {}) };

    for (const owned of ["versions", "liveVersion"]) {
      if (body[owned] !== undefined) {
        return res.status(400).json({ error: `"${owned}" is written by POST /api/campaigns/:id/publish, not by PATCH` });
      }
    }
    if (body.nodes !== undefined || body.edges !== undefined) {
      return res.status(400).json({ error: "Send graph edits as { draft: { nodes, edges } } - they only ever apply to the draft" });
    }
    const unsupported = Object.keys(body).filter((key) => !PATCHABLE.includes(key));
    if (unsupported.length) {
      return res.status(400).json({ error: `Unsupported field(s) for PATCH: ${unsupported.join(", ")}` });
    }

    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // Arming auto-enroll is the enroll endpoint's job, because that's the
    // only path where the segment being stored is one the admin previewed.
    // Turning it on here would run whatever autoEnrollFilter happens to be
    // on the document - `{}` on a campaign that never armed, i.e. everyone
    // in every source. Turning it *off* stays allowed: stopping is never the
    // risky direction. Read from the stored document before this body is
    // applied, so one request cannot supply a segment and arm it in the same
    // breath.
    if (body.autoEnroll === true && !Object.keys(campaign.autoEnrollFilter || {}).length) {
      return res.status(400).json({
        error: "Turn auto-enroll on from the send flow, so the segment it repeats is one you previewed",
      });
    }
    if (body.autoEnrollFilter !== undefined) {
      body.autoEnrollFilter = await validateAutoEnrollFilter(body.autoEnrollFilter);
    }

    if (body.draft !== undefined) campaign.draft = normalizeGraph(body.draft);
    for (const key of PATCHABLE) {
      if (key !== "draft" && body[key] !== undefined) campaign[key] = body[key];
    }

    // save() rather than findByIdAndUpdate: a document save runs the node
    // `kind` enum and the graph integrity validator (duplicate ids, dangling
    // edges) the model declares, and writes only the paths this handler
    // touched - versions[] is not even part of the update it sends.
    await campaign.save();
    res.json(campaign);
  } catch (err) {
    res.status(400).json({ error: "Failed to update campaign", detail: err.message });
  }
});

// POST /api/campaigns/:id/publish - snapshot the draft as a new version.
//
// Publishing appends; it never edits. The new entry takes the next sequential
// version number and becomes `liveVersion`, so enrollments created from now on
// pin to it, while every earlier entry is left exactly as it was. That is what
// lets a lead sitting on version 1 keep walking version 1 while the admin
// iterates towards version 2.
//
// The draft is copied, not moved: it stays as it is so editing continues from
// where it left off instead of restarting from an empty canvas after every
// publish.
router.post("/campaigns/:id/publish", async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  try {
    // Plain objects, detached from the draft's subdocuments, so that a later
    // edit of the draft cannot reach into the snapshot just published.
    const draft = campaign.toObject().draft || {};
    const version = (campaign.versions || []).reduce((highest, entry) => Math.max(highest, entry.version || 0), 0) + 1;

    campaign.versions.push({
      version,
      nodes: draft.nodes || [],
      edges: draft.edges || [],
      publishedAt: new Date(),
    });
    campaign.liveVersion = version;
    await campaign.save();

    const published = campaign.versions[campaign.versions.length - 1];
    res.status(201).json({
      version: published.version,
      publishedAt: published.publishedAt,
      nodes: published.nodes,
      edges: published.edges,
      liveVersion: campaign.liveVersion,
    });
  } catch (err) {
    res.status(400).json({ error: "Failed to publish campaign", detail: err.message });
  }
});

// GET /api/campaigns/:id/versions - publish history in publish order, for a
// version history / rollback picker. Counts rather than the graphs themselves:
// the full nodes/edges of every version come back from GET /api/campaigns/:id
// when something actually needs to render one.
router.get("/campaigns/:id/versions", async (req, res) => {
  const campaign = await Campaign.findById(req.params.id).select("versions liveVersion").lean();
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  res.json({
    liveVersion: campaign.liveVersion === undefined ? null : campaign.liveVersion,
    versions: (campaign.versions || []).map((entry) => ({
      version: entry.version,
      publishedAt: entry.publishedAt,
      nodeCount: (entry.nodes || []).length,
      edgeCount: (entry.edges || []).length,
    })),
  });
});

// DELETE /api/campaigns/:id — remove a campaign and every enrollment in it.
//
// The enrollments go too, deliberately. Left behind they would be both
// unreachable and permanently stalled: the poller loads each due enrollment's
// campaign per tick and skips it when the campaign is gone, so they would sit
// "active" forever without ever sending again.
//
// MessageEvents are kept. They record what WhatsApp actually reported for
// messages that really were sent, and deleting the campaign doesn't unsend
// them — the delivery log stays truthful about what reached people, even once
// the campaign that sent it is gone.
router.delete("/campaigns/:id", async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const { deletedCount } = await CampaignEnrollment.deleteMany({ campaign: campaign._id });
  await campaign.deleteOne();

  res.json({ deleted: true, name: campaign.name, enrollmentsDeleted: deletedCount || 0 });
});

// POST /api/campaigns/:id/preview - count-only dry run of an enroll (no writes).
// Body: none. Returns matched/willEnroll/skipped counts unioned across every
// source node of the published graph, plus the same counts per source node, so
// the UI can show them before the confirm dialog.
//
// Resolved against the graph /enroll would use (the live version), not against
// the draft. A draft that has since diverged from what is published would put
// a number on screen that the confirm button cannot deliver, which is worse
// than a stale one.
router.post("/campaigns/:id/preview", async (req, res) => {
  // lean(): there is no document here that could be saved, which is the
  // cheapest available guarantee that previewing writes nothing.
  const campaign = await Campaign.findById(req.params.id).lean();
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  try {
    assertNoBodyFilter(req.body);
    const result = await previewCampaignTargets(campaign);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: "Preview failed", detail: err.message });
  }
});

// POST /api/campaigns/:id/enroll - enroll everyone the published graph's source
// nodes match into this campaign.
// Body: { autoEnroll?: boolean }
//
// Each row is written with the targetModel of the source node that produced
// it, the campaign's liveVersion as its graphVersion, and the node its source
// node's outgoing edge points at as its currentNodeId. A campaign with no
// liveVersion is refused rather than enrolled against its draft: the row would
// pin to a version that does not exist and the walker would have nothing to
// walk. Already-enrolled targets are skipped, so re-running against a wider
// segment is safe.
//
// autoEnroll: true also stores the segment this run confirmed as the
// campaign's standing one, so the scheduler keeps rescanning and targets that
// reach a source later still join the drip. Arming happens here rather than on
// PATCH deliberately - what ends up armed is then always a segment the admin
// previewed and confirmed on a real send, never an empty "everyone" filter set
// by accident.
router.post("/campaigns/:id/enroll", async (req, res) => {
  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  try {
    assertNoBodyFilter(req.body);
    const result = await enrollCampaignTargets(campaign);
    if (req.body?.autoEnroll !== undefined) {
      campaign.autoEnroll = Boolean(req.body.autoEnroll);
      if (campaign.autoEnroll) {
        campaign.autoEnrollFilter = {
          graphVersion: result.graphVersion,
          confirmedAt: new Date(),
          sources: result.sources.map((s) => ({ nodeId: s.nodeId, sourceId: s.sourceId, filter: s.filter })),
        };
        campaign.lastAutoEnrollAt = new Date();
        campaign.lastAutoEnrollCount = result.enrolled;
        campaign.lastAutoEnrollError = null;
      }
      await campaign.save();
    }
    res.status(201).json({ ...result, autoEnroll: campaign.autoEnroll });
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
      .limit(limit)
      .lean(),
    CampaignEnrollment.countDocuments(filter),
  ]);

  res.json({
    total,
    count: enrollments.length,
    page,
    pageSize: limit,
    enrollments: await withDelivery(enrollments),
  });
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
