// Verifies the shared-secret check that guards POST /api/wati/webhook
// (routes/wati.js, top of the handler) against forged inbound calls.
//
// Same pattern as verify-webhook.js / verify-preset-reuse.js: the real router
// is mounted on a throwaway Express app on an ephemeral port and driven with
// real HTTP requests; nothing here reaches WATI.
//
// The "correct secret" checks use the real active WhatsAppIntegration's
// webhookSecret already sitting in the local dev Mongo (read-only — never
// written to) so the test proves the exact code path production traffic
// takes. If no integration is connected in this environment, those two
// checks are SKIPped with an explanation rather than failed, mirroring
// verify-window-messaging.js's convention for gates outside this task's
// control. The "inactive integration" check inserts and removes its own
// throwaway, always-inactive fixture, which findBySecret's `active: true`
// filter guarantees can never interfere with anything else touching Mongo
// concurrently.
//
// Run:  node tools/verify-webhook-auth.js
const express = require("express");
const mongoose = require("mongoose");

const MessageEvent = require("../models/MessageEvent");
const WhatsAppIntegration = require("../models/WhatsAppIntegration");
const watiRouter = require("../routes/wati");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";
const PREFIX = "__verify_webhook_auth__";

const WRONG_SECRET = `${PREFIX}_wrong_secret_deadbeef`;
const INACTIVE_SECRET = `${PREFIX}_inactive_secret_cafef00d`;
const PHONE = "919000000901";

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

// Captures every console.warn call made during `fn` so the caller can assert
// on what got logged without silencing the harness's own PASS/FAIL output.
async function captureWarnings(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => {
    calls.push(args.map(String).join(" "));
    original.apply(console, args);
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return calls;
}

function post({ query, header }, body) {
  const qs = query ? `?secret=${encodeURIComponent(query)}` : "";
  const headers = { "Content-Type": "application/json" };
  if (header) headers["x-webhook-secret"] = header;
  return fetch(`${baseUrl}/api/wati/webhook${qs}`, { method: "POST", headers, body: JSON.stringify(body) });
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

(async () => {
  await mongoose.connect(URI);
  await startServer();

  const wamids = {
    noSecret: `wamid.${PREFIX}.NO_SECRET`,
    wrongSecret: `wamid.${PREFIX}.WRONG_SECRET`,
    correctQuery: `wamid.${PREFIX}.CORRECT_QUERY`,
    correctHeader: `wamid.${PREFIX}.CORRECT_HEADER`,
    inactiveSecret: `wamid.${PREFIX}.INACTIVE_SECRET`,
  };

  try {
    await wipeEvents(Object.values(wamids));
    await WhatsAppIntegration.deleteMany({ apiEndpoint: PREFIX });

    // --- no secret at all ------------------------------------------------
    {
      const warnings = await captureWarnings(async () => {
        const res = await post({}, eventBody(wamids.noSecret));
        check("no secret -> 401", res.status === 401, `got ${res.status}`);
      });
      check("no secret -> zero MessageEvent written", !(await eventExists(wamids.noSecret)));
      const warned = warnings.some((w) => w.includes("wati/webhook") && w.includes("length=0"));
      check("no secret -> console.warn identifies endpoint and length=0", warned, warnings.join(" | "));
    }

    // --- wrong secret, as query param -------------------------------------
    {
      const warnings = await captureWarnings(async () => {
        const res = await post({ query: WRONG_SECRET }, eventBody(wamids.wrongSecret));
        check("wrong secret (query) -> 401", res.status === 401, `got ${res.status}`);
      });
      check("wrong secret -> zero MessageEvent written", !(await eventExists(wamids.wrongSecret)));
      const warned = warnings.some((w) => w.includes("wati/webhook") && w.includes(`length=${WRONG_SECRET.length}`));
      check("wrong secret -> console.warn identifies endpoint and correct length", warned, warnings.join(" | "));
      const leaked = warnings.some((w) => w.includes(WRONG_SECRET));
      check("wrong secret -> console.warn never contains the supplied value", !leaked, warnings.join(" | "));
    }

    // --- secret belonging to an inactive integration ----------------------
    {
      await WhatsAppIntegration.collection.insertOne({
        type: "wati",
        apiEndpoint: PREFIX,
        apiTokenEncrypted: "not-a-real-token",
        channels: [],
        active: false,
        webhookSecret: INACTIVE_SECRET,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const res = await post({ query: INACTIVE_SECRET }, eventBody(wamids.inactiveSecret));
      check("secret of an inactive integration -> 401", res.status === 401, `got ${res.status}`);
      check("inactive-integration secret -> zero MessageEvent written", !(await eventExists(wamids.inactiveSecret)));
    }

    // --- correct secret, real connected integration (read-only) -----------
    const active = await WhatsAppIntegration.findOne({ active: true });
    if (!active) {
      skip("correct secret (query) -> 200 and event written", "no WhatsApp integration is connected in this environment");
      skip("correct secret (header) -> 200 and event written", "no WhatsApp integration is connected in this environment");
    } else {
      const correctSecret = active.webhookSecret;

      const resQuery = await post({ query: correctSecret }, eventBody(wamids.correctQuery));
      check("correct secret (query) -> 200", resQuery.status === 200, `got ${resQuery.status}`);
      check("correct secret (query) -> event written", await eventExists(wamids.correctQuery));

      const resHeader = await post({ header: correctSecret }, eventBody(wamids.correctHeader));
      check("correct secret (header) -> 200", resHeader.status === 200, `got ${resHeader.status}`);
      check("correct secret (header) -> event written", await eventExists(wamids.correctHeader));
    }
  } finally {
    await wipeEvents(Object.values(wamids));
    await WhatsAppIntegration.deleteMany({ apiEndpoint: PREFIX });
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
