const CampaignEnrollment = require("../models/CampaignEnrollment");
const Campaign = require("../models/Campaign");
const { isSendingEnabled, setSendingEnabled } = require("../lib/sendingSwitch");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

// How many leads would start going out the moment sending is switched on —
// shown next to the toggle so turning it on is never a blind action.
async function queuedCount() {
  const activeCampaignIds = await Campaign.find({ active: true }).distinct("_id");
  if (!activeCampaignIds.length) return 0;
  return CampaignEnrollment.countDocuments({
    status: "active",
    campaign: { $in: activeCampaignIds },
    nextSendAt: { $lte: new Date() },
  });
}

// GET /api/settings/sending — { enabled, queued }
router.get("/settings/sending", async (_req, res) => {
  const [enabled, queued] = await Promise.all([isSendingEnabled(), queuedCount()]);
  res.json({ enabled, queued });
});

// POST /api/settings/sending { enabled: true|false } — the global kill switch.
// Off means no WhatsApp message leaves this system by any path; campaigns can
// still be built, previewed and enrolled against.
router.post("/settings/sending", async (req, res) => {
  if (typeof req.body?.enabled !== "boolean") {
    return res.status(400).json({ error: "enabled must be true or false" });
  }
  const enabled = await setSendingEnabled(req.body.enabled);
  console.log(`[settings] sending switched ${enabled ? "ON — messages will go out for real" : "OFF (test mode)"}`);
  res.json({ enabled, queued: await queuedCount() });
});

module.exports = router;
