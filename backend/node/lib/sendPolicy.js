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

module.exports = {
  getSendPolicy,
  setSendPolicy,
  recentSendCount,
  DEFAULT_POLICY,
};
