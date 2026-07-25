const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const Contact = require("../models/Contact");
const Lead = require("../models/Lead");
const wati = require("./watiClient");

const MODELS = { Contact, Lead };

// How many due enrollments to send per poll tick, and the gap between sends —
// keeps us well under WATI's rate limits instead of firing a burst.
const BATCH_SIZE = parseInt(process.env.CAMPAIGN_BATCH_SIZE, 10) || 20;
const SEND_GAP_MS = parseInt(process.env.CAMPAIGN_SEND_GAP_MS, 10) || 1000;
const POLL_INTERVAL_MS = parseInt(process.env.CAMPAIGN_POLL_INTERVAL_MS, 10) || 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolve a step's template params against the enrolled target document
// (Contact or Lead) — "field" params pull a property off it, "static" params
// are used verbatim.
function resolveParams(step, targetDoc) {
  return (step.params || []).map((p) => {
    if (p.type === "static") return p.value;
    const v = targetDoc?.[p.value];
    return v === undefined || v === null ? "" : String(v);
  });
}

// Bulk-enroll every target matching `filter` (a plain Mongo query against the
// campaign's targetModel collection) into `campaign`. Re-running with a
// broader filter is safe — already-enrolled targets are skipped, not restarted.
async function enrollTargets(campaign, filter) {
  const Model = MODELS[campaign.targetModel];
  if (!Model) throw new Error(`Unknown targetModel: ${campaign.targetModel}`);

  const targets = await Model.find(filter || {}).select("_id phone").lean();
  const withPhone = targets.filter((t) => t.phone);

  const firstStep = campaign.steps[0];
  const now = new Date();
  const nextSendAt = new Date(now.getTime() + (firstStep.delayHours || 0) * 3600 * 1000);

  const ops = withPhone.map((t) => ({
    updateOne: {
      filter: { campaign: campaign._id, targetModel: campaign.targetModel, targetId: t._id },
      update: {
        $setOnInsert: {
          campaign: campaign._id,
          targetModel: campaign.targetModel,
          targetId: t._id,
          phone: t.phone,
          status: "active",
          currentStepIndex: 0,
          nextSendAt,
          history: [],
        },
      },
      upsert: true,
    },
  }));

  if (!ops.length) return { matched: targets.length, skippedNoPhone: targets.length - withPhone.length, enrolled: 0 };

  const CHUNK = 1000;
  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const res = await CampaignEnrollment.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    upserted += res.upsertedCount || 0;
  }
  return { matched: targets.length, skippedNoPhone: targets.length - withPhone.length, enrolled: upserted };
}

// Send the current step's message for one enrollment, then advance it to the
// next step (or mark it completed if that was the last one).
async function advanceEnrollment(enrollment, campaign) {
  const step = campaign.steps[enrollment.currentStepIndex];
  const Model = MODELS[enrollment.targetModel];
  const targetDoc = await Model.findById(enrollment.targetId).lean();

  if (!targetDoc) {
    enrollment.status = "failed";
    enrollment.history.push({
      stepIndex: enrollment.currentStepIndex,
      templateName: step.templateName,
      sentAt: new Date(),
      status: "error",
      error: "Target document no longer exists",
    });
    await enrollment.save();
    return;
  }

  try {
    await wati.sendTemplateMessage({
      phone: enrollment.phone,
      templateName: step.templateName,
      broadcastName: step.broadcastName,
      params: resolveParams(step, targetDoc),
    });
    enrollment.history.push({
      stepIndex: enrollment.currentStepIndex,
      templateName: step.templateName,
      sentAt: new Date(),
      status: "sent",
    });

    const nextIndex = enrollment.currentStepIndex + 1;
    const nextStep = campaign.steps[nextIndex];
    if (nextStep) {
      enrollment.currentStepIndex = nextIndex;
      enrollment.nextSendAt = new Date(Date.now() + (nextStep.delayHours || 0) * 3600 * 1000);
    } else {
      enrollment.status = "completed";
    }
  } catch (err) {
    enrollment.history.push({
      stepIndex: enrollment.currentStepIndex,
      templateName: step.templateName,
      sentAt: new Date(),
      status: "error",
      error: err.message,
    });
    enrollment.status = "failed";
  }

  await enrollment.save();
}

// One poll tick: find due, active enrollments (campaign still active) and
// send/advance each in turn, spaced out to respect WATI's rate limits.
async function processDueEnrollments() {
  if (!wati.isConfigured()) return { processed: 0, skipped: "WATI not configured" };

  const due = await CampaignEnrollment.find({ status: "active", nextSendAt: { $lte: new Date() } })
    .sort({ nextSendAt: 1 })
    .limit(BATCH_SIZE);

  let processed = 0;
  for (const enrollment of due) {
    const campaign = await Campaign.findById(enrollment.campaign);
    if (!campaign || !campaign.active) continue; // paused/deleted campaign — leave enrollment as-is
    await advanceEnrollment(enrollment, campaign);
    processed++;
    if (due.indexOf(enrollment) < due.length - 1) await sleep(SEND_GAP_MS);
  }
  return { processed };
}

let pollHandle = null;

function startScheduler() {
  if (pollHandle) return;
  if (!wati.isConfigured()) {
    console.log("[campaignEngine] WATI_API_ENDPOINT/WATI_API_TOKEN not set — drip campaign sending disabled");
    return;
  }
  pollHandle = setInterval(() => {
    processDueEnrollments().catch((err) => console.error("[campaignEngine] poll error:", err.message));
  }, POLL_INTERVAL_MS);
  console.log(`[campaignEngine] polling every ${POLL_INTERVAL_MS}ms for due drip messages`);
}

module.exports = { enrollTargets, processDueEnrollments, startScheduler };
