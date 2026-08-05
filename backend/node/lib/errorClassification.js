/**
 * Classifies a send failure into one of three buckets, and computes the
 * bounded-retry backoff schedule that goes with a "retryable" one.
 *
 * Pure: no Mongo, no network, nothing async — so the graph walker's message
 * node (lib/campaignEngine.js) and tools/verify-retry-backoff.js can both
 * exercise this directly. Classification reads only the structured fields
 * lib/watiClient.js attaches at its throw sites — httpStatus,
 * providerErrorCode — never the error's message string. A message is prose
 * for a human reading a log; regexing it to decide whether to retry a network
 * call would couple retry behaviour to a sentence that is free to change for
 * readability at any time.
 *
 *   retryable     — no HTTP status at all (fetch() itself threw before any
 *                   response came back: DNS failure, timeout, connection
 *                   refused), plus 429 and the 5xx codes that mean "the
 *                   provider's problem right now, try again later" rather
 *                   than "your request is wrong": 500, 502, 503, 504.
 *   undeliverable — the provider's own error code says the number itself
 *                   cannot receive the message (bad/unregistered number).
 *                   Not a transient failure a retry would fix, but also not
 *                   evidence the customer asked to stop — see the message
 *                   node's catch block in lib/campaignEngine.js for why that
 *                   stays a human decision rather than an automatic opt-out.
 *   terminal      — everything else: bad template, malformed params, an auth
 *                   failure, or any 4xx that isn't 429.
 */

// fetch()-level failures (no response at all) are handled by the "no
// httpStatus" branch in classify() below, not listed here — they never reach
// a status code to compare against this set.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// Provider error codes observed so far that mean "this number cannot receive
// a WhatsApp message at all", spelled the way WATI/Meta have been seen to
// spell them. Extend this set as more are observed rather than guessing from
// the HTTP status alone, which a bad number can share with a dozen other
// causes (WATI returns plain 400s for most rejections).
const UNDELIVERABLE_CODES = new Set([
  "invalid_number",
  "invalid_whatsapp_number",
  "number_not_on_whatsapp",
  "not_on_whatsapp",
  "recipient_not_found",
  "phone_number_not_found",
]);

function normalizeCode(code) {
  if (code === undefined || code === null) return null;
  const text = String(code).trim().toLowerCase();
  return text.length ? text : null;
}

/**
 * classify(err) -> "retryable" | "undeliverable" | "terminal"
 *
 * `err` is whatever the provider client (lib/watiClient.js today) threw, or
 * whatever fetch() itself threw before a response existed to read a status
 * off. providerResponse is deliberately not read here — it exists so a park
 * reason can carry the provider's own words for a human, not to feed this
 * decision.
 */
function classify(err) {
  const httpStatus = err && err.httpStatus;
  // No status at all means the request never got a response to classify —
  // the network didn't deliver it, not that it was rejected. Retryable for
  // the same reason any transient network blip is.
  if (httpStatus === undefined || httpStatus === null) return "retryable";
  if (RETRYABLE_STATUSES.has(Number(httpStatus))) return "retryable";

  const code = normalizeCode(err && err.providerErrorCode);
  if (code && UNDELIVERABLE_CODES.has(code)) return "undeliverable";

  return "terminal";
}

// 1 minute, 5 minutes, 15 minutes, 1 hour, 4 hours.
const BACKOFF_SCHEDULE_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

// Overridable so an operator (or a verify harness) can shorten or lengthen
// the retry budget without a deploy. Falls back to exactly the number of
// scheduled backoff steps, so the default never needs updating in two places
// when the schedule above changes.
function maxSendAttempts() {
  const raw = parseInt(process.env.CAMPAIGN_MAX_SEND_ATTEMPTS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : BACKOFF_SCHEDULE_MS.length;
}

/**
 * The backoff, in ms, to apply after the attempt numbered `attemptNumber`
 * (1-indexed — the first failure is attempt 1) has just failed.
 *
 * Attempt numbers beyond the schedule's length — only reachable when
 * CAMPAIGN_MAX_SEND_ATTEMPTS raises the budget past the five scheduled steps
 * above — hold at the last, longest step rather than throwing or wrapping:
 * there's no reason to invent a shorter wait for attempt 6 than attempt 5.
 */
function backoffForAttempt(attemptNumber) {
  const index = Math.max(1, Number(attemptNumber) || 1) - 1;
  return BACKOFF_SCHEDULE_MS[Math.min(index, BACKOFF_SCHEDULE_MS.length - 1)];
}

module.exports = {
  classify,
  maxSendAttempts,
  backoffForAttempt,
  BACKOFF_SCHEDULE_MS,
  RETRYABLE_STATUSES,
  UNDELIVERABLE_CODES,
};
