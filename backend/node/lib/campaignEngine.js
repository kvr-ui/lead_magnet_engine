const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");
const MessageEvent = require("../models/MessageEvent");
const { cleanPhone } = require("./phone");
const whatsappProvider = require("./whatsappProvider");
const { resolveSource } = require("./sourceResolver");
const { enrollCampaignTargets } = require("./campaignTargets");
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
// The interval governs mid-flow progress — a wait that has elapsed, the node
// after a send — not the first message of an enrol: /enroll kicks a tick of
// its own the moment it has written its rows, so nothing that is due the
// instant it is created sits waiting for the clock.
const POLL_INTERVAL_MS = parseInt(process.env.CAMPAIGN_POLL_INTERVAL_MS, 10) || 30 * 1000;
// How often armed campaigns rescan their source for newly-matching targets.
// Separate from the send poll because it's a different kind of work: a full
// scan of an external database rather than a read of our own due queue.
const AUTO_ENROLL_INTERVAL_MS = parseInt(process.env.CAMPAIGN_AUTO_ENROLL_INTERVAL_MS, 10) || 5 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// How long an `action` node's outbound call (or source write-back) may take
// before it is abandoned. An action runs inside the poll tick, so an endpoint
// that accepts a connection and then never answers would otherwise hold up
// every other lead in the batch behind it.
const ACTION_TIMEOUT_MS = parseInt(process.env.CAMPAIGN_ACTION_TIMEOUT_MS, 10) || 10_000;

// The outcome recorded when a `goal` node's threshold is met and nothing
// further down the "yes" branch labels the ending itself.
const GOAL_MET_OUTCOME = "goal_met";

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

// --- split -----------------------------------------------------------------

/**
 * 32-bit FNV-1a over a string. Pure, dependency-free, and — the only property
 * that actually matters here — identical every time it is given the same
 * input, in this process or any other.
 */
function stableHash(value) {
  const text = String(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, multiplied through Math.imul so the result stays a 32-bit
    // integer instead of drifting into float precision after a few rounds.
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Which side of a `split` this lead falls on.
 *
 * Derived from a hash of the enrollment's targetId and nothing else — never
 * Math.random(), never the clock, never a counter. A lead that is re-evaluated
 * (walked again after a park, or revisited by a loop) has to land on the same
 * side every single time: one that flipped would receive both variants of the
 * A/B test it is in, which both misleads the lead and destroys the result the
 * split exists to measure.
 *
 * `ratio` is the percentage taking branch "a"; the rest take "b". It is
 * required rather than defaulted, because a split with no ratio has no honest
 * answer and guessing 50 would quietly invent an experiment nobody designed.
 */
function splitBranchFor(node, enrollment) {
  const config = node.config || {};
  const ratio = Number(config.ratio);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 100) {
    throw new Error(`has ratio "${config.ratio}", which is not a percentage between 0 and 100`);
  }
  const targetId = enrollment.targetId;
  if (targetId === undefined || targetId === null || String(targetId) === "") {
    throw new Error("has no targetId to derive a stable branch from");
  }
  return stableHash(String(targetId)) % 100 < ratio ? "a" : "b";
}

// --- goal ------------------------------------------------------------------

function goalOutcomeFor(node) {
  const config = node.config || {};
  return config.outcome || GOAL_MET_OUTCOME;
}

/**
 * Has this lead done enough, since we last messaged them, to count as
 * converted?
 *
 *   config: { metric: "count" | "correct" | "graded", threshold: Number,
 *             outcome?: String }
 *
 * The rollup comes from lib/leadActivity.js, which owns the join between an
 * enrollment and the lead magnet's own activity collection, and whose cutoff is
 * already the enrollment's last send (falling back to its creation time when it
 * has never sent). That cutoff is the whole point: activity from before we
 * messaged them is the lead's own doing and must not be credited to this drip.
 * Reusing that rollup rather than re-querying here is what keeps the goal node
 * and the activity reporting screens answering the same question.
 *
 * Returns the decision plus the numbers behind it, so the park/branch reason
 * can say what it actually measured.
 */
async function evaluateGoal(node, ctx) {
  const config = node.config || {};
  const metric = String(config.metric || "count").toLowerCase();
  const declared = Number(config.threshold === undefined ? config.count : config.threshold);
  const threshold = Number.isFinite(declared) ? declared : 1;

  const rollup = await ctx.deps.activitySinceLastSend(ctx.enrollment);
  // Nothing is connected that records activity at all, so this node cannot
  // honestly answer its own question. Park rather than pick a branch: routing
  // every lead down "no" would read as "nobody converted" when the truth is
  // "nobody was measured".
  if (!rollup.configured) {
    throw new Error("needs a data source with an activity config, and none is connected");
  }

  const value = (metric === "correct" ? rollup.correct : metric === "graded" ? rollup.graded : rollup.count) || 0;
  return { met: value >= threshold, value, threshold, metric, since: rollup.since };
}

// --- action ----------------------------------------------------------------

/**
 * The one node kind that writes. Two shapes, told apart by `config.mode` and,
 * when that is absent, by which keys are present:
 *
 *   { mode: "http",   url, method, body, enabled: true }
 *   { mode: "source", field, value, enabled: true }
 *
 * Both interpolate canonical lead values into their strings as {{phone}},
 * {{name}}, … read off the same live document a message node renders its
 * template params from — so an action addresses a lead the same way every
 * other node does, by canonical key rather than by whatever the source calls
 * its columns.
 */
function actionModeFor(config) {
  const declared = normalizeBranch(config.mode);
  if (declared === "http" || declared === "source") return declared;
  if (config.url) return "http";
  if (config.field) return "source";
  return null;
}

function interpolate(value, doc) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_whole, key) => formatParamValue((doc || {})[key]));
  }
  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, doc));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolate(entry, doc)]));
  }
  return value;
}

// A hard wall-clock bound around a promise that has its own, softer idea of a
// timeout. maxTimeMS bounds how long MongoDB will *execute* a write; it says
// nothing about a connection that never answers. This says something about it.
function withTimeout(promise, timeoutMs, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function performHttpAction(config, doc, { timeoutMs }) {
  const url = interpolate(String(config.url || ""), doc);
  if (!url) throw new Error("has no url to call");
  const method = String(config.method || "POST").toUpperCase();
  const sendsBody = method !== "GET" && method !== "HEAD" && config.body !== undefined && config.body !== null;
  const body = sendsBody ? interpolate(config.body, doc) : undefined;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: sendsBody ? { "content-type": "application/json" } : undefined,
      body: sendsBody ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
    });
    // Any non-2xx is a failure. The lead must not walk on as though the write
    // landed just because the endpoint answered.
    if (!response.ok) throw new Error(`${method} ${url} returned ${response.status}`);
    return { detail: `${method} ${url} returned ${response.status}` };
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`${method} ${url} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// `field` names a raw field on the source's own documents (not a canonical
// key): this writes back into the lead magnet's collection, so it has to speak
// that collection's own vocabulary. `value` may still interpolate canonical
// keys, which is the direction that does translate.
async function performSourceWriteAction(config, doc, ctx, { timeoutMs }) {
  const field = String(config.field || "");
  if (!field) throw new Error("names no source field to write back to");
  const value = interpolate(config.value === undefined ? "" : config.value, doc);
  const source = await ctx.source();
  const targetId = ctx.enrollment.targetId;

  const update =
    source.kind === "model"
      ? source.model.updateOne({ _id: targetId }, { $set: { [field]: value } }).maxTimeMS(timeoutMs)
      : source.collection.updateOne({ _id: targetId }, { $set: { [field]: value } }, { maxTimeMS: timeoutMs });

  const outcome = await withTimeout(update, timeoutMs, `writing "${field}" back to the source`);
  if (!outcome || outcome.matchedCount === 0) {
    throw new Error(`no source document matched ${targetId}, so "${field}" was not written`);
  }
  return { detail: `set "${field}" on source document ${targetId}` };
}

// The real executor. Exported so the verify harness can drive the genuine
// timeout/failure paths against a server it controls, rather than asserting
// against a stand-in that only claims to time out.
async function performAction(node, ctx) {
  const config = node.config || {};
  const declaredTimeout = Number(config.timeoutMs);
  const timeoutMs = Number.isFinite(declaredTimeout) && declaredTimeout > 0 ? declaredTimeout : ACTION_TIMEOUT_MS;
  const mode = actionModeFor(config);
  const doc = await ctx.target();

  if (mode === "http") return performHttpAction(config, doc, { timeoutMs });
  if (mode === "source") return performSourceWriteAction(config, doc, ctx, { timeoutMs });
  throw new Error('is neither an HTTP call (needs "url") nor a source write-back (needs "field")');
}

// What a dry run gets instead. The same guarantee noopSender gives for sends:
// "no side effect" is a property of which function is wired in, not a promise
// made by the one that would have made the call.
async function noopActionRunner(node) {
  return { detail: `dry run — action node "${node.id}" was not performed`, dryRun: true };
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
    // How the tick ended: "sent", "acted", "waiting", "completed", "paused",
    // "failed", or "gated" (the kill switch or the allowlist refused the send
    // or the action, so nothing at all is applied to the enrollment).
    stop: null,
    reason: null,
    status: null,
    currentNodeId: undefined,
    nextSendAt: null,
    exitOutcome: null,
    // Set when a `goal` node's threshold was met during this walk, so an
    // unlabelled exit downstream can inherit the conversion. Walk-local: it is
    // never written to the enrollment, only folded into exitOutcome.
    goalOutcome: null,
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
    isSendingEnabled,
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
  let sourceHandle;
  let targetDoc;
  let targetRead = false;
  // The resolved source itself, memoised per tick. Reading the lead only needs
  // ctx.target() below; an `action` node's source write-back needs the handle,
  // because it writes to the source's own collection rather than to a
  // canonical view of it.
  ctx.source = async () => {
    if (!sourceHandle) sourceHandle = await ctx.deps.resolveSource(sourceId, map);
    return sourceHandle;
  };
  // One live read per tick, shared by every node that needs it. "Live" is the
  // point - a message node's params and a field condition's comparison both
  // have to see the lead as they are now, not as they were when enrolled.
  ctx.target = async () => {
    if (!targetRead) {
      const source = await ctx.source();
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

    if (node.kind === "split") {
      let branch;
      try {
        branch = splitBranchFor(node, enrollment);
      } catch (err) {
        result.currentNodeId = node.id;
        return park(result, "paused", `split node "${node.id}" ${err.message}`);
      }
      const next = follow(branch);
      if (next === null) return result;
      cursor = next;
      continue;
    }

    if (node.kind === "goal") {
      let goal;
      try {
        goal = await evaluateGoal(node, ctx);
      } catch (err) {
        result.currentNodeId = node.id;
        return park(result, "paused", `goal node "${node.id}" ${err.message}`);
      }

      const branch = goal.met ? "yes" : "no";
      // Carried so an `exit` further down the "yes" branch that doesn't label
      // itself still completes the lead as a conversion rather than flattening
      // it to a generic "completed". An exit that DOES declare an outcome wins:
      // it is the more specific statement of how this flow ends.
      if (goal.met) result.goalOutcome = goalOutcomeFor(node);

      // Deliberately not routed through follow(): a "yes" branch with nowhere
      // to go is still a conversion, and follow()'s implicit exit would record
      // it as an unlabelled ending.
      step.branch = branch;
      const edge = pickEdge(version, node.id, branch);
      if (!edge) {
        return finish(
          result,
          node,
          goal.met ? goalOutcomeFor(node) : null,
          `no outgoing edge from "${node.id}" for branch "${branch}"`
        );
      }
      cursor = edge.to;
      continue;
    }

    if (node.kind === "action") {
      const config = node.config || {};

      // Two gates, in this order and for different reasons.
      //
      // The kill switch is first and unconditional: "sending is off" has to
      // leave the enrollment byte for byte as it was, whatever else may be
      // wrong with the node, exactly as a message send hitting a closed gate
      // does. Nothing is written, nothing is advanced, and the lead comes back
      // round on the next poll.
      if (!(await ctx.deps.isSendingEnabled())) {
        result.stop = "gated";
        result.reason = `sending is off, so action node "${node.id}" did not fire`;
        return result;
      }

      // Then the node's own opt-in, which is separate on purpose. This is the
      // only kind that writes to the world, so publishing a graph containing
      // one must never be enough to make it fire. Parked rather than skipped:
      // walking past a write that a later node may depend on, without saying
      // so, is how a flow ends up quietly half-done.
      if (config.enabled !== true) {
        result.currentNodeId = node.id;
        return park(
          result,
          "paused",
          `action node "${node.id}" is disabled — an action writes to the world, so it never fires until its own config sets enabled: true`
        );
      }

      let outcome;
      try {
        outcome = await ctx.performAction(node, ctx);
      } catch (err) {
        // A failed or timed-out write must not look like a successful one. The
        // failure is recorded and the lead stops here rather than walking on as
        // if the write had landed.
        result.history.push({
          kind: "action",
          nodeId: node.id,
          sentAt: ctx.now,
          status: "error",
          error: err.message,
        });
        result.currentNodeId = node.id;
        return park(result, "failed", `action node "${node.id}" failed: ${err.message}`);
      }

      result.history.push({
        kind: "action",
        nodeId: node.id,
        sentAt: ctx.now,
        status: "ok",
        detail: (outcome && outcome.detail) || null,
      });

      const next = follow(null);
      if (next === null) return result;
      // The tick ends here, exactly as it does after a send, and for the same
      // reason plus a sharper one. The sharper one: a result is committed whole
      // or not at all, and a later node in this same tick hitting the kill
      // switch would discard the whole result — including the record of a write
      // that really did happen, which would then fire a second time next tick.
      result.stop = "acted";
      result.currentNodeId = next;
      result.nextSendAt = ctx.now;
      return result;
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
      // An exit that labels itself wins. Failing that, a goal met earlier in
      // this walk names the ending, so a converted lead is recorded as
      // converted rather than as generically "completed".
      return finish(result, node, config.outcome || config.reason || result.goalOutcome || "completed", null);
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
 *   performAction async (node, ctx) => { detail } - runs an `action` node's
 *            outbound call or source write-back. Defaults to the real executor;
 *            in a dry run it defaults to a no-op that performs nothing and
 *            reports as much.
 *   dryRun   boolean - forces the no-op sender and the no-op action runner when
 *            neither is given, and
 *            never persists the enrollment. The in-memory enrollment is still
 *            advanced exactly as a live tick would advance it, so successive
 *            dry-run calls walk a flow forward across ticks.
 *   hopLimit number - node visits allowed in this tick (default 50).
 *   deps     { resolveSource, MessageEvent, isSendingEnabled,
 *            activitySinceLastSend } - the seam the verify harness substitutes
 *            to walk a graph without touching the real sources.
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
    // Same seam as `send`, for the same reason: a dry run must not be able to
    // make an outbound call or write to a source, and the harness needs to be
    // able to drive the real one deliberately.
    performAction: options.performAction || (dryRun ? noopActionRunner : performAction),
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
// Safe to re-run: the enrol write upserts on (campaign, targetModel, targetId),
// so already-enrolled targets are skipped rather than restarted at the entry
// node of the graph.
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
      // The segment lives on the published graph's source nodes now, each
      // carrying its own filter, so a rescan re-runs the graph rather than one
      // stored filter. campaign.autoEnrollFilter is the record of what /enroll
      // previewed and confirmed when auto-enrol was armed, and the marker that
      // it is armed at all; it is no longer the query itself.
      const result = await enrollCampaignTargets(campaign);
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
let pollRunning = false;

// One send tick at a time, whoever asked for it. Load-bearing rather than
// tidy: a due row is not claimed when it is loaded, so two overlapping ticks
// would each walk the same enrollment and each send its message. The interval
// and the kick after an enrol both come through here for that reason.
async function runPollTick() {
  if (pollRunning) return { processed: 0, skipped: "a poll tick is already running" };
  pollRunning = true;
  try {
    return await processDueEnrollments();
  } finally {
    pollRunning = false;
  }
}

// An enrol writes rows that are due the moment they exist, so run a tick
// straight away rather than leaving the first message of a campaign sitting in
// the queue until the interval next comes round.
//
// Fire-and-forget on purpose: never awaited by the caller and never throwing
// at it, because a tick that fails must not turn a successful enrol into an
// error response — the rows are written either way, and the interval retries.
function kickPoll() {
  runPollTick().catch((err) => console.error("[campaignEngine] kick error:", err.message));
}

// Always polls, regardless of whether a provider is connected at boot —
// the connection can be made/broken later from the Integrations tab without
// a restart, and processDueEnrollments() already no-ops per tick when
// nothing's connected.
function startScheduler() {
  if (pollHandle) return;
  pollHandle = setInterval(() => {
    runPollTick().catch((err) => console.error("[campaignEngine] poll error:", err.message));
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
// lib/sourceResolver.js's job, and callers reach for it directly. Deciding who
// enters a campaign, and on which node, is lib/campaignTargets.js's; this
// module is left owning sending and the two schedulers.
module.exports = {
  sendSingleMessage,
  walkEnrollment,
  resolveWaitAt,
  // Exported for the verify harness, which drives the genuine HTTP/write paths
  // (timeout, non-2xx, success) against a server it starts itself.
  performAction,
  splitBranchFor,
  ACTION_TIMEOUT_MS,
  GOAL_MET_OUTCOME,
  processDueEnrollments,
  processAutoEnroll,
  startScheduler,
  kickPoll,
  MAX_HOPS_PER_TICK,
};
