const AppSetting = require("../models/AppSetting");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");

/**
 * Account-level sending policy: a global frequency cap and quiet-hours
 * window, enforced across every campaign for one phone number, plus a toggle
 * for whether a manual one-off send (POST /api/campaigns/send-message) counts
 * against the same cap.
 *
 * Stored the same way the kill switch is (see lib/sendingSwitch.js): a single
 * row in the schemaless AppSetting key/value store, so adding or reshaping a
 * field here never needs a migration. Two different keys, not two fields on
 * one row, because they are toggled independently and by different people —
 * an operator flips the kill switch far more often than they'll ever touch
 * this policy.
 *
 * OFF by default (`enabled: false`), and every sub-setting defaults to "does
 * nothing" too, so a fresh install or a wiped database behaves exactly as it
 * did before this file existed. A failed read is treated the same way a
 * missing row is — fail toward "don't throttle anything" — for the same
 * reason lib/sendingSwitch.js fails toward "don't send anything": silence
 * must never be the reason a policy that was never actually configured
 * starts deferring real sends.
 *
 * Quiet hours are expressed in exactly the shape the wait node's `window` /
 * `skipDays` config already uses (see the "wait scheduling" section of
 * lib/campaignEngine.js) and are enforced with that same module's exported
 * `clampToWindow` — this file does not implement a second timezone/DST-aware
 * clamp, it only calls the one that already exists.
 */

const KEY = "sendPolicy";

const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  // count: 0 means "no cap configured" (a cap of zero would mean "never
  // send", which nobody wants and nothing in the UI offers, so 0 reads as
  // "off" rather than "block everything").
  maxPerContact: Object.freeze({ count: 0, windowMinutes: 60 }),
  // window: null means "no time-of-day restriction"; skipDays: [] means "no
  // weekday is skipped". Both can be set independently, exactly like a wait
  // node's config.
  quietHours: Object.freeze({ window: null, tz: "UTC", skipDays: [] }),
  countManualSends: false,
});

function normalizeWindow(value) {
  if (!value || typeof value !== "object") return null;
  const from = value.from === undefined || value.from === null ? null : String(value.from);
  const to = value.to === undefined || value.to === null ? null : String(value.to);
  if (!from || !to) return null;
  return { from, to };
}

function normalizeSkipDays(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(Number)
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
}

/**
 * Fills in every field of a possibly-partial/possibly-garbled stored value
 * with its default, rather than trusting whatever shape happens to be sitting
 * in Mongo. A hand-edited row, a value left over from an earlier draft of
 * this feature, or a plain `{}` from `setSendPolicy` all come out as a
 * complete, safely-typed policy.
 */
function normalizePolicy(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const maxPerContact = value.maxPerContact && typeof value.maxPerContact === "object" ? value.maxPerContact : {};
  const quietHours = value.quietHours && typeof value.quietHours === "object" ? value.quietHours : {};

  const count = Number(maxPerContact.count);
  const windowMinutes = Number(maxPerContact.windowMinutes);

  return {
    enabled: value.enabled === true,
    maxPerContact: {
      count: Number.isFinite(count) && count > 0 ? count : DEFAULT_POLICY.maxPerContact.count,
      windowMinutes:
        Number.isFinite(windowMinutes) && windowMinutes > 0
          ? windowMinutes
          : DEFAULT_POLICY.maxPerContact.windowMinutes,
    },
    quietHours: {
      window: normalizeWindow(quietHours.window),
      tz: quietHours.tz ? String(quietHours.tz) : DEFAULT_POLICY.quietHours.tz,
      skipDays: normalizeSkipDays(quietHours.skipDays),
    },
    countManualSends: value.countManualSends === true,
  };
}

/**
 * The effective policy right now. Never throws — a bad read is treated as
 * "not configured", not as an error the caller has to handle, which is what
 * lets the message node call this on every tick without a try/catch of its
 * own.
 */
async function getSendPolicy() {
  let doc;
  try {
    doc = await AppSetting.findOne({ key: KEY }).lean();
  } catch {
    return normalizePolicy(null);
  }
  return normalizePolicy(doc && doc.value);
}

/**
 * Merge `patch` onto the current policy and persist the result. Shallow keys
 * (`enabled`, `countManualSends`) overwrite outright; `maxPerContact` and
 * `quietHours` merge field-by-field so the admin UI (task 11) can patch one
 * knob — say, just `quietHours.tz` — without having to resend the whole
 * object.
 */
async function setSendPolicy(patch) {
  const current = await getSendPolicy();
  const incoming = patch && typeof patch === "object" ? patch : {};
  const merged = normalizePolicy({
    ...current,
    ...incoming,
    maxPerContact: { ...current.maxPerContact, ...(incoming.maxPerContact || {}) },
    quietHours: { ...current.quietHours, ...(incoming.quietHours || {}) },
  });
  await AppSetting.findOneAndUpdate({ key: KEY }, { $set: { value: merged } }, { upsert: true });
  return merged;
}

/**
 * How many messages this phone number has been sent, across every campaign,
 * since `since` — plus the oldest of those sends, which is what the caller
 * needs to compute when the cap will next admit a send (the instant that
 * oldest send ages out of the window).
 *
 * Counted from CampaignEnrollment history, not from MessageEvent: history is
 * written synchronously in the same tick as the send, while a MessageEvent
 * depends on the provider's webhook arriving later. A cap fed by the webhook
 * stream would under-count — and therefore under-throttle — whenever a
 * webhook lags or is misconfigured, which is a safety feature failing open
 * exactly when it matters most.
 *
 * `includeManual` folds in DirectMessage rows (POST /api/campaigns/send-message,
 * outside any campaign) too, when the operator has opted manual sends into
 * the same cap — the goal is "don't spam this person", not "don't spam this
 * person from campaigns specifically".
 */
async function recentSendCount(phone, since, { includeManual = false } = {}) {
  const campaignSends = await CampaignEnrollment.aggregate([
    { $match: { phone } },
    { $unwind: "$history" },
    { $match: { "history.status": "sent", "history.sentAt": { $gte: since } } },
    { $project: { _id: 0, sentAt: "$history.sentAt" } },
  ]);

  const manualSends = includeManual
    ? await DirectMessage.find({ phone, status: "sent", sentAt: { $gte: since } }, { _id: 0, sentAt: 1 }).lean()
    : [];

  const all = campaignSends.concat(manualSends);
  if (!all.length) return { count: 0, oldestAt: null };

  let oldestAt = all[0].sentAt;
  for (const row of all) if (row.sentAt < oldestAt) oldestAt = row.sentAt;
  return { count: all.length, oldestAt };
}

// --- Validation (task 11: admin UI) -----------------------------------
//
// normalizePolicy() above is deliberately forgiving — a bad shape from a
// hand-edited row or an old draft is silently coerced to a safe default so
// the walker never throws. That is the wrong behavior for an operator typing
// into a form: an inverted quiet-hours window, a zero/negative cap, or a
// typo'd timezone would otherwise be "corrected" without a word and only
// show up later as an enrollment parked for a reason nobody configured on
// purpose. validatePolicyPatch() is the strict counterpart used by the route
// before anything reaches setSendPolicy() — pure (no I/O), so it can run
// ahead of the database call and be exercised directly by the verify
// harness. It does not change normalizePolicy's own defaulting semantics.
function isValidTimeOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value === undefined || value === null ? "" : value).trim());
  if (!match) return false;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59;
}

function timeToMinutes(value) {
  const [h, m] = String(value).trim().split(":").map(Number);
  return h * 60 + m;
}

function isKnownTimeZone(tz) {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a patch of the same shape setSendPolicy() accepts and returns an
 * array of specific, user-facing problem descriptions — empty means the
 * patch is safe to persist. Only fields actually present in the patch are
 * checked, matching setSendPolicy's own partial-merge behavior: a caller
 * patching just `enabled` is not forced to also resend a valid cap.
 */
function validatePolicyPatch(patch) {
  const errors = [];
  const value = patch && typeof patch === "object" ? patch : {};

  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    errors.push("enabled must be true or false");
  }
  if (value.countManualSends !== undefined && typeof value.countManualSends !== "boolean") {
    errors.push("countManualSends must be true or false");
  }

  if (value.maxPerContact !== undefined) {
    const cap = value.maxPerContact && typeof value.maxPerContact === "object" ? value.maxPerContact : {};
    if (cap.count !== undefined) {
      const count = Number(cap.count);
      if (!Number.isFinite(count) || count <= 0) {
        errors.push("max-per-contact count must be a positive number");
      }
    }
    if (cap.windowMinutes !== undefined) {
      const windowMinutes = Number(cap.windowMinutes);
      if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) {
        errors.push("max-per-contact window must be a positive number of minutes");
      }
    }
  }

  if (value.quietHours !== undefined) {
    const quietHours = value.quietHours && typeof value.quietHours === "object" ? value.quietHours : {};

    if (quietHours.window !== undefined && quietHours.window !== null) {
      const win = quietHours.window && typeof quietHours.window === "object" ? quietHours.window : {};
      if (!isValidTimeOfDay(win.from) || !isValidTimeOfDay(win.to)) {
        errors.push("quiet hours window must have valid HH:MM start and end times");
      } else if (timeToMinutes(win.from) >= timeToMinutes(win.to)) {
        errors.push("quiet hours window end time must be after its start time");
      }
    }

    if (quietHours.tz !== undefined && quietHours.tz !== null && String(quietHours.tz).trim() !== "") {
      if (!isKnownTimeZone(String(quietHours.tz))) {
        errors.push(`quiet hours timezone "${quietHours.tz}" is not a recognized timezone`);
      }
    }
  }

  return errors;
}

module.exports = {
  getSendPolicy,
  setSendPolicy,
  recentSendCount,
  validatePolicyPatch,
  DEFAULT_POLICY,
};
