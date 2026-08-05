// Verifies rotateWebhookSecret() (lib/whatsappProvider.js) and the
// POST /api/integrations/whatsapp/rotate-secret route it backs — added for
// GitHub issue #33.
//
// Same pattern as verify-webhook-auth.js: the real routers are mounted on a
// throwaway Express app on an ephemeral port and driven with real HTTP
// requests; nothing here reaches WATI.
//
// This harness must touch the real active WhatsAppIntegration document (there
// is only ever one "active" row, and rotation only makes sense against it),
// so it snapshots that document's webhookSecret and active flag up front and
// restores both in a finally block — the operator's real secret is never
// left rotated by a test run, whichever branch runs or fails.
//
// If no WhatsApp integration is connected in this environment, the checks
// that need one are SKIPped with an explanation, mirroring
// verify-webhook-auth.js's convention for gates outside this task's control;
// the not-connected error path is still exercised directly in that case.
//
// Run:  node tools/verify-rotate-secret.js
const express = require("express");
const mongoose = require("mongoose");

const MessageEvent = require("../models/MessageEvent");
const WhatsAppIntegration = require("../models/WhatsAppIntegration");
const whatsappProvider = require("../lib/whatsappProvider");
const watiRouter = require("../routes/wati");
const integrationsRouter = require("../routes/integrations");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";
const PREFIX = "__verify_rotate_secret__";
const PHONE = "919000000902";

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
  app.use("/api", integrationsRouter);
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

function webhookPost(secret, body) {
  const qs = secret ? `?secret=${encodeURIComponent(secret)}` : "";
  return fetch(`${baseUrl}/api/wati/webhook${qs}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rotatePost() {
  return fetch(`${baseUrl}/api/integrations/whatsapp/rotate-secret`, { method: "POST" });
}

const eventBody = (wamid) => ({
  eventType: "templateMessageSent",
  waId: PHONE,
  whatsappMessageId: wamid,
  statusString: "SENT",
  owner: true,
  text: "hi",
});

async function eventExists(wamid) {
  return Boolean(await MessageEvent.findOne({ providerMessageId: wamid }));
}

async function wipeEvents(wamids) {
  await MessageEvent.deleteMany({ providerMessageId: { $in: wamids } });
}

// 24 random bytes hex-encoded == 48 hex characters, same form as connect().
const SECRET_SHAPE = /^[0-9a-f]{48}$/;

(async () => {
  await mongoose.connect(URI);
  await startServer();

  const wamids = {
    oldSecret: `wamid.${PREFIX}.OLD_SECRET`,
    newSecret: `wamid.${PREFIX}.NEW_SECRET`,
  };

  let snapshot = null; // { _id, webhookSecret, active }

  try {
    await wipeEvents(Object.values(wamids));

    const active = await WhatsAppIntegration.findOne({ active: true });

    if (!active) {
      // --- not-connected path, no integration exists at all ---------------
      let threw = null;
      const before = await WhatsAppIntegration.countDocuments({});
      try {
        await whatsappProvider.rotateWebhookSecret();
      } catch (err) {
        threw = err;
      }
      const after = await WhatsAppIntegration.countDocuments({});
      check("rotate with nothing connected -> throws not-connected error", Boolean(threw), threw ? threw.message : "did not throw");
      check(
        "not-connected error names the Integrations tab",
        Boolean(threw && /connect one from the Integrations tab/.test(threw.message)),
        threw ? threw.message : ""
      );
      check("rotate with nothing connected -> creates no document", after === before, `before=${before} after=${after}`);

      skip("rotate produces a new secret of the connect-time shape", "no WhatsApp integration is connected in this environment");
      skip("rotate-secret route returns refreshed status", "no WhatsApp integration is connected in this environment");
      skip("old secret -> 401 after rotation", "no WhatsApp integration is connected in this environment");
      skip("new secret -> 200 after rotation", "no WhatsApp integration is connected in this environment");
    } else {
      snapshot = { _id: active._id, webhookSecret: active.webhookSecret, active: active.active };
      const oldSecret = active.webhookSecret;

      // --- not-connected path, simulated by deactivating the real doc -----
      await WhatsAppIntegration.updateOne({ _id: active._id }, { $set: { active: false } });
      let threw = null;
      try {
        await whatsappProvider.rotateWebhookSecret();
      } catch (err) {
        threw = err;
      }
      check("rotate while disconnected -> throws not-connected error", Boolean(threw), threw ? threw.message : "did not throw");
      check(
        "not-connected error names the Integrations tab",
        Boolean(threw && /connect one from the Integrations tab/.test(threw.message)),
        threw ? threw.message : ""
      );
      const unchanged = await WhatsAppIntegration.findOne({ _id: active._id });
      check("rotate while disconnected -> webhookSecret left untouched", unchanged.webhookSecret === oldSecret);
      await WhatsAppIntegration.updateOne({ _id: active._id }, { $set: { active: true } });

      // --- real rotation via the route -------------------------------------
      const res = await rotatePost();
      const body = await res.json();
      check("rotate-secret route -> 200", res.status === 200, `got ${res.status}`);
      check("rotate-secret route -> returns connected status", body.connected === true, JSON.stringify(body));
      check("rotate-secret route -> returns a webhookSecret of connect-time shape", SECRET_SHAPE.test(body.webhookSecret || ""), body.webhookSecret);
      check("rotate-secret route -> secret actually changed", body.webhookSecret !== oldSecret);

      const newSecret = body.webhookSecret;

      // --- old secret now rejected, new secret accepted --------------------
      const resOld = await webhookPost(oldSecret, eventBody(wamids.oldSecret));
      check("old secret -> 401 after rotation", resOld.status === 401, `got ${resOld.status}`);
      check("old secret -> zero MessageEvent written", !(await eventExists(wamids.oldSecret)));

      const resNew = await webhookPost(newSecret, eventBody(wamids.newSecret));
      check("new secret -> 200 after rotation", resNew.status === 200, `got ${resNew.status}`);
      check("new secret -> event written", await eventExists(wamids.newSecret));
    }
  } finally {
    await wipeEvents(Object.values(wamids));
    if (snapshot) {
      await WhatsAppIntegration.updateOne(
        { _id: snapshot._id },
        { $set: { webhookSecret: snapshot.webhookSecret, active: snapshot.active } }
      );
      const restored = await WhatsAppIntegration.findOne({ _id: snapshot._id });
      const ok = restored && restored.webhookSecret === snapshot.webhookSecret && restored.active === snapshot.active;
      console.log(ok ? "restored real integration's original webhookSecret/active" : "WARNING: failed to restore real integration state");
    }
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
