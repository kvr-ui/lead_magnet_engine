const { isValidObjectId } = require("mongoose");
const Campaign = require("../models/Campaign");
const { asyncRouter } = require("../lib/asyncRouter");
const {
  campaignActivity,
  activitySummary,
  getActivitySource,
  leadActivityDetail,
  DEFAULT_WINDOW_HOURS,
} = require("../lib/leadActivity");

const router = asyncRouter();

// A window of 0 means "no limit" and is a deliberate choice, not a missing
// value — so only an absent/blank parameter falls back to the default.
function parseWindow(raw) {
  if (raw === undefined || raw === "") return DEFAULT_WINDOW_HOURS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WINDOW_HOURS;
  return n;
}

// GET /api/campaigns/:id/activity?windowHours=168
// What the leads this campaign messaged went on to do in the lead magnet
// afterwards — the step past delivery. Returns configured:false when no data
// source has an activity collection set up, so the UI can say so rather than
// showing a confident zero.
router.get("/campaigns/:id/activity", async (req, res) => {
  // Checked rather than left to findById, which throws a CastError on a
  // malformed id and would surface as a 500 for what is a bad request.
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid campaign id" });

  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const result = await campaignActivity(campaign, { windowHours: parseWindow(req.query.windowHours) });
  res.json(result);
});

// GET /api/campaigns/:id/activity/:leadKey?windowHours=168
// Every question one lead answered after this campaign messaged them — the
// wording, what they picked, what was right, and whether they got it. Scoped
// to the same send and window as the row it expands, so the questions listed
// always add up to the count shown against that lead.
router.get("/campaigns/:id/activity/:leadKey", async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid campaign id" });

  const campaign = await Campaign.findById(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  const result = await leadActivityDetail(campaign, req.params.leadKey, {
    windowHours: parseWindow(req.query.windowHours),
  });
  if (result.configured && !result.found) {
    return res.status(404).json({ error: "This campaign has no send on record for that lead" });
  }
  res.json(result);
});

// GET /api/activity/summary?windowHours=168 — the same measure across every
// campaign at once, each activated lead credited to exactly one of them.
router.get("/activity/summary", async (req, res) => {
  const result = await activitySummary({ windowHours: parseWindow(req.query.windowHours) });
  res.json(result);
});

// GET /api/activity/source — which data source activity is being read from,
// for the UI to name it (and to explain itself when nothing is configured).
router.get("/activity/source", async (_req, res) => {
  const source = await getActivitySource();
  if (!source) return res.json({ configured: false, defaultWindowHours: DEFAULT_WINDOW_HOURS });
  res.json({
    configured: true,
    defaultWindowHours: DEFAULT_WINDOW_HOURS,
    source: {
      id: String(source._id),
      label: source.label,
      collection: source.activity.collection,
      timestampField: source.activity.timestampField,
      noun: source.activity.noun || "activity",
    },
  });
});

module.exports = router;
