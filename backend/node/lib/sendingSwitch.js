/**
 * Global "is sending live?" kill switch, toggled from the admin header.
 *
 * OFF is the default when nothing is stored: a fresh install, a wiped
 * database or a failed read must never be the reason a real WhatsApp message
 * reaches a real person. Turning it on is an explicit, deliberate act.
 *
 * Enforced at the one chokepoint every outbound message passes through
 * (whatsappProvider.sendMessage), so no current or future call path can send
 * around it. The drip poller checks it too, but only so it can leave
 * enrollments untouched rather than burning through them against a closed
 * gate — that check is an optimisation, not the guarantee.
 */
const AppSetting = require("../models/AppSetting");

const KEY = "sendingEnabled";

const SENDING_DISABLED_MESSAGE =
  "Sending is OFF (test mode) — no message was sent. Turn sending on from the header to send for real.";

// Tagged so advanceEnrollment can tell "we deliberately didn't send" apart
// from "the provider rejected this", and leave the enrollment alone instead
// of marking the lead failed.
function sendingDisabledError() {
  const err = new Error(SENDING_DISABLED_MESSAGE);
  err.sendingDisabled = true;
  return err;
}

async function isSendingEnabled() {
  try {
    const doc = await AppSetting.findOne({ key: KEY }).lean();
    return doc?.value === true;
  } catch {
    // Can't read the switch — assume off. Silence is the safe failure here.
    return false;
  }
}

async function setSendingEnabled(enabled) {
  const value = Boolean(enabled);
  await AppSetting.findOneAndUpdate({ key: KEY }, { $set: { value } }, { upsert: true });
  return value;
}

module.exports = { isSendingEnabled, setSendingEnabled, sendingDisabledError, SENDING_DISABLED_MESSAGE };
