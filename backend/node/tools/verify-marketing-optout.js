// Verifies routing the WhatsApp marketing template's built-in opt-out button
// into the same global opt-out path STOP-keyword replies already use
// (routes/wati.js, matchMarketingOptOutButton / matchStopKeyword, both feeding
// the unmodified recordOptOut()).
//
// Same self-hosting pattern as verify-webhook-auth.js: the real router is
// mounted on a throwaway Express app on an ephemeral port and driven with
// real HTTP requests carrying the shared secret, so the test proves the exact
// code path production traffic takes without reaching WATI. Requires a real
// WhatsAppIntegration to already be connected in the local dev Mongo (read
// -only — never written to); if none is connected the whole suite is SKIPped,
// mirroring verify-webhook-auth.js's convention.
//
// Run:  node tools/verify-marketing-optout.js
const express = require("express");
const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const MessageEvent = require("../models/MessageEvent");
const OptOut = require("../models/OptOut");
const WhatsAppIntegration = require("../models/WhatsAppIntegration");
const watiRouter = require("../routes/wati");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";
const PREFIX = "__verify_marketing_optout__";

const BUTTON_PHONE = "919000000801"; // taps the known opt-out button label -> opted out + enrollments cancelled
const OTHER_BUTTON_PHONE = "919000000802"; // taps an unrelated button label -> untouched
const TYPED_TEXT_PHONE = "919000000803"; // types the label as plain text (no button interactive type) -> untouched

const CAMPAIGN_NAME = `${PREFIX}_campaign`;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const skip = (name, reason) => {
  console.log(`SKIP  ${name} — ${reason}`);
};

let server = null;
let baseUrl = "";

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", watiRouter);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
}

function post(secret, body) {
  return fetch(`${baseUrl}/api/wati/webhook?secret=${encodeURIComponent(secret)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A realistic inbound button-tap event shape (see verify-webhook.js's W2
// fixture): `type: "button"`, no separate payload id, the label in `text`.
const buttonEvent = (phone, wamid, label) => ({
  eventType: "message",
  waId: phone,
  whatsappMessageId: wamid,
  replyContextId: `wamid.${PREFIX}.SENT`,
  owner: false,
  statusString: "SENT",
  text: label,
  type: "button",
});

// Same label, but typed as an ordinary text message — no interactive type at
// all — to prove the button-only requirement actually gates this path.
const textEvent = (phone, wamid, text) => ({
  eventType: "message",
  waId: phone,
  whatsappMessageId: wamid,
  replyContextId: `wamid.${PREFIX}.SENT`,
  owner: false,
  statusString: "SENT",
  text,
});

(async () => {
  await mongoose.connect(URI);
  await startServer();

  const allPhones = [BUTTON_PHONE, OTHER_BUTTON_PHONE, TYPED_TEXT_PHONE];
  const wamids = {
    button: `wamid.${PREFIX}.BUTTON`,
    otherButton: `wamid.${PREFIX}.OTHER_BUTTON`,
    typedText: `wamid.${PREFIX}.TYPED_TEXT`,
  };

  const wipe = async () => {
    await MessageEvent.deleteMany({ providerMessageId: { $in: Object.values(wamids) } });
    await CampaignEnrollment.deleteMany({ phone: { $in: allPhones } });
    await Campaign.deleteMany({ name: CAMPAIGN_NAME });
    await OptOut.deleteMany({ phone: { $in: allPhones } });
  };

  try {
    await wipe();

    const active = await WhatsAppIntegration.findOne({ active: true });
    if (!active) {
      skip("marketing opt-out button suite", "no WhatsApp integration is connected in this environment");
    } else {
      const secret = active.webhookSecret;

      const campaign = await Campaign.create({ name: CAMPAIGN_NAME });
      const seedEnrollment = (phone, status) =>
        CampaignEnrollment.create({
          campaign: campaign._id,
          targetModel: "Lead",
          targetId: new mongoose.Types.ObjectId(),
          phone,
          status,
          graphVersion: 1,
          currentNodeId: "n_text",
          nextSendAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });

      // --- known opt-out button label -> opts out + cancels enrollments ----
      await seedEnrollment(BUTTON_PHONE, "active");
      await seedEnrollment(BUTTON_PHONE, "paused");

      const res1 = await post(secret, buttonEvent(BUTTON_PHONE, wamids.button, "Stop promotions"));
      check("known button label -> webhook accepts (200)", res1.status === 200, `got ${res1.status}`);
      await new Promise((r) => setTimeout(r, 300));

      const optOutRow = await OptOut.findOne({ phone: BUTTON_PHONE });
      check("known button label -> global OptOut row created", Boolean(optOutRow), JSON.stringify(optOutRow));
      check(
        "OptOut row records the button label as the keyword",
        optOutRow?.keyword === "Stop promotions",
        `got ${optOutRow?.keyword}`
      );
      const remainingActive = await CampaignEnrollment.countDocuments({
        phone: BUTTON_PHONE,
        status: { $in: ["active", "paused"] },
      });
      check(
        "known button label -> every active/paused enrollment for that phone is cancelled",
        remainingActive === 0,
        `${remainingActive} still active/paused`
      );
      const cancelledCount = await CampaignEnrollment.countDocuments({ phone: BUTTON_PHONE, status: "cancelled" });
      check(
        "known button label -> both seeded enrollments landed as cancelled",
        cancelledCount === 2,
        `cancelled=${cancelledCount}`
      );

      // --- case/whitespace normalisation ------------------------------------
      // Re-seed a fresh active row and send the label padded and re-cased —
      // still recognised.
      await OptOut.deleteMany({ phone: BUTTON_PHONE });
      await seedEnrollment(BUTTON_PHONE, "active");
      const res1b = await post(
        secret,
        buttonEvent(BUTTON_PHONE, `${wamids.button}.NORMALIZED`, "  STOP PROMOTIONS  ")
      );
      check("padded/re-cased button label -> webhook accepts (200)", res1b.status === 200, `got ${res1b.status}`);
      await new Promise((r) => setTimeout(r, 300));
      const optOutRow2 = await OptOut.findOne({ phone: BUTTON_PHONE });
      check(
        "padded/re-cased button label still matches -> OptOut row created",
        Boolean(optOutRow2),
        JSON.stringify(optOutRow2)
      );

      // --- other button label -> not treated as opt-out ---------------------
      await seedEnrollment(OTHER_BUTTON_PHONE, "active");
      const res2 = await post(secret, buttonEvent(OTHER_BUTTON_PHONE, wamids.otherButton, "Session A"));
      check("unrelated button label -> webhook accepts (200)", res2.status === 200, `got ${res2.status}`);
      await new Promise((r) => setTimeout(r, 300));
      const noOptOut = await OptOut.findOne({ phone: OTHER_BUTTON_PHONE });
      check("unrelated button label -> no OptOut row created", !noOptOut, JSON.stringify(noOptOut));
      const stillActive = await CampaignEnrollment.countDocuments({ phone: OTHER_BUTTON_PHONE, status: "active" });
      check("unrelated button label -> enrollment left active", stillActive === 1, `active=${stillActive}`);

      // --- typed text matching the label, but not a button interaction -----
      await seedEnrollment(TYPED_TEXT_PHONE, "active");
      const res3 = await post(secret, textEvent(TYPED_TEXT_PHONE, wamids.typedText, "Stop promotions"));
      check("typed (non-button) text -> webhook accepts (200)", res3.status === 200, `got ${res3.status}`);
      await new Promise((r) => setTimeout(r, 300));
      const noOptOutTyped = await OptOut.findOne({ phone: TYPED_TEXT_PHONE });
      check(
        "typed text reading like the button label, without interactiveType 'button', does not opt out",
        !noOptOutTyped,
        JSON.stringify(noOptOutTyped)
      );
      const stillActiveTyped = await CampaignEnrollment.countDocuments({ phone: TYPED_TEXT_PHONE, status: "active" });
      check("typed-text case -> enrollment left active", stillActiveTyped === 1, `active=${stillActiveTyped}`);

      // --- existing STOP-keyword behavior is unchanged ----------------------
      await OptOut.deleteMany({ phone: TYPED_TEXT_PHONE });
      await CampaignEnrollment.deleteMany({ phone: TYPED_TEXT_PHONE });
      await seedEnrollment(TYPED_TEXT_PHONE, "active");
      const res4 = await post(secret, textEvent(TYPED_TEXT_PHONE, `${wamids.typedText}.STOP`, "STOP"));
      check("plain STOP keyword -> webhook accepts (200)", res4.status === 200, `got ${res4.status}`);
      await new Promise((r) => setTimeout(r, 300));
      const stopOptOut = await OptOut.findOne({ phone: TYPED_TEXT_PHONE });
      check("plain STOP keyword still opts out (unchanged behavior)", Boolean(stopOptOut), JSON.stringify(stopOptOut));
      check(
        "plain STOP keyword still records the typed keyword, not a button label",
        stopOptOut?.keyword === "STOP",
        `got ${stopOptOut?.keyword}`
      );
    }
  } finally {
    await wipe();
    await stopServer();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await stopServer();
  } catch {
    /* already stopped or never started */
  }
  try {
    await mongoose.disconnect();
  } catch {
    /* already disconnected or never connected */
  }
  process.exit(1);
});
