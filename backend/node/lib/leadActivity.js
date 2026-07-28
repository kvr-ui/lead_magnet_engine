/**
 * Did the campaign actually make anyone do anything?
 *
 * Delivery tracking (MessageEvent) answers "did the message land, was it
 * read" — it stops at the handset. This answers the question after that one:
 * once we messaged them, did they go and use the product?
 *
 * The signal lives in the lead magnet's own database, which we only ever
 * read. CA Guru writes one `mcqevaluations` row per question answered,
 * stamped `submittedAt`. That timestamp is the whole trick: our enrollment
 * knows when the message went out, so anything stamped after it is
 * attributable to the send, and anything before it is the lead's own doing.
 *
 * The lifetime totals `enrich` already exposes (totalAttempted/totalCorrect)
 * cannot answer this — a lead sitting at 6 questions answered gives no way to
 * tell whether they did all 6 last month or 3 of them an hour after our
 * message. Only the per-row timestamps split that.
 *
 * Nothing here writes to the lead magnet database. The campaign side and the
 * activity side live in two separate MongoDB deployments, so the join can't
 * be a $lookup — it's done here, in batch, keyed on the external user id the
 * enrollment already stores as targetId (falling back to phone for campaigns
 * that target Contacts or Leads instead of the lead magnet directly).
 */

const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");
const DataSourceConnection = require("../models/DataSourceConnection");
const Campaign = require("../models/Campaign");
const { getConnectionFor } = require("./dataSourcePool");
const { cleanPhone } = require("./phone");
const { DYNAMIC_PREFIX } = require("./sourceFields");

// How long after a message we still credit it for what the lead did. A lead
// who opens the app eight days later probably didn't do it because of us;
// counting them would flatter every campaign. Callers can widen or disable
// it (0 = no limit), but the default is deliberately finite.
const DEFAULT_WINDOW_HOURS = 168; // 7 days

// $in lists are chunked rather than sent whole — a campaign against the full
// user base would otherwise build a single query with thousands of ids.
const IN_CHUNK = 500;

// Same guesses lib/campaignEngine.js makes for a data source's phone column;
// there's no per-connection setting for it.
const PHONE_FIELD_CANDIDATES = ["phone", "phonenumber", "mobile", "mobilenumber", "contactnumber", "whatsappnumber"];

function guessPhoneField(fieldsCache) {
  const byLower = new Map((fieldsCache || []).map((k) => [k.toLowerCase(), k]));
  for (const candidate of PHONE_FIELD_CANDIDATES) {
    if (byLower.has(candidate)) return byLower.get(candidate);
  }
  return null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// The connected data source whose activity we measure. Only one is supported
// at a time on purpose: "how many MCQs after the send" is a single question
// about a single product, and picking between several silently would make the
// number impossible to interpret.
async function getActivitySource() {
  return DataSourceConnection.findOne({ active: true, activity: { $exists: true, $ne: null } }).lean();
}

/**
 * Maps every user in the lead magnet's base collection to the key its
 * activity rows are recorded under, by both external _id and normalised
 * phone — the two things a send can be tied back to.
 *
 * Read whole rather than queried per lead: the base collection is a few
 * thousand documents of three projected fields, which is one round trip
 * against a per-enrollment lookup that would be hundreds.
 */
async function buildUserIndex(source) {
  const conn = await getConnectionFor(source);
  const phoneField = guessPhoneField(source.fieldsCache);
  const projection = { [source.activity.localField]: 1 };
  if (phoneField) projection[phoneField] = 1;
  // A display name makes the per-lead table readable; absent on some sources.
  const nameField = (source.fieldsCache || []).find((k) => k.toLowerCase() === "name");
  if (nameField) projection[nameField] = 1;

  const docs = await conn.db.collection(source.collectionName).find({}).project(projection).toArray();

  const byId = new Map();
  const byPhone = new Map();
  const names = new Map();
  for (const doc of docs) {
    const key = doc[source.activity.localField];
    if (key === undefined || key === null || key === "") continue;
    byId.set(String(doc._id), key);
    if (nameField && doc[nameField]) names.set(String(key), doc[nameField]);
    if (phoneField) {
      // Normalised both sides: the lead magnet stores bare 10-digit numbers,
      // our enrollments store them WATI-style with the country code.
      const phone = cleanPhone(doc[phoneField]);
      if (phone && !byPhone.has(phone)) byPhone.set(phone, key);
    }
  }
  return { byId, byPhone, names, conn };
}

// A send's lead key: the external _id when the campaign targeted this data
// source directly (exact), otherwise the phone number (for campaigns that
// target Contacts or Leads, and for manual sends, which have no target doc).
function keyForSend(send, index, sourceId) {
  if (send.targetModel === `${DYNAMIC_PREFIX}${sourceId}` && send.targetId) {
    const key = index.byId.get(String(send.targetId));
    if (key !== undefined) return key;
  }
  return send.phone ? index.byPhone.get(send.phone) : undefined;
}

/**
 * Every message we actually put on the wire, campaign and manual alike, as a
 * flat list of one entry per send.
 *
 * Manual sends are in here even though the question is about campaigns:
 * attribution credits the most recent message before the activity, and if a
 * hand-sent message went out after the campaign's, crediting the campaign
 * would be wrong.
 */
async function collectSends({ campaignId = null } = {}) {
  const filter = campaignId ? { campaign: campaignId } : {};
  const enrollments = await CampaignEnrollment.find({ ...filter, "history.0": { $exists: true } })
    .select("campaign targetModel targetId phone history")
    .lean();

  const sends = [];
  for (const e of enrollments) {
    for (const h of e.history) {
      if (h.status !== "sent" || !h.sentAt) continue;
      sends.push({
        kind: "campaign",
        campaignId: String(e.campaign),
        enrollmentId: String(e._id),
        targetModel: e.targetModel,
        targetId: e.targetId,
        phone: e.phone,
        sentAt: new Date(h.sentAt),
        templateId: h.templateId,
      });
    }
  }

  // Manual sends only matter for cross-campaign attribution, never when
  // scoping to one campaign's own leads.
  if (!campaignId) {
    const direct = await DirectMessage.find({ status: "sent" }).select("phone sentAt templateId").lean();
    for (const d of direct) {
      sends.push({
        kind: "manual",
        campaignId: null,
        directMessageId: String(d._id),
        targetModel: null,
        targetId: null,
        phone: d.phone,
        sentAt: new Date(d.sentAt),
        templateId: d.templateId,
      });
    }
  }

  return sends;
}

/**
 * Activity rows for the given lead keys, from `since` onwards, grouped by key
 * and sorted oldest first.
 *
 * `since` is the earliest send across the whole set, so the query never drags
 * back the lead magnet's entire history — everything before the first message
 * went out is irrelevant by definition.
 */
async function fetchActivityRows(source, conn, keys, since) {
  const { collection, foreignField, timestampField, correctField, labelFields } = source.activity;
  const projection = { [foreignField]: 1, [timestampField]: 1 };
  if (correctField) projection[correctField] = 1;
  for (const f of labelFields || []) projection[f] = 1;

  const byKey = new Map();
  for (const part of chunk(keys, IN_CHUNK)) {
    const rows = await conn.db
      .collection(collection)
      .find({ [foreignField]: { $in: part }, [timestampField]: { $gt: since } })
      .project(projection)
      .toArray();

    for (const row of rows) {
      const key = String(row[foreignField]);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({
        at: new Date(row[timestampField]),
        correct: correctField ? Boolean(row[correctField]) : null,
        label: (labelFields || [])
          .map((f) => row[f])
          .filter(Boolean)
          .join(" / "),
      });
    }
  }

  for (const rows of byKey.values()) rows.sort((a, b) => a.at - b.at);
  return byKey;
}

function windowEndFor(sentAt, windowHours) {
  if (!windowHours) return null; // no limit
  return new Date(sentAt.getTime() + windowHours * 3600 * 1000);
}

// Last-touch: the most recent message that went out at or before the lead
// did the thing, provided it's still inside its own attribution window.
// Sends must already be sorted oldest first.
function creditFor(sends, at, windowHours) {
  let credit = null;
  for (const send of sends) {
    if (send.sentAt > at) break;
    const end = windowEndFor(send.sentAt, windowHours);
    credit = end && at > end ? null : send;
  }
  return credit;
}

function summarise(rows) {
  const correct = rows.filter((r) => r.correct === true).length;
  const graded = rows.filter((r) => r.correct !== null).length;
  return { count: rows.length, correct, graded };
}

/**
 * One campaign's impact: for every lead it messaged, what they did afterwards.
 *
 * `attributedTo` on each lead is the campaign that actually earns last-touch
 * credit, which is not always this one — if another campaign or a manual
 * message reached the same lead later, that message is the more likely cause.
 * Reporting it keeps this campaign's own number honest rather than
 * double-counting shared leads.
 */
async function campaignActivity(campaign, { windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const source = await getActivitySource();
  if (!source) return { configured: false };

  const index = await buildUserIndex(source);
  const sourceId = String(source._id);

  const mine = await collectSends({ campaignId: campaign._id });
  if (!mine.length) {
    return {
      configured: true,
      source: { label: source.label, noun: source.activity.noun || "activity" },
      windowHours,
      summary: { messaged: 0, matched: 0, activated: 0, count: 0, correct: 0, graded: 0 },
      leads: [],
    };
  }

  // Every send to these leads, not just this campaign's, so credit can be
  // handed to a later message when there is one.
  const allSends = await collectSends();
  const campaigns = await Campaign.find().select("name").lean();
  const campaignNames = new Map(campaigns.map((c) => [String(c._id), c.name]));

  // First send per lead, per campaign — the point we measure "after" from.
  const firstSendByKey = new Map();
  for (const send of mine) {
    const key = keyForSend(send, index, sourceId);
    if (key === undefined) continue;
    const k = String(key);
    const prev = firstSendByKey.get(k);
    if (!prev || send.sentAt < prev.sentAt) firstSendByKey.set(k, send);
  }

  const sendsByKey = new Map();
  for (const send of allSends) {
    const key = keyForSend(send, index, sourceId);
    if (key === undefined) continue;
    const k = String(key);
    if (!sendsByKey.has(k)) sendsByKey.set(k, []);
    sendsByKey.get(k).push(send);
  }
  for (const list of sendsByKey.values()) list.sort((a, b) => a.sentAt - b.sentAt);

  const keys = [...firstSendByKey.keys()];
  const earliest = new Date(Math.min(...[...firstSendByKey.values()].map((s) => +s.sentAt)));
  const activityByKey = await fetchActivityRows(source, index.conn, keys, earliest);

  const leads = [];
  for (const [key, send] of firstSendByKey) {
    const end = windowEndFor(send.sentAt, windowHours);
    const rows = (activityByKey.get(key) || []).filter((r) => r.at > send.sentAt && (!end || r.at <= end));
    if (!rows.length) continue;

    const credit = creditFor(sendsByKey.get(key) || [], rows[0].at, windowHours);
    const stats = summarise(rows);
    leads.push({
      key,
      name: index.names.get(key) || null,
      phone: send.phone,
      enrollmentId: send.enrollmentId,
      sentAt: send.sentAt,
      firstAt: rows[0].at,
      minutesToFirst: Math.round((rows[0].at - send.sentAt) / 60000),
      ...stats,
      labels: [...new Set(rows.map((r) => r.label).filter(Boolean))],
      // null when this campaign is the credited one, otherwise what took it.
      attributedTo:
        credit && credit.campaignId && credit.campaignId !== String(campaign._id)
          ? { kind: "campaign", id: credit.campaignId, name: campaignNames.get(credit.campaignId) || "(deleted campaign)" }
          : credit && credit.kind === "manual"
            ? { kind: "manual", id: credit.directMessageId, name: "Manual send" }
            : null,
    });
  }

  leads.sort((a, b) => b.count - a.count || a.minutesToFirst - b.minutesToFirst);

  const credited = leads.filter((l) => !l.attributedTo);
  return {
    configured: true,
    source: { label: source.label, noun: source.activity.noun || "activity" },
    windowHours,
    summary: {
      messaged: new Set(mine.map((s) => s.enrollmentId)).size,
      matched: keys.length,
      activated: leads.length,
      // Only leads this campaign actually earns credit for.
      creditedActivated: credited.length,
      count: leads.reduce((n, l) => n + l.count, 0),
      correct: leads.reduce((n, l) => n + l.correct, 0),
      graded: leads.reduce((n, l) => n + l.graded, 0),
      creditedCount: credited.reduce((n, l) => n + l.count, 0),
    },
    leads,
  };
}

/**
 * Which campaign activated each lead, across every campaign at once — the
 * rollup behind the campaign list's activity columns.
 *
 * A lead is "activated by" whichever message most recently preceded the first
 * thing they did, so each activated lead is counted for exactly one campaign
 * and the columns add up instead of overlapping.
 */
async function activitySummary({ windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const source = await getActivitySource();
  if (!source) return { configured: false };

  const index = await buildUserIndex(source);
  const sourceId = String(source._id);
  const sends = await collectSends();
  if (!sends.length) {
    return { configured: true, source: { label: source.label, noun: source.activity.noun || "activity" }, windowHours, campaigns: {}, manual: null, totals: { activated: 0, count: 0, correct: 0 } };
  }

  const sendsByKey = new Map();
  for (const send of sends) {
    const key = keyForSend(send, index, sourceId);
    if (key === undefined) continue;
    const k = String(key);
    if (!sendsByKey.has(k)) sendsByKey.set(k, []);
    sendsByKey.get(k).push(send);
  }
  for (const list of sendsByKey.values()) list.sort((a, b) => a.sentAt - b.sentAt);

  const keys = [...sendsByKey.keys()];
  const earliest = new Date(Math.min(...sends.map((s) => +s.sentAt)));
  const activityByKey = await fetchActivityRows(source, index.conn, keys, earliest);

  const buckets = new Map(); // campaignId | "manual" -> stats
  const bump = (id, patch) => {
    if (!buckets.has(id)) buckets.set(id, { activated: 0, count: 0, correct: 0, messaged: 0 });
    const b = buckets.get(id);
    for (const [k, v] of Object.entries(patch)) b[k] += v;
  };

  // Leads messaged per campaign, whether or not anything came of it — the
  // denominator the activation rate is read against.
  const messagedByCampaign = new Map();
  for (const send of sends) {
    const id = send.campaignId || "manual";
    if (!messagedByCampaign.has(id)) messagedByCampaign.set(id, new Set());
    messagedByCampaign.get(id).add(send.enrollmentId || send.phone);
  }

  for (const [key, leadSends] of sendsByKey) {
    const rows = activityByKey.get(key) || [];
    let activatedBy = null;
    for (const row of rows) {
      const credit = creditFor(leadSends, row.at, windowHours);
      if (!credit) continue;
      const id = credit.campaignId || "manual";
      if (!activatedBy) activatedBy = id;
      bump(id, { count: 1, correct: row.correct === true ? 1 : 0 });
    }
    if (activatedBy) bump(activatedBy, { activated: 1 });
  }

  for (const [id, set] of messagedByCampaign) bump(id, { messaged: set.size });

  const campaigns = {};
  for (const [id, stats] of buckets) {
    if (id === "manual") continue;
    campaigns[id] = stats;
  }

  const totals = [...buckets.values()].reduce(
    (acc, b) => ({ activated: acc.activated + b.activated, count: acc.count + b.count, correct: acc.correct + b.correct }),
    { activated: 0, count: 0, correct: 0 }
  );

  return {
    configured: true,
    source: { label: source.label, noun: source.activity.noun || "activity" },
    windowHours,
    campaigns,
    manual: buckets.get("manual") || null,
    totals,
  };
}

/**
 * Looks up the wording of the questions the lead answered.
 *
 * The activity rows record answers as bare letters — "answered B, correct was
 * C" — which says nothing on its own. The text and options live in a separate
 * collection, commonly batched into an array on a generation document rather
 * than one document per question, so both shapes are handled.
 *
 * Missing questions are not an error: the lead magnet may have pruned old
 * generations, and an answer whose question is gone is still a real answer.
 * Those rows come back with a null question and the UI says so.
 */
async function fetchQuestionText(source, conn, ids) {
  const link = source.activity.questions;
  if (!link || !ids.length) return new Map();

  const { collection, arrayField, keyField, textField, optionsField, explanationField } = link;
  const matchPath = arrayField ? `${arrayField}.${keyField}` : keyField;

  // With a batched array there's no way to project just the wanted entries,
  // so the array comes back whole and is filtered below.
  let projection = { [arrayField]: 1 };
  if (!arrayField) {
    projection = { [keyField]: 1, [textField]: 1 };
    if (optionsField) projection[optionsField] = 1;
    if (explanationField) projection[explanationField] = 1;
  }

  const byId = new Map();
  for (const part of chunk(ids, IN_CHUNK)) {
    const docs = await conn.db
      .collection(collection)
      .find({ [matchPath]: { $in: part } })
      .project(projection)
      .toArray();

    const wanted = new Set(part);
    for (const doc of docs) {
      // One document can carry a whole batch, only some of which the lead
      // answered — pick out just the ones asked for.
      const entries = arrayField ? doc[arrayField] || [] : [doc];
      for (const entry of entries) {
        const id = entry?.[keyField];
        if (!id || !wanted.has(id) || byId.has(id)) continue;
        byId.set(id, {
          text: entry[textField] ?? null,
          options: optionsField ? entry[optionsField] || null : null,
          explanation: explanationField ? entry[explanationField] ?? null : null,
        });
      }
    }
  }
  return byId;
}

/**
 * Every question one lead answered after this campaign messaged them, in the
 * order they answered — the drill-down behind a row of campaignActivity().
 *
 * Scoped to the same send and window as the row it expands, so the questions
 * listed always add up to the count shown against that lead.
 */
async function leadActivityDetail(campaign, leadKey, { windowHours = DEFAULT_WINDOW_HOURS } = {}) {
  const source = await getActivitySource();
  if (!source) return { configured: false };

  const index = await buildUserIndex(source);
  const sourceId = String(source._id);

  const mine = await collectSends({ campaignId: campaign._id });
  const sendsForLead = mine
    .filter((s) => {
      const key = keyForSend(s, index, sourceId);
      return key !== undefined && String(key) === String(leadKey);
    })
    .sort((a, b) => a.sentAt - b.sentAt);

  if (!sendsForLead.length) return { configured: true, found: false };

  const send = sendsForLead[0];
  const end = windowEndFor(send.sentAt, windowHours);

  const { collection, foreignField, timestampField, correctField, labelFields, answerField, correctAnswerField, questions } =
    source.activity;
  const projection = { [foreignField]: 1, [timestampField]: 1 };
  if (correctField) projection[correctField] = 1;
  if (answerField) projection[answerField] = 1;
  if (correctAnswerField) projection[correctAnswerField] = 1;
  if (questions?.activityKeyField) projection[questions.activityKeyField] = 1;
  for (const f of labelFields || []) projection[f] = 1;

  const query = { [foreignField]: leadKey, [timestampField]: { $gt: send.sentAt } };
  if (end) query[timestampField].$lte = end;

  const rows = await index.conn.db
    .collection(collection)
    .find(query)
    .project(projection)
    .sort({ [timestampField]: 1 })
    .toArray();

  const questionIds = questions?.activityKeyField
    ? [...new Set(rows.map((r) => r[questions.activityKeyField]).filter(Boolean))]
    : [];
  const textById = await fetchQuestionText(source, index.conn, questionIds);

  const answers = rows.map((row) => {
    const qid = questions?.activityKeyField ? row[questions.activityKeyField] : null;
    const q = qid ? textById.get(qid) : null;
    return {
      at: row[timestampField],
      label: (labelFields || [])
        .map((f) => row[f])
        .filter(Boolean)
        .join(" / "),
      given: answerField ? (row[answerField] ?? null) : null,
      correctAnswer: correctAnswerField ? (row[correctAnswerField] ?? null) : null,
      isCorrect: correctField ? Boolean(row[correctField]) : null,
      question: q?.text ?? null,
      options: q?.options ?? null,
      explanation: q?.explanation ?? null,
    };
  });

  return {
    configured: true,
    found: true,
    source: { label: source.label, noun: source.activity.noun || "activity" },
    campaign: { id: String(campaign._id), name: campaign.name },
    windowHours,
    lead: {
      key: String(leadKey),
      name: index.names.get(String(leadKey)) || null,
      phone: send.phone,
      sentAt: send.sentAt,
      templateId: send.templateId,
    },
    summary: {
      count: answers.length,
      correct: answers.filter((a) => a.isCorrect === true).length,
      wrong: answers.filter((a) => a.isCorrect === false).length,
    },
    answers,
  };
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  getActivitySource,
  campaignActivity,
  activitySummary,
  leadActivityDetail,
};
