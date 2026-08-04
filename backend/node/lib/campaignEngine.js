const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");
const OptOut = require("../models/OptOut");
const MessageEvent = require("../models/MessageEvent");
const { cleanPhone } = require("./phone");
const whatsappProvider = require("./whatsappProvider");
const { resolveSource } = require("./sourceResolver");
// The one definition of which filter shapes are safe to run - reused by the
// graph walker so a `filter`/`condition` node can never accept an operator the
// query path would have rejected.
const { isSafeValue } = require("./sourceData");
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

// Shared by previewTargets (read-only) and enrollTargets (writes): finds
// everything matching `filter`, cleans phone numbers, excludes anyone who has
// opted out, and checks which of what's left is already enrolled in this
// campaign.
async function matchTargets(campaign, filter) {
  const source = await resolveSource(campaign.targetModel);
  const targets = await source.find(filter || {});
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

// ---------------------------------------------------------------------------
// The graph walker
//
// Replaces the old flat-array stepper, which read
// `campaign.steps[enrollment.currentStepIndex]`, sent it, and incremented the
// index. A campaign is now a versioned graph (see models/Campaign.js), so
// "advance one enrollment" means: pin to the exact published version the
// enrollment entered on, look up the node it is sitting on, dispatch on that
// node's kind, follow the outgoing edge the node's outcome selects, and keep
// going until something ends the tick.
//
// Three rules shape the whole design:
//
//   1. Decisions chain, side effects don't. filter/condition/split/goal nodes
//      resolve one after another inside a single tick, exactly like a
//      synchronous state-machine step - a chain of five conditions must not
//      cost five poll intervals. A `message` send, a `wait`, and any park end
//      the tick, because they have either touched the outside world or have
//      nothing left to do until wall-clock time moves.
//
//   2. Nothing is written to the enrollment until the tick is over. The walk
//      builds a plain result object and applyWalkResult() commits it at the
//      end. That is what makes the kill switch honest: when a send is refused
//      because sending is off (or the phone isn't allowlisted), the walk
//      returns `stop: "gated"` and NOTHING is applied - no status change, no
//      history entry, and no currentNodeId advance from the decision nodes it
//      already walked past on the way to the message node. From the
//      enrollment's point of view the tick simply never happened.
//
//   3. A broken graph parks, it never throws. A missing version, a missing
//      node, an unreadable source, a cycle, a node kind that isn't implemented
//      yet: each ends the tick with the enrollment parked and a reason string
//      recorded on it, so one malformed campaign can't take down the poll tick
//      that is also serving every other enrollment in the batch.
// ---------------------------------------------------------------------------

// How many nodes one call to the walker may visit before it gives up. Cycles
// among decision nodes are deliberately NOT rejected at publish time - a loop
// that passes through a `wait` node is a legitimate flow ("check again every
// day until they convert"), and telling that apart from a runaway loop
// statically is not a decidable question. So the runtime is the backstop
// instead: 50 hops is far more than any hand-drawn flow needs and far fewer
// than a spin.
const MAX_HOPS_PER_TICK = parseInt(process.env.CAMPAIGN_MAX_HOPS_PER_TICK, 10) || 50;

// Branch labels that may fall back to a node's single *unlabelled* outgoing
// edge when no edge carries the label. A node with one unlabelled edge is the
// common case (`source`, `message`, `wait`, and a `filter` whose kept leads
// simply carry on), so an affirmative outcome takes it. A negative outcome
// never does: routing a lead that failed a check down the pass edge would
// silently invert the flow, and an implicit exit is the documented behaviour
// for a branch with nowhere to go.
const AFFIRMATIVE_BRANCHES = new Set(["yes"]);

// `wait` node units, per models/Campaign.js. Singular spellings accepted
// because the canvas and the API have both been seen to emit them.
const UNIT_MS = {
  minute: 60 * 1000,
  minutes: 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

// Node kinds this walker recognises but deliberately does not implement yet.
// How each of them picks its branch is a design decision of its own, and each
// parks the enrollment with a reason rather than being guessed at here:
// defaulting a `split` would quietly contaminate a live A/B test, and firing an
// `action` would make a real external write. Recognising them here, instead of
// letting them fall through to "unknown kind", is what lets the park message
// say *why* the lead stopped rather than just that it did.
const UNIMPLEMENTED_KINDS = new Set(["split", "goal", "action"]);

// Delivery states a `condition` node's "engagement" kind can ask about. Same
// vocabulary MessageEvent normalises inbound webhooks into (see
// models/MessageEvent.js) so the two can't drift.
const ENGAGEMENT_STATUSES = new Set(["sent", "delivered", "read", "replied", "failed"]);

// --- graph helpers ---------------------------------------------------------

function normalizeBranch(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim().toLowerCase();
  return text.length ? text : null;
}

// The published snapshot this enrollment is pinned to. Never the draft: an
// enrollment walks the exact graph it entered on for its whole life, which is
// what lets an admin rearrange (or republish) a live flow without re-routing
// or stranding leads already mid-drip.
function graphVersionFor(campaign, version) {
  const wanted = Number(version);
  if (!Number.isFinite(wanted)) return null;
  return (campaign.versions || []).find((entry) => entry && Number(entry.version) === wanted) || null;
}

// The edge to leave `nodeId` by for the given outcome. `branch` is null for
// kinds with a single outgoing edge.
function pickEdge(version, nodeId, branch) {
  const out = (version.edges || []).filter((edge) => edge && edge.from === nodeId);
  const wanted = normalizeBranch(branch);
  if (!wanted) {
    const unlabelled = out.find((edge) => !normalizeBranch(edge.branch));
    // A single outgoing edge is unambiguous whatever it happens to be
    // labelled, so take it rather than parking a perfectly walkable flow.
    return unlabelled || (out.length === 1 ? out[0] : null);
  }
  const exact = out.find((edge) => normalizeBranch(edge.branch) === wanted);
  if (exact) return exact;
  if (AFFIRMATIVE_BRANCHES.has(wanted)) return out.find((edge) => !normalizeBranch(edge.branch)) || null;
  return null;
}

/**
 * Which source this enrollment's target document lives in, and the canonical
 * field map to read it through.
 *
 * The source id comes from the enrollment, not from the graph: a graph may
 * hold several `source` nodes (two lead magnets feeding one drip) and the
 * enrollment row itself records which one this lead came from. The map comes
 * from the graph, because that is where the admin wired "this source's
 * `phoneNumber` column is the canonical `phone`". Matching the two up by
 * sourceId keeps a multi-source graph honest; a graph with exactly one source
 * node is allowed to be sloppy about the id, since there is nothing to confuse
 * it with.
 */
function sourceContextFor(version, enrollment) {
  const sources = (version.nodes || []).filter((node) => node && node.kind === "source");
  const match =
    sources.find((node) => (node.config || {}).sourceId === enrollment.targetModel) ||
    (sources.length === 1 ? sources[0] : null);
  return { sourceId: enrollment.targetModel, map: (match && (match.config || {}).map) || {} };
}

// --- wait scheduling -------------------------------------------------------
//
// A `wait` node's window/skipDays are wall-clock rules in a named timezone
// ("only ever send between 10:00 and 20:00 India time, never on a Sunday"),
// and the stored instant is UTC. Intl.DateTimeFormat is the only timezone
// database Node ships with, so the conversion both ways goes through it rather
// than through a dependency this project doesn't have.

const ZONE_FORMATTERS = new Map();

function zoneFormatter(tz) {
  if (!ZONE_FORMATTERS.has(tz)) {
    ZONE_FORMATTERS.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
  }
  return ZONE_FORMATTERS.get(tz);
}

// The wall-clock calendar/time `date` reads as in `tz`. Throws RangeError on an
// unknown timezone name, which the wait handler turns into a park.
function zonedParts(date, tz) {
  const parts = {};
  for (const part of zoneFormatter(tz).formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  // Derived from the zone-local calendar date rather than read out of the
  // formatter, so the weekday can never disagree with the y/m/d above.
  parts.weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return parts;
}

// How far ahead of UTC `tz` is at that instant, in milliseconds.
function zoneOffsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// The instant at which `tz`'s wall clock reads the given calendar time. Two
// passes because the offset to subtract depends on the answer: the first pass
// guesses with the offset at the naive instant, the second corrects it - which
// only matters at a DST boundary, and settles there.
function zonedTimeToDate({ year, month, day, hour = 0, minute = 0, second = 0 }, tz) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = wall - zoneOffsetMs(new Date(wall), tz);
  ts = wall - zoneOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

// "HH:MM" -> minutes since local midnight, or null if it isn't one.
function parseTimeOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value === undefined || value === null ? "" : value).trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function nextDayAt(parts, tz, minuteOfDay) {
  // Date.UTC normalises the day overflow, so "the 31st + 1" is the 1st of the
  // next month without any calendar arithmetic here.
  const rolled = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  return zonedTimeToDate(
    {
      year: rolled.getUTCFullYear(),
      month: rolled.getUTCMonth() + 1,
      day: rolled.getUTCDate(),
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      second: 0,
    },
    tz
  );
}

/**
 * `at`, pushed forward until it lands inside the node's sending window and off
 * every weekday it is told to skip.
 *
 * The two rules interact, which is why this loops instead of applying them
 * once each: pushing past a skipped day can land outside the window, and
 * pushing to the front of the window can land on a skipped day. The loop is
 * bounded (a week of skipped days plus a window clamp is nowhere near 14
 * passes) so a nonsense config - every weekday skipped - stops rather than
 * spins.
 *
 * Worked example, the one the verify harness pins: armed Friday 23:10 with a
 * two-day wait lands Sunday 23:10; `skipDays: [0]` moves that to Monday at the
 * window's opening time, 10:00 Asia/Kolkata, which is inside the window and
 * not a skipped day, so that is the answer.
 */
function clampToWindow(at, { window, tz, skipDays }) {
  const zone = tz || (window && window.tz) || "UTC";
  const from = window ? parseTimeOfDay(window.from) : null;
  const to = window ? parseTimeOfDay(window.to) : null;
  // An inverted window ("22:00" to "06:00") would mean an overnight send slot,
  // which nothing in the product offers; treated as no window at all rather
  // than guessed at.
  const clamping = from !== null && to !== null && from <= to;
  const skip = new Set(
    (Array.isArray(skipDays) ? skipDays : [])
      .map(Number)
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  );
  if (!clamping && !skip.size) return at;

  let current = at;
  for (let pass = 0; pass < 14; pass++) {
    const parts = zonedParts(current, zone);
    if (skip.has(parts.weekday)) {
      current = nextDayAt(parts, zone, clamping ? from : 0);
      continue;
    }
    if (clamping) {
      const minuteOfDay = parts.hour * 60 + parts.minute;
      if (minuteOfDay < from) {
        current = zonedTimeToDate(
          { ...parts, hour: Math.floor(from / 60), minute: from % 60, second: 0 },
          zone
        );
        continue;
      }
      if (minuteOfDay > to) {
        current = nextDayAt(parts, zone, from);
        continue;
      }
    }
    return current;
  }
  return current;
}

/**
 * When a `wait` node armed at `from` should let the enrollment through.
 *
 * Exported so the verify harness (and anything else that needs to reason about
 * scheduling) can check the window/timezone/skipDays arithmetic directly
 * instead of inferring it from a walked enrollment.
 */
function resolveWaitAt(node, from) {
  const config = node.config || {};
  const amount = Number(config.amount) || 0;
  const unit = String(config.unit === undefined || config.unit === null ? "minutes" : config.unit).toLowerCase();
  const ms = UNIT_MS[unit];
  if (ms === undefined) throw new Error(`unsupported wait unit "${config.unit}"`);
  const armed = new Date(from.getTime() + amount * ms);
  return clampToWindow(armed, {
    window: config.window,
    // The schema puts tz inside window; the walker also accepts it alongside,
    // since both spellings are in circulation.
    tz: config.tz || (config.window && config.window.tz),
    skipDays: config.skipDays,
  });
}

// --- filter / condition evaluation -----------------------------------------

const COMPARATORS = {
  $lt: (a, b) => a < b,
  $lte: (a, b) => a <= b,
  $gt: (a, b) => a > b,
  $gte: (a, b) => a >= b,
};

// Equality as a filter means it, not as JavaScript means it: an ObjectId, a
// number stored as a string and a Date all have to compare equal to the plain
// scalar an admin typed into the segment builder.
function sameValue(actual, expected) {
  if (expected === null) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  if (actual instanceof Date) return actual.toISOString() === String(expected) || actual.getTime() === Number(expected);
  return actual === expected || String(actual) === String(expected);
}

/**
 * Does this document satisfy the filter?
 *
 * The filter shape is the one the whole app already speaks - the shape
 * `autoEnrollFilter`, `matchTargets` and a `source` node's filter use, and the
 * shape `isSafeValue` in lib/sourceData.js defines: a plain scalar (equality),
 * `{ $in: [...] }`, or a single bounded numeric comparison. That gate is
 * imported rather than re-described here so a `filter` node can never accept
 * an operator the query path would have rejected.
 *
 * Evaluated in memory rather than as a second query because the document has
 * already been read live for this tick, and because it is read through
 * sourceResolver's findById, which merges the canonical keys on top of the raw
 * document - so a filter may address a field either by its canonical name
 * (`stage`) or by the source's own column name (`caStatus`).
 */
function matchesFilter(doc, filter) {
  for (const [field, expected] of Object.entries(filter || {})) {
    if (!isSafeValue(expected)) throw new Error(`unsupported filter value for field "${field}"`);
    const actual = doc ? doc[field] : undefined;
    if (expected && typeof expected === "object") {
      const [operator] = Object.keys(expected);
      if (operator === "$in") {
        if (!expected.$in.some((candidate) => sameValue(actual, candidate))) return false;
        continue;
      }
      const compare = COMPARATORS[operator];
      const numeric = Number(actual);
      if (!compare || Number.isNaN(numeric) || !compare(numeric, Number(expected[operator]))) return false;
      continue;
    }
    if (!sameValue(actual, expected)) return false;
  }
  return true;
}

// A `filter` node carries a whole filter object; a `condition` node's "field"
// kind may instead carry the field/operator/value sugar the canvas emits.
// Both are normalised to the one filter shape matchesFilter reads, so there is
// a single comparison implementation behind both node kinds.
function conditionFilterFor(config) {
  if (config.filter && typeof config.filter === "object") return config.filter;
  if (!config.field) throw new Error("names neither a filter nor a field to compare");
  const raw = config.operator === undefined || config.operator === null ? "" : String(config.operator).trim();
  const value = config.value === undefined ? null : config.value;
  if (!raw || raw === "eq" || raw === "=" || raw === "$eq") return { [config.field]: value };
  const operator = raw.startsWith("$") ? raw : `$${raw}`;
  if (operator === "$in") return { [config.field]: { $in: [].concat(value === null ? [] : value) } };
  return { [config.field]: { [operator]: value } };
}

// When this enrollment last actually sent something, and when it started -
// the two clocks an "elapsed" condition and the activity rollup measure from.
function lastSentAt(enrollment) {
  const history = enrollment.history || [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].status === "sent" && history[i].sentAt) return new Date(history[i].sentAt);
  }
  return null;
}

function startedAt(enrollment) {
  if (enrollment.createdAt) return new Date(enrollment.createdAt);
  const first = (enrollment.history || []).find((entry) => entry && entry.sentAt);
  return first ? new Date(first.sentAt) : null;
}

/**
 * Did the message this condition names actually land / get read / get replied
 * to?
 *
 * Keyed on the provider message id stored against that node's own history
 * entry, so the answer is about that specific send rather than about anything
 * this phone number has ever done. The provider doesn't always echo an id on
 * the send response (see extractSentMessageId above), so when there is none to
 * key on this falls back to events the webhook attached to this enrollment
 * after that send went out - which is the same match routes/wati.js makes.
 */
async function evaluateEngagement(node, ctx) {
  const config = node.config || {};
  const messageNodeId = config.nodeId || config.messageNodeId || config.node;
  const status = normalizeBranch(config.status || config.event);
  if (!messageNodeId) throw new Error("names no upstream message node to check");
  if (!status || !ENGAGEMENT_STATUSES.has(status)) {
    throw new Error(`asks about an unsupported delivery status "${config.status || config.event}"`);
  }

  const sends = (ctx.enrollment.history || []).filter(
    (entry) => entry && entry.nodeId === messageNodeId && entry.status === "sent"
  );
  // Nothing was ever sent from that node, so nothing can have engaged with it.
  if (!sends.length) return false;
  const last = sends[sends.length - 1];

  const ids = [last.providerMessageId, last.providerLocalMessageId].filter(Boolean);
  const query = ids.length
    ? { status, providerMessageId: { $in: ids } }
    : { status, enrollment: ctx.enrollment._id, receivedAt: { $gte: last.sentAt } };
  return (await ctx.deps.MessageEvent.countDocuments(query)) > 0;
}

// Did they go and use the product since we last messaged them? Rolled up by
// lib/leadActivity.js, which owns the join between our enrollments and the
// lead magnet's own database.
async function evaluateActivity(node, ctx) {
  const config = node.config || {};
  const threshold = Number(config.threshold === undefined ? config.count : config.threshold);
  const wanted = Number.isFinite(threshold) ? threshold : 1;
  const metric = String(config.metric || "count").toLowerCase();
  // No clock is passed: the cutoff this measures from is the enrollment's own
  // last send, not "now", so an injected clock has nothing to say about it.
  const rollup = await ctx.deps.activitySinceLastSend(ctx.enrollment);
  // No activity source is configured at all, so this node cannot honestly
  // answer its own question - park rather than pick a branch.
  if (!rollup.configured) throw new Error("needs a data source with an activity config, and none is connected");
  const value = metric === "correct" ? rollup.correct : metric === "graded" ? rollup.graded : rollup.count;
  return (value || 0) >= wanted;
}

// Days (or hours) since the enrollment started, or since its last send.
async function evaluateElapsed(node, ctx) {
  const config = node.config || {};
  const since = String(config.since || "start").toLowerCase().replace(/[^a-z]/g, "");
  const from = since === "lastsend" || since === "send" ? lastSentAt(ctx.enrollment) || startedAt(ctx.enrollment) : startedAt(ctx.enrollment);
  if (!from) throw new Error(`has nothing to measure "${config.since || "start"}" from`);
  const days = Number(config.days === undefined ? config.amount : config.days) || 0;
  const hours = Number(config.hours) || 0;
  return ctx.now.getTime() - from.getTime() >= days * UNIT_MS.days + hours * UNIT_MS.hours;
}

// A `condition` node's `config.on` picks one of four evaluation kinds. Each
// returns a plain boolean, which the walker turns into the "yes"/"no" edge.
async function evaluateCondition(node, ctx) {
  const config = node.config || {};
  const on = String(config.on || "field").toLowerCase();
  if (on === "field") {
    const doc = await ctx.target();
    if (!doc) throw new Error("target document no longer exists");
    return matchesFilter(doc, conditionFilterFor(config));
  }
  if (on === "engagement") return evaluateEngagement(node, ctx);
  if (on === "activity") return evaluateActivity(node, ctx);
  if (on === "elapsed") return evaluateElapsed(node, ctx);
  throw new Error(`has an unknown condition kind "${config.on}"`);
}

// --- message rendering -----------------------------------------------------

function formatParamValue(value) {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * The ordered parameter list for a message node's template.
 *
 * This is what the old stepper hardcoded to `[]`: every template variable came
 * out blank because nothing ever mapped a slot to a field. A message node
 * declares `params: [{ index, from }]`, where `index` is the variable position
 * in the template ({{1}}, {{2}}, ...) and `from` names a *canonical* key - so
 * the same node serves a Contact, a Lead and a connected data source without
 * knowing what any of them calls the column. The values come off the document
 * read live for this tick, never off a snapshot taken at enrollment time,
 * because a drip's whole point is that the lead's situation changes between
 * step one and step four.
 *
 * Gaps are filled with "" rather than left undefined: WATI positions
 * parameters by order, so a hole would shift every later variable up one.
 */
function renderParams(node, doc) {
  const declared = ((node.config || {}).params || []).filter(Boolean);
  const slots = [];
  declared.forEach((param, position) => {
    const declaredIndex = Number(param.index);
    const index = Number.isFinite(declaredIndex) && declaredIndex > 0 ? declaredIndex : position + 1;
    const read = param.from ? (doc || {})[param.from] : undefined;
    slots[index - 1] = formatParamValue(read === undefined || read === null ? param.value : read);
  });
  for (let i = 0; i < slots.length; i++) if (slots[i] === undefined) slots[i] = "";
  return slots;
}

// --- the walk itself -------------------------------------------------------

function emptyResult() {
  return {
    // How the tick ended: "sent", "waiting", "completed", "paused", "failed",
    // or "gated" (the kill switch or the allowlist refused the send, so
    // nothing at all is applied to the enrollment).
    stop: null,
    reason: null,
    status: null,
    currentNodeId: undefined,
    nextSendAt: null,
    exitOutcome: null,
    history: [],
    visited: [],
    path: [],
    sends: [],
    hops: 0,
  };
}

function park(result, status, reason) {
  result.stop = status;
  result.status = status;
  result.reason = reason;
  return result;
}

function finish(result, node, outcome, reason) {
  result.stop = "completed";
  result.status = "completed";
  result.currentNodeId = node ? node.id : result.currentNodeId;
  result.exitOutcome = outcome;
  result.reason = reason || null;
  return result;
}

// Defaults are resolved per call rather than captured at module load so a
// caller (dry run, verify harness) can substitute any of them, and so
// lib/leadActivity.js - which drags in the data-source pool and its encryption
// plumbing - is only required when a node actually asks for activity.
function defaultDeps() {
  return {
    resolveSource,
    MessageEvent,
    activitySinceLastSend: (...args) => require("./leadActivity").activitySinceLastSend(...args),
  };
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  if (value === undefined || value === null) return new Date();
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

/**
 * Walk one enrollment through its pinned graph version until the tick ends.
 *
 * Pure with respect to the enrollment: it reads it, but every write it wants
 * to make comes back on the result for applyWalkResult() to commit. See rule 2
 * at the top of this section for why that matters.
 */
async function runWalk(enrollment, campaign, ctx) {
  const result = emptyResult();

  const version = graphVersionFor(campaign, enrollment.graphVersion);
  if (!version) {
    // Same treatment as a missing node: park, never crash. An enrollment
    // pinned to a version that isn't there (hand-edited row, a campaign
    // restored from a partial backup) is a data problem to be looked at, not a
    // reason to take the poll tick down.
    return park(
      result,
      "paused",
      `campaign "${campaign.name}" has no published graph version ${enrollment.graphVersion} to walk`
    );
  }

  const nodesById = new Map();
  for (const node of version.nodes || []) if (node && node.id) nodesById.set(node.id, node);

  const { sourceId, map } = sourceContextFor(version, enrollment);
  let targetDoc;
  let targetRead = false;
  // One live read per tick, shared by every node that needs it. "Live" is the
  // point - a message node's params and a field condition's comparison both
  // have to see the lead as they are now, not as they were when enrolled.
  ctx.target = async () => {
    if (!targetRead) {
      const source = await ctx.deps.resolveSource(sourceId, map);
      targetDoc = await source.findById(enrollment.targetId);
      targetRead = true;
    }
    return targetDoc;
  };

  const hopLimit = ctx.hopLimit;
  let cursor = enrollment.currentNodeId;

  for (;;) {
    if (result.hops >= hopLimit) {
      // The runtime backstop against a cycle of decision nodes with no
      // intervening wait. Failed rather than paused: a graph that loops is
      // broken by construction and needs an edit, not a retry.
      return park(
        result,
        "failed",
        `hop limit of ${hopLimit} node visits reached in a single tick - graph version ${enrollment.graphVersion} of campaign "${campaign.name}" loops with no wait node in it (last visited: ${result.path.slice(-6).join(" -> ")})`
      );
    }

    if (!cursor) {
      return park(
        result,
        "paused",
        `enrollment has no currentNodeId to walk from in graph version ${enrollment.graphVersion} of campaign "${campaign.name}"`
      );
    }

    const node = nodesById.get(cursor);
    if (!node) {
      return park(
        result,
        "paused",
        `node "${cursor}" does not exist in graph version ${enrollment.graphVersion} of campaign "${campaign.name}"`
      );
    }

    result.hops++;
    const step = { nodeId: node.id, kind: node.kind, branch: null };
    result.visited.push(step);
    result.path.push(node.id);

    // Follows the edge `branch` selects, or completes the enrollment when
    // there is no such edge - a branch with nowhere to go is an implicit exit,
    // not an error. Returns null when the walk is over.
    const follow = (branch) => {
      step.branch = branch === undefined ? null : branch;
      const edge = pickEdge(version, node.id, branch);
      if (!edge) {
        finish(result, node, null, `no outgoing edge from "${node.id}"${branch ? ` for branch "${branch}"` : ""}`);
        return null;
      }
      return edge.to;
    };

    if (UNIMPLEMENTED_KINDS.has(node.kind)) {
      // A deliberate stub, not an oversight. Parked with the node it stopped
      // on still as currentNodeId, so implementing the handler is enough to
      // let the lead carry on from exactly where it stood.
      result.currentNodeId = node.id;
      return park(result, "paused", `${node.kind} node handling not yet implemented (node "${node.id}")`);
    }

    if (node.kind === "source") {
      // Nothing to do at walk time: matching the source's filter and creating
      // the enrollment already happened at enroll time. It exists in the graph
      // to say where the lead came from and to carry the canonical field map.
      const next = follow(null);
      if (next === null) return result;
      cursor = next;
      continue;
    }

    if (node.kind === "filter") {
      let kept;
      try {
        const doc = await ctx.target();
        if (!doc) return park(result, "failed", `target document ${enrollment.targetId} no longer exists`);
        kept = matchesFilter(doc, conditionFilterFor(node.config || {}));
      } catch (err) {
        return park(result, "paused", `filter node "${node.id}" ${err.message}`);
      }
      const next = follow(kept ? "yes" : "no");
      if (next === null) return result;
      cursor = next;
      continue;
    }

    if (node.kind === "condition") {
      let outcome;
      try {
        outcome = await evaluateCondition(node, ctx);
      } catch (err) {
        return park(result, "paused", `condition node "${node.id}" ${err.message}`);
      }
      const next = follow(outcome ? "yes" : "no");
      if (next === null) return result;
      cursor = next;
      continue;
    }

    if (node.kind === "wait") {
      let waitUntil;
      try {
        waitUntil = resolveWaitAt(node, ctx.now);
      } catch (err) {
        return park(result, "paused", `wait node "${node.id}" ${err.message}`);
      }
      // Where the lead goes after the wait is resolved now, not when the timer
      // fires, so a wait with nowhere to go completes immediately instead of
      // parking a lead against a date that leads nowhere.
      const next = follow(null);
      if (next === null) return result;
      result.stop = "waiting";
      result.currentNodeId = next;
      result.nextSendAt = waitUntil;
      return result;
    }

    if (node.kind === "message") {
      const config = node.config || {};
      let doc;
      try {
        doc = await ctx.target();
      } catch (err) {
        return park(result, "paused", `message node "${node.id}" could not read its source: ${err.message}`);
      }
      if (!doc) {
        // Same outcome the flat stepper gave: the lead is gone, so the send
        // can't happen and won't ever be able to.
        result.history.push({
          nodeId: node.id,
          templateId: config.templateId,
          sentAt: ctx.now,
          status: "error",
          error: "Target document no longer exists",
        });
        return park(result, "failed", `target document ${enrollment.targetId} no longer exists`);
      }

      const params = renderParams(node, doc);
      const attempt = {
        nodeId: node.id,
        templateId: config.templateId,
        phone: enrollment.phone,
        params,
        meta: config.providerMeta,
        channelId: campaign.channelId,
        status: ctx.dryRun ? "would-send" : "sent",
      };
      result.sends.push(attempt);

      let sendResult;
      try {
        sendResult = await ctx.send({
          phone: enrollment.phone,
          templateId: config.templateId,
          meta: config.providerMeta,
          params,
          channelId: campaign.channelId,
        });
      } catch (err) {
        // Sending switched off, or this number isn't on the allowlist, between
        // the batch being picked up and this send. Nothing has been written to
        // the enrollment yet (rule 2), and nothing will be: the tick is
        // abandoned whole and the lead stays queued exactly as it was. A
        // closed gate must never burn a lead as failed.
        if (err.sendingDisabled || err.notAllowlisted) {
          attempt.status = "gated";
          attempt.error = err.message;
          result.stop = "gated";
          result.reason = err.message;
          return result;
        }
        attempt.status = "error";
        attempt.error = err.message;
        result.history.push({
          nodeId: node.id,
          templateId: config.templateId,
          sentAt: ctx.now,
          status: "error",
          error: err.message,
        });
        return park(result, "failed", err.message);
      }

      const providerMessageId = extractSentMessageId(sendResult);
      const providerLocalMessageId = extractSentLocalMessageId(sendResult);
      attempt.providerMessageId = providerMessageId;
      attempt.providerLocalMessageId = providerLocalMessageId;
      result.history.push({
        nodeId: node.id,
        templateId: config.templateId,
        sentAt: ctx.now,
        status: "sent",
        providerMessageId,
        providerLocalMessageId,
      });

      // A send is the one point where the walker hands control back to the
      // poller: it has just had a real-world effect, and bundling further
      // automatic progress behind it would hide that effect inside a longer
      // chain. The lead is advanced onto the next node and picked up again on
      // the following tick.
      const next = follow(null);
      if (next === null) return result;
      result.stop = "sent";
      result.currentNodeId = next;
      result.nextSendAt = ctx.now;
      return result;
    }

    if (node.kind === "exit") {
      const config = node.config || {};
      return finish(result, node, config.outcome || config.reason || "completed", null);
    }

    // Unreachable through the model's `kind` enum, but a graph written straight
    // into the collection could still carry one.
    result.currentNodeId = node.id;
    return park(result, "paused", `node "${node.id}" has an unknown kind "${node.kind}"`);
  }
}

/**
 * Commit a walk result onto the enrollment.
 *
 * The single write point for the whole tick. A gated result writes nothing at
 * all - not even the currentNodeId the walk had already moved past decision
 * nodes to reach the message - so a closed kill switch leaves the row byte for
 * byte as it was and it comes back round on the next poll.
 */
async function applyWalkResult(enrollment, result, { persist }) {
  if (result.stop === "gated") return enrollment;

  if (!Array.isArray(enrollment.history)) enrollment.history = [];
  for (const entry of result.history) enrollment.history.push(entry);
  if (result.currentNodeId !== undefined && result.currentNodeId !== null) {
    enrollment.currentNodeId = result.currentNodeId;
  }
  if (result.status) enrollment.status = result.status;
  if (result.nextSendAt) enrollment.nextSendAt = result.nextSendAt;
  if (result.exitOutcome) enrollment.outcome = result.exitOutcome;
  // Cleared on a clean tick so a stale "why did this stop" can't outlive the
  // condition that caused it.
  enrollment.statusReason = result.reason || null;

  if (persist && typeof enrollment.save === "function") await enrollment.save();
  return enrollment;
}

// A dry run never reaches a provider. This is the sender it gets when the
// caller doesn't supply one of its own, and it is what makes "zero outbound
// side effects" a property of the code rather than a promise.
async function noopSender() {
  return {};
}

/**
 * Advance one enrollment by one tick. The graph-era replacement for
 * advanceEnrollment.
 *
 *   walkEnrollment(enrollment, campaign, options)
 *
 * options:
 *   now      Date | number | string | () => Date - the instant the whole tick
 *            is evaluated at, frozen for its duration. Defaults to real time.
 *   send     async ({ phone, templateId, params, meta, channelId }) => result -
 *            the sender. Defaults to whatsappProvider.sendMessage; in a dry
 *            run it defaults to a no-op that returns {}.
 *   dryRun   boolean - forces the no-op sender when no sender is given and
 *            never persists the enrollment. The in-memory enrollment is still
 *            advanced exactly as a live tick would advance it, so successive
 *            dry-run calls walk a flow forward across ticks.
 *   hopLimit number - node visits allowed in this tick (default 50).
 *   deps     { resolveSource, MessageEvent, activitySinceLastSend } - the seam
 *            the verify harness substitutes to walk a graph without touching
 *            the real sources.
 *
 * Returns the walk result: { stop, reason, visited[], path[], sends[],
 * history[], currentNodeId, nextSendAt, status, exitOutcome, hops }. `sends`
 * is the "what would have been sent" description a dry run reports - one entry
 * per message node passed through, carrying the rendered params.
 *
 * Never throws. Every failure path parks the enrollment with a reason instead,
 * because this runs inside a loop over a batch of other people's enrollments.
 */
async function walkEnrollment(enrollment, campaign, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const ctx = {
    enrollment,
    campaign,
    now: resolveNow(options.now),
    dryRun,
    send: options.send || (dryRun ? noopSender : whatsappProvider.sendMessage),
    hopLimit: Number(options.hopLimit) > 0 ? Number(options.hopLimit) : MAX_HOPS_PER_TICK,
    deps: { ...defaultDeps(), ...(options.deps || {}) },
  };

  let result;
  try {
    result = await runWalk(enrollment, campaign, ctx);
  } catch (err) {
    // A bug in a handler, or a source that threw somewhere unguarded. The
    // enrollment is parked with the message rather than the batch dying.
    result = park(emptyResult(), "failed", `graph walk failed: ${err.message}`);
    console.error(`[campaignEngine] walk error on enrollment ${enrollment._id}:`, err.message);
  }

  try {
    await applyWalkResult(enrollment, result, { persist: !dryRun });
  } catch (err) {
    console.error(`[campaignEngine] could not save enrollment ${enrollment._id}:`, err.message);
    result.saveError = err.message;
  }
  return result;
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
    // track and a row would read as an attempt that failed. Matches how the
    // graph walker treats a closed gate.
    if (err.sendingDisabled || err.notAllowlisted) throw err;
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
    await walkEnrollment(enrollment, campaign);
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

// The read side (showing a lead's details) no longer goes through this module:
// loading the target document from whichever source the campaign points at is
// lib/sourceResolver.js's job, and callers reach for it directly.
module.exports = {
  enrollTargets,
  previewTargets,
  sendSingleMessage,
  walkEnrollment,
  resolveWaitAt,
  processDueEnrollments,
  processAutoEnroll,
  startScheduler,
  MAX_HOPS_PER_TICK,
};
