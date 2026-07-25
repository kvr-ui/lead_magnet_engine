const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const Contact = require("../models/Contact");
const Lead = require("../models/Lead");
const { getAdMagnetConnection } = require("../db");
const { cleanPhone } = require("./phone");
const whatsappProvider = require("./whatsappProvider");
const { DYNAMIC_PREFIX } = require("./sourceFields");

// How many due enrollments to send per poll tick, and the gap between sends —
// keeps us well under the connected provider's rate limits instead of firing
// a burst.
const BATCH_SIZE = parseInt(process.env.CAMPAIGN_BATCH_SIZE, 10) || 20;
const SEND_GAP_MS = parseInt(process.env.CAMPAIGN_SEND_GAP_MS, 10) || 1000;
const POLL_INTERVAL_MS = parseInt(process.env.CAMPAIGN_POLL_INTERVAL_MS, 10) || 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function adMagnetCollection() {
  const conn = getAdMagnetConnection();
  if (!conn) throw new Error("AD_MAGNET_MONGODB_URI not configured — AdMagnetStudent target unavailable");
  return conn.db.collection("users");
}

// One adapter per target source, so enroll/send logic doesn't care whether
// the target is a Mongoose model (Contact, Lead) or a raw collection on the
// separate, read-only ad-magnet connection (AdMagnetStudent — CA Guru's
// `users`, which uses `phoneNumber` instead of `phone` and has no schema here).
const adapters = {
  Contact: {
    async find(filter) {
      const docs = await Contact.find(filter || {}).select("_id phone").lean();
      return docs.map((d) => ({ _id: d._id, phone: d.phone }));
    },
    findById: (id) => Contact.findById(id).lean(),
  },
  Lead: {
    async find(filter) {
      const docs = await Lead.find(filter || {}).select("_id phone").lean();
      return docs.map((d) => ({ _id: d._id, phone: d.phone }));
    },
    findById: (id) => Lead.findById(id).lean(),
  },
  AdMagnetStudent: {
    async find(filter) {
      const docs = await adMagnetCollection().find(filter || {}).project({ phoneNumber: 1 }).toArray();
      return docs.map((d) => ({ _id: d._id, phone: d.phoneNumber }));
    },
    async findById(id) {
      const doc = await adMagnetCollection().findOne({ _id: id });
      return doc ? { ...doc, phone: doc.phoneNumber } : null;
    },
  },
};

// Candidate field names (checked case-insensitively against the connection's
// discovered fields) for the phone number on a user-connected Data Source —
// there's no per-connection config for this, so it's guessed from common
// naming conventions.
const PHONE_FIELD_CANDIDATES = ["phone", "phonenumber", "mobile", "mobilenumber", "contactnumber", "whatsappnumber"];

function guessPhoneField(fieldsCache) {
  const byLower = new Map((fieldsCache || []).map((k) => [k.toLowerCase(), k]));
  for (const candidate of PHONE_FIELD_CANDIDATES) {
    if (byLower.has(candidate)) return byLower.get(candidate);
  }
  return null;
}

// User-connected Data Source ("datasource:<id>") — same shape as the static
// adapters above, but built on demand since which collection holds the
// target isn't known ahead of time.
async function dynamicAdapter(targetModel) {
  const id = targetModel.slice(DYNAMIC_PREFIX.length);
  const DataSourceConnection = require("../models/DataSourceConnection");
  const { getConnectionFor } = require("./dataSourcePool");

  const doc = await DataSourceConnection.findById(id);
  if (!doc || !doc.active) throw new Error("Unknown or inactive data source");
  const phoneField = guessPhoneField(doc.fieldsCache);
  if (!phoneField) throw new Error(`Couldn't find a phone field on data source "${doc.label}"`);

  const conn = await getConnectionFor(doc);
  const collection = conn.db.collection(doc.collectionName);

  return {
    async find(filter) {
      const docs = await collection.find(filter || {}).project({ [phoneField]: 1 }).toArray();
      return docs.map((d) => ({ _id: d._id, phone: d[phoneField] }));
    },
    async findById(id) {
      const doc = await collection.findOne({ _id: id });
      return doc ? { ...doc, phone: doc[phoneField] } : null;
    },
  };
}

async function getAdapter(targetModel) {
  if (targetModel.startsWith(DYNAMIC_PREFIX)) return dynamicAdapter(targetModel);
  const adapter = adapters[targetModel];
  if (!adapter) throw new Error(`Unknown targetModel: ${targetModel}`);
  return adapter;
}

// Shared by previewTargets (read-only) and enrollTargets (writes): finds
// everything matching `filter`, cleans phone numbers, and checks which are
// already enrolled in this campaign.
async function matchTargets(campaign, filter) {
  const adapter = await getAdapter(campaign.targetModel);
  const targets = await adapter.find(filter || {});
  const matched = targets.length;

  let skippedNoPhone = 0;
  let skippedBadPhone = 0;
  const cleaned = [];
  for (const t of targets) {
    if (!t.phone) {
      skippedNoPhone++;
      continue;
    }
    const phone = cleanPhone(t.phone);
    if (!phone) {
      skippedBadPhone++;
      continue;
    }
    cleaned.push({ _id: t._id, phone });
  }

  const existing = await CampaignEnrollment.find({
    campaign: campaign._id,
    targetModel: campaign.targetModel,
    targetId: { $in: cleaned.map((c) => c._id) },
  })
    .select("targetId")
    .lean();
  const existingIds = new Set(existing.map((e) => String(e.targetId)));
  const willEnroll = cleaned.filter((c) => !existingIds.has(String(c._id))).length;

  return {
    matched,
    skippedNoPhone,
    skippedBadPhone,
    alreadyEnrolled: cleaned.length - willEnroll,
    willEnroll,
    cleaned, // internal — enrollTargets uses this to build write ops
  };
}

// Read-only: same matching/counting as enrollTargets, no writes. Powers the
// UI's preview step before the actual "Send Campaign" confirm.
async function previewTargets(campaign, filter) {
  const { cleaned, ...counts } = await matchTargets(campaign, filter);
  return counts;
}

// Bulk-enroll every target matching `filter` into `campaign`. Re-running with
// a broader filter is safe — already-enrolled targets are skipped, not restarted.
async function enrollTargets(campaign, filter) {
  const { cleaned, ...counts } = await matchTargets(campaign, filter);

  const nextSendAt = new Date();

  const ops = cleaned.map((t) => ({
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

  if (!ops.length) return { ...counts, enrolled: 0 };

  const CHUNK = 1000;
  let upserted = 0;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const res = await CampaignEnrollment.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    upserted += res.upsertedCount || 0;
  }
  return { ...counts, enrolled: upserted };
}

// Send the current step's message for one enrollment, then advance it to the
// next step (or mark it completed if that was the last one).
async function advanceEnrollment(enrollment, campaign) {
  const step = campaign.steps[enrollment.currentStepIndex];
  const adapter = await getAdapter(enrollment.targetModel);
  const targetDoc = await adapter.findById(enrollment.targetId);

  if (!targetDoc) {
    enrollment.status = "failed";
    enrollment.history.push({
      stepIndex: enrollment.currentStepIndex,
      templateId: step.templateId,
      sentAt: new Date(),
      status: "error",
      error: "Target document no longer exists",
    });
    await enrollment.save();
    return;
  }

  try {
    await whatsappProvider.sendMessage({
      phone: enrollment.phone,
      templateId: step.templateId,
      meta: step.providerMeta,
      params: [],
      channelId: campaign.channelId,
    });
    enrollment.history.push({
      stepIndex: enrollment.currentStepIndex,
      templateId: step.templateId,
      sentAt: new Date(),
      status: "sent",
    });

    const nextIndex = enrollment.currentStepIndex + 1;
    const nextStep = campaign.steps[nextIndex];
    if (nextStep) {
      enrollment.currentStepIndex = nextIndex;
      enrollment.nextSendAt = new Date();
    } else {
      enrollment.status = "completed";
    }
  } catch (err) {
    enrollment.history.push({
      stepIndex: enrollment.currentStepIndex,
      templateId: step.templateId,
      sentAt: new Date(),
      status: "error",
      error: err.message,
    });
    enrollment.status = "failed";
  }

  await enrollment.save();
}

// Send one WhatsApp template message to one phone number directly — no
// campaign, no enrollment, just a single fire-and-forget send.
async function sendSingleMessage({ phone: rawPhone, templateId, providerMeta, channelId }) {
  const phone = cleanPhone(rawPhone);
  if (!phone) throw new Error(`"${rawPhone}" is not a valid phone number`);
  return whatsappProvider.sendMessage({ phone, templateId, meta: providerMeta, params: [], channelId });
}

// One poll tick: find due, active enrollments (campaign still active) and
// send/advance each in turn, spaced out to respect the connected provider's
// rate limits.
async function processDueEnrollments() {
  if (!(await whatsappProvider.isConfigured())) return { processed: 0, skipped: "No WhatsApp provider connected" };

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

// Always polls, regardless of whether a provider is connected at boot —
// the connection can be made/broken later from the Integrations tab without
// a restart, and processDueEnrollments() already no-ops per tick when
// nothing's connected.
function startScheduler() {
  if (pollHandle) return;
  pollHandle = setInterval(() => {
    processDueEnrollments().catch((err) => console.error("[campaignEngine] poll error:", err.message));
  }, POLL_INTERVAL_MS);
  console.log(`[campaignEngine] polling every ${POLL_INTERVAL_MS}ms for due drip messages (when a provider is connected)`);
}

module.exports = { enrollTargets, previewTargets, sendSingleMessage, processDueEnrollments, startScheduler };
