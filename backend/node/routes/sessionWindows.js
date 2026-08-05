const MessageEvent = require("../models/MessageEvent");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const Campaign = require("../models/Campaign");
const DataSourceConnection = require("../models/DataSourceConnection");
const { resolveSource, phoneFieldFor } = require("../lib/sourceResolver");
const { DYNAMIC_PREFIX } = require("../lib/sourceFields");
const { cleanPhone } = require("../lib/phone");
const { openWindowPhones, describeWindow, WINDOW_HOURS } = require("../lib/sessionWindow");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

// Nothing here scans the lead sources looking for open windows, because the
// question runs the other way round: the set of numbers with an open window is
// bounded by "people who messaged us in the last 24 hours", which is always
// small. We resolve that short list first and then look up who those numbers
// belong to — the opposite order would mean reading every lead in a source of
// thousands to find the handful that are reachable.
const CAP = 500;

// A best-effort display name. Sources spell it differently and some have none;
// a missing name must not stop the row from rendering, since the phone number
// is the part that actually matters here.
const NAME_FIELDS = ["name", "fullName", "displayName", "firstName", "leadName"];
function pickName(doc) {
  if (!doc) return null;
  for (const field of NAME_FIELDS) {
    const value = doc[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * The spellings one cleaned number might be stored under.
 *
 * Inbound events are cleaned to "91XXXXXXXXXX", but a lead source keeps
 * whatever it was given — this database holds "+919360268027" in one collection
 * and a bare "6383514285" in another, and a source that imported from a
 * spreadsheet may well hold it as a number rather than a string. Matching on
 * the cleaned form alone would leave most rows nameless.
 *
 * Deliberately a small fixed set rather than a regex: an unanchored regex over
 * a phone field is unindexed, and this runs against every active source. A
 * spelling not covered here simply shows as "unknown", which is the same
 * graceful state as a lead that genuinely isn't in any source.
 */
function phoneVariants(cleaned) {
  const local = cleaned.length > 10 ? cleaned.slice(-10) : cleaned;
  const asNumber = Number(local);
  return [cleaned, `+${cleaned}`, local, ...(Number.isSafeInteger(asNumber) ? [asNumber] : [])];
}

// GET /api/session-windows — every number that can currently be sent a
// free-typed WhatsApp message, newest reply first.
router.get("/session-windows", async (_req, res) => {
  const now = new Date();
  const phones = await openWindowPhones(now);
  const capped = phones.slice(0, CAP);

  if (!capped.length) {
    return res.json({ windows: [], total: 0, windowHours: WINDOW_HOURS, truncated: false });
  }

  // Newest inbound per number, with the message itself — "what did they
  // actually say" is the first thing anyone asks when deciding whether to
  // reply, so showing the window without it would just prompt another click.
  const latest = await MessageEvent.aggregate([
    { $match: { phone: { $in: capped }, status: "received" } },
    { $sort: { receivedAt: -1 } },
    { $group: { _id: "$phone", lastInboundAt: { $first: "$receivedAt" }, lastMessage: { $first: "$text" } } },
  ]);

  // Which campaign, if any, this number is in. Enrollments store an already
  // cleaned phone (lib/phone.js), the same form the webhook writes, so this
  // join is exact rather than a format-tolerant guess.
  const enrollments = await CampaignEnrollment.find({ phone: { $in: capped } })
    .select("phone campaign targetModel targetId status updatedAt")
    .sort({ updatedAt: -1 })
    .lean();

  const byPhone = new Map();
  for (const e of enrollments) if (!byPhone.has(e.phone)) byPhone.set(e.phone, e);

  const campaigns = await Campaign.find({ _id: { $in: [...new Set(enrollments.map((e) => String(e.campaign)))] } })
    .select("name")
    .lean();
  const campaignName = new Map(campaigns.map((c) => [String(c._id), c.name]));

  // One source handle per distinct source, then one read per lead. The lead
  // count here is bounded by the open-window set, so this stays small — and a
  // source that is down or has had credentials rotated must degrade to "no
  // name" rather than failing the whole list.
  const sources = new Map();
  async function nameFor(enrollment) {
    if (!enrollment) return null;
    try {
      if (!sources.has(enrollment.targetModel)) {
        sources.set(enrollment.targetModel, await resolveSource(enrollment.targetModel));
      }
      return pickName(await sources.get(enrollment.targetModel).findById(enrollment.targetId));
    } catch {
      return null;
    }
  }

  // Anyone still nameless messaged us without being in a campaign — which is
  // most of this list, and exactly the people worth identifying, since nothing
  // else in the admin surfaces them at all. Look them up straight in the lead
  // sources by phone number.
  const named = new Map();
  for (const row of latest) {
    const name = await nameFor(byPhone.get(row._id));
    if (name) named.set(row._id, name);
  }
  const unnamed = latest.map((r) => r._id).filter((p) => !named.has(p));
  if (unnamed.length) {
    const variants = unnamed.flatMap(phoneVariants);
    const connections = await DataSourceConnection.find({ active: true }).lean();
    for (const conn of connections) {
      try {
        const handle = await resolveSource(`${DYNAMIC_PREFIX}${conn._id}`);
        const phoneField = phoneFieldFor(conn);
        if (!phoneField || !handle.collection) continue;
        const docs = await handle.collection.find({ [phoneField]: { $in: variants } }).toArray();
        for (const doc of docs) {
          const cleaned = cleanPhone(doc[phoneField]);
          const name = pickName(doc);
          if (cleaned && name && !named.has(cleaned)) named.set(cleaned, name);
        }
      } catch {
        // A source that is down, or whose credentials have rotated, costs this
        // list its names and nothing else.
      }
    }
  }

  const windows = [];
  for (const row of latest) {
    const enrollment = byPhone.get(row._id);
    windows.push({
      phone: row._id,
      name: named.get(row._id) || null,
      lastMessage: row.lastMessage || "",
      ...describeWindow(row.lastInboundAt, now),
      campaign: enrollment ? campaignName.get(String(enrollment.campaign)) || null : null,
      enrollmentId: enrollment ? String(enrollment._id) : null,
      enrollmentStatus: enrollment ? enrollment.status : null,
    });
  }

  windows.sort((a, b) => new Date(b.lastInboundAt) - new Date(a.lastInboundAt));

  res.json({
    windows,
    total: phones.length,
    windowHours: WINDOW_HOURS,
    truncated: phones.length > capped.length,
  });
});

module.exports = router;
