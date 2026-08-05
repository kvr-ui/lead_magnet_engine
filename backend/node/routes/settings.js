const CampaignEnrollment = require("../models/CampaignEnrollment");
const Campaign = require("../models/Campaign");
const { isSendingEnabled, setSendingEnabled } = require("../lib/sendingSwitch");
const { getSendPolicy, setSendPolicy, validatePolicyPatch } = require("../lib/sendPolicy");
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

// GET /api/settings/send-policy — the account-wide send policy (task 7,
// lib/sendPolicy.js): a frequency cap and quiet-hours window enforced across
// every campaign for one phone number, plus the manual-send toggle. Always
// returns a complete, normalized policy — never 404s — because a fresh
// install with no row saved yet is a perfectly good "off" answer, not an
// error.
router.get("/settings/send-policy", async (_req, res) => {
  res.json(await getSendPolicy());
});

// POST /api/settings/send-policy — a partial patch, merged onto the current
// policy the same way setSendPolicy() always has (shallow keys overwrite,
// maxPerContact/quietHours merge field-by-field). All validation is
// delegated to lib/sendPolicy.js's validatePolicyPatch: this route never
// re-implements or second-guesses what a well-formed policy looks like, so
// the admin UI and the walker can never drift apart on that question.
router.post("/settings/send-policy", async (req, res) => {
  const errors = validatePolicyPatch(req.body);
  if (errors.length) {
    return res.status(400).json({ error: errors.join("; ") });
  }
  res.json(await setSendPolicy(req.body));
});

module.exports = router;
