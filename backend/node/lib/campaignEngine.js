const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");
const Contact = require("../models/Contact");
const Lead = require("../models/Lead");
const OptOut = require("../models/OptOut");
const { getAdMagnetConnection } = require("../db");
const { cleanPhone } = require("./phone");
const whatsappProvider = require("./whatsappProvider");
const { DYNAMIC_PREFIX } = require("./sourceFields");
const { wrapWithEnrichment } = require("./enrichedCollection");
const { isSendingEnabled } = require("./sendingSwitch");

// How many due enrollments to send per poll tick, and the gap between sends —
// keeps us well under the connected provider's rate limits instead of firing
// a burst.
const BATCH_SIZE = parseInt(process.env.CAMPAIGN_BATCH_SIZE, 10) || 20;
const SEND_GAP_MS = parseInt(process.env.CAMPAIGN_SEND_GAP_MS, 10) || 1000;
const POLL_INTERVAL_MS = parseInt(process.env.CAMPAIGN_POLL_INTERVAL_MS, 10) || 5 * 60 * 1000;
// How often armed campaigns rescan their source for newly-matching targets.
// Separate from the send poll because it's a different kind of work: a full
// scan of an external database rather than a read of our own due queue.
const AUTO_ENROLL_INTERVAL_MS = parseInt(process.env.CAMPAIGN_AUTO_ENROLL_INTERVAL_MS, 10) || 5 * 60 * 1000;

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
  const raw = conn.db.collection(doc.collectionName);
  const collection = doc.enrich ? wrapWithEnrichment(raw, doc.enrich) : raw;

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
// everything matching `filter`, cleans phone numbers, excludes anyone who has
// opted out, and checks which of what's left is already enrolled in this
// campaign.
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

  // Opt-out is checked before the already-enrolled check, and against every
  // campaign's history at once — it's a global, per-phone concern (see
  // models/OptOut.js), not something scoped to this one campaign. Filtering
  // here, ahead of enrollTargets' bulkWrite, is what guarantees an opted-out
  // phone is never (re-)enrolled, whatever filter a campaign is run with.
  const optedOutPhones = new Set(
    (
      await OptOut.find({ phone: { $in: cleaned.map((c) => c.phone) } })
        .select("phone")
        .lean()
    ).map((o) => o.phone)
  );
  const skippedOptedOut = cleaned.filter((c) => optedOutPhones.has(c.phone)).length;
  const eligible = cleaned.filter((c) => !optedOutPhones.has(c.phone));

  const existing = await CampaignEnrollment.find({
    campaign: campaign._id,
    targetModel: campaign.targetModel,
    targetId: { $in: eligible.map((c) => c._id) },
  })
    .select("targetId")
    .lean();
  const existingIds = new Set(existing.map((e) => String(e.targetId)));
  const willEnroll = eligible.filter((c) => !existingIds.has(String(c._id))).length;

  return {
    matched,
    skippedNoPhone,
    skippedBadPhone,
    skippedOptedOut,
    alreadyEnrolled: eligible.length - willEnroll,
    willEnroll,
    cleaned: eligible, // internal — enrollTargets uses this to build write ops
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

// The provider echoes ids for the message it just accepted, under one of
// several names depending on endpoint. Stored on the history entry so the
// delivered/read/replied events that arrive later by webhook can be matched
// to this exact send instead of to a phone number.
//
// whatsappMessageId is preferred over localMessageId because that's the id the
// webhook keys on (see routes/wati.js) — picking the other one here would
// store an id no inbound event ever matches.
//
// Both come back undefined when the provider returns nothing usable, which is
// common. That isn't fatal: the *MessageSent webhook carries the ids and the
// phone together, and backfills them onto the enrollment.
const firstString = (...candidates) => {
  const found = candidates.find((v) => v !== undefined && v !== null && String(v).length);
  return found ? String(found) : undefined;
};

// Both camelCase and snake_case spellings are checked because WATI's send
// response is snake_case (`local_message_id`, alongside `phone_number` and
// `template_name`) while its webhook payloads are camelCase. Reading only the
// camelCase spelling meant the id sitting in the send response was silently
// dropped, leaving every send dependent on the *MessageSent webhook arriving
// — and any send made while the webhook receiver was down was permanently
// unmatchable, since nothing was stored to match it against later.
function extractSentMessageId(result) {
  return firstString(
    result?.whatsappMessageId,
    result?.whatsapp_message_id,
    result?.message?.whatsappMessageId,
    result?.messageId,
    result?.id,
    result?.message?.id
  );
}

function extractSentLocalMessageId(result) {
  return firstString(
    result?.localMessageId,
    result?.local_message_id,
    result?.message?.localMessageId,
    result?.message?.local_message_id
  );
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
    const sendResult = await whatsappProvider.sendMessage({
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
      providerMessageId: extractSentMessageId(sendResult),
      providerLocalMessageId: extractSentLocalMessageId(sendResult),
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
    // Sending switched off between the batch being picked up and this send:
    // nothing was mutated above, so leave the lead queued exactly as it was.
    // A closed gate must not burn leads as failed.
    if (err.sendingDisabled) return;
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
// campaign and no enrollment, but still recorded as a DirectMessage.
//
// The record is the whole point: without a row carrying the provider's message
// ids, the delivered/read/replied events that arrive seconds later have nothing
// to attach to and are stored unattributed. Writing it here is what makes a
// manual send trackable on the same footing as a campaign send.
async function sendSingleMessage({ phone: rawPhone, templateId, providerMeta, channelId }) {
  const phone = cleanPhone(rawPhone);
  if (!phone) throw new Error(`"${rawPhone}" is not a valid phone number`);

  const base = { phone, templateId, broadcastName: providerMeta?.broadcastName, channelId, sentAt: new Date() };

  let result;
  try {
    result = await whatsappProvider.sendMessage({ phone, templateId, meta: providerMeta, params: [], channelId });
  } catch (err) {
    // Sending switched off: nothing left our door, so there is no message to
    // track and a row would read as an attempt that failed. Matches how
    // advanceEnrollment treats a closed gate.
    if (err.sendingDisabled) throw err;
    await DirectMessage.create({ ...base, status: "error", error: err.message });
    throw err;
  }

  const record = await DirectMessage.create({
    ...base,
    status: "sent",
    providerMessageId: extractSentMessageId(result),
    providerLocalMessageId: extractSentLocalMessageId(result),
  });
  return { ...result, directMessageId: record._id };
}

// One poll tick: find due, active enrollments (campaign still active) and
// send/advance each in turn, spaced out to respect the connected provider's
// rate limits.
async function processDueEnrollments() {
  if (!(await whatsappProvider.isConfigured())) return { processed: 0, skipped: "No WhatsApp provider connected" };
  // Checked here as well as at the provider so a closed gate costs nothing:
  // due enrollments are never loaded, so none of them can be touched.
  if (!(await isSendingEnabled())) return { processed: 0, skipped: "Sending is off (test mode)" };

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

// One auto-enroll tick: for every active campaign with autoEnroll armed,
// re-run its stored segment so anyone who has since appeared in the source
// joins the drip on the next send cycle.
//
// This is a full rescan per armed campaign, not an incremental "what's new
// since last tick". That's deliberate — a target can start matching without
// being new (CA Guru flipping an existing user's caStatus to "Final"), which
// a created-after-X watermark would never see. The cost is one projected find
// over the source per armed campaign per tick.
//
// Safe to re-run: enrollTargets upserts on (campaign, targetModel, targetId),
// so already-enrolled targets are skipped rather than restarted at step 0.
async function processAutoEnroll() {
  // Gated on the same kill switch as sending. Enrolling isn't sending, but
  // quietly stacking up thousands of queued leads while the admin believes
  // they're in test mode is a nasty surprise when the switch goes back on.
  // Skipping costs nothing precisely because this is a full rescan: whoever
  // was missed during the pause is picked up by the first tick after it.
  if (!(await isSendingEnabled())) return { campaigns: 0, enrolled: 0, skipped: "Sending is off (test mode)" };

  const campaigns = await Campaign.find({ autoEnroll: true, active: true });
  let enrolled = 0;
  for (const campaign of campaigns) {
    campaign.lastAutoEnrollAt = new Date();
    try {
      const result = await enrollTargets(campaign, campaign.autoEnrollFilter || {});
      enrolled += result.enrolled;
      campaign.lastAutoEnrollCount = result.enrolled;
      campaign.lastAutoEnrollError = null;
      if (result.enrolled) {
        console.log(`[campaignEngine] auto-enrolled ${result.enrolled} new target(s) into "${campaign.name}"`);
      }
    } catch (err) {
      // One broken source (credentials rotated, collection dropped, phone
      // field renamed) must not stop the other armed campaigns from running.
      // Recorded on the campaign so the UI can show why it went quiet.
      campaign.lastAutoEnrollError = err.message;
      console.error(`[campaignEngine] auto-enroll failed for "${campaign.name}":`, err.message);
    }
    await campaign.save();
  }
  return { campaigns: campaigns.length, enrolled };
}

let pollHandle = null;
let autoEnrollHandle = null;
let autoEnrollRunning = false;

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

  autoEnrollHandle = setInterval(() => {
    // A rescan over a large or slow source can outlast the interval; skip the
    // tick rather than let two full scans of the same campaign overlap.
    if (autoEnrollRunning) return;
    autoEnrollRunning = true;
    processAutoEnroll()
      .catch((err) => console.error("[campaignEngine] auto-enroll poll error:", err.message))
      .finally(() => {
        autoEnrollRunning = false;
      });
  }, AUTO_ENROLL_INTERVAL_MS);
  console.log(`[campaignEngine] rescanning sources every ${AUTO_ENROLL_INTERVAL_MS}ms for campaigns with auto-enroll on`);
}

// getAdapter is exported for the read side: showing a lead's details means
// loading the target document from whichever source the campaign points at,
// which is exactly what the adapters already abstract.
module.exports = {
  enrollTargets,
  previewTargets,
  sendSingleMessage,
  processDueEnrollments,
  processAutoEnroll,
  startScheduler,
  getAdapter,
};
