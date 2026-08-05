// Verifies the GET/POST /api/settings/send-policy routes (routes/settings.js)
// and the validatePolicyPatch() helper they delegate to (lib/sendPolicy.js)
// — added for GitHub issue #39 (task 11: send-policy admin UI).
//
// Same pattern as verify-rotate-secret.js: the real settings router is
// mounted on a throwaway Express app on an ephemeral port and driven with
// real HTTP requests, plus a few direct calls into lib/sendPolicy.js to
// confirm the route and the module agree.
//
// This harness touches the real "sendPolicy" AppSetting row (there is only
// ever one), so it snapshots that row up front — including "no row exists
// yet" as a snapshot state — and restores it in a finally block. Every
// invalid-input check additionally asserts the stored row was left
// untouched, which is the whole point of rejecting instead of silently
// normalizing at the route boundary.
//
// Run:  node tools/verify-send-policy-routes.js
const express = require("express");
const mongoose = require("mongoose");

const AppSetting = require("../models/AppSetting");
const settingsRouter = require("../routes/settings");
const { getSendPolicy, validatePolicyPatch, DEFAULT_POLICY } = require("../lib/sendPolicy");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";
const KEY = "sendPolicy";

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

let server = null;
let baseUrl = "";

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api", settingsRouter);
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

function getPolicy() {
  return fetch(`${baseUrl}/api/settings/send-policy`).then(async (res) => ({ status: res.status, body: await res.json() }));
}

function postPolicy(patch) {
  return fetch(`${baseUrl}/api/settings/send-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

async function rawRow() {
  return AppSetting.findOne({ key: KEY }).lean();
}

(async () => {
  await mongoose.connect(URI);
  await startServer();

  let snapshot; // { existed: bool, value }

  try {
    const before = await rawRow();
    snapshot = { existed: Boolean(before), value: before ? before.value : null };

    // ------------------------------------------------------------------
    // Pure validatePolicyPatch() checks — no I/O, exercised directly.
    // ------------------------------------------------------------------
    check("validatePolicyPatch({}) -> no errors", validatePolicyPatch({}).length === 0);
    check(
      "validatePolicyPatch(non-object) -> no errors (treated as empty patch)",
      validatePolicyPatch(null).length === 0 && validatePolicyPatch(undefined).length === 0
    );
    check(
      "validatePolicyPatch({ enabled: true }) -> no errors",
      validatePolicyPatch({ enabled: true }).length === 0
    );
    check(
      "validatePolicyPatch({ enabled: 'yes' }) -> rejected",
      validatePolicyPatch({ enabled: "yes" }).some((m) => /enabled/.test(m))
    );
    check(
      "validatePolicyPatch({ countManualSends: 1 }) -> rejected",
      validatePolicyPatch({ countManualSends: 1 }).some((m) => /countManualSends/.test(m))
    );
    check(
      "validatePolicyPatch cap count 0 -> rejected as non-positive",
      validatePolicyPatch({ maxPerContact: { count: 0 } }).some((m) => /positive/.test(m))
    );
    check(
      "validatePolicyPatch cap count -5 -> rejected as non-positive",
      validatePolicyPatch({ maxPerContact: { count: -5 } }).some((m) => /positive/.test(m))
    );
    check(
      "validatePolicyPatch cap windowMinutes 0 -> rejected",
      validatePolicyPatch({ maxPerContact: { windowMinutes: 0 } }).some((m) => /window/.test(m))
    );
    check(
      "validatePolicyPatch valid cap {count:3, windowMinutes:30} -> no errors",
      validatePolicyPatch({ maxPerContact: { count: 3, windowMinutes: 30 } }).length === 0
    );
    check(
      "validatePolicyPatch inverted quiet-hours window (22:00 -> 06:00) -> rejected",
      validatePolicyPatch({ quietHours: { window: { from: "22:00", to: "06:00" } } }).some((m) => /after/.test(m))
    );
    check(
      "validatePolicyPatch zero-length quiet-hours window (10:00 -> 10:00) -> rejected",
      validatePolicyPatch({ quietHours: { window: { from: "10:00", to: "10:00" } } }).some((m) => /after/.test(m))
    );
    check(
      "validatePolicyPatch malformed time-of-day -> rejected",
      validatePolicyPatch({ quietHours: { window: { from: "not-a-time", to: "10:00" } } }).some((m) => /HH:MM/.test(m))
    );
    check(
      "validatePolicyPatch valid quiet-hours window (09:00 -> 18:00) -> no errors",
      validatePolicyPatch({ quietHours: { window: { from: "09:00", to: "18:00" } } }).length === 0
    );
    check(
      "validatePolicyPatch quietHours.window: null -> no errors (clears the window)",
      validatePolicyPatch({ quietHours: { window: null } }).length === 0
    );
    check(
      "validatePolicyPatch unknown timezone -> rejected and names the timezone",
      validatePolicyPatch({ quietHours: { tz: "Mars/OlympusMons" } }).some((m) => /Mars\/OlympusMons/.test(m) && /timezone/.test(m))
    );
    check(
      "validatePolicyPatch known timezone (Asia/Kolkata) -> no errors",
      validatePolicyPatch({ quietHours: { tz: "Asia/Kolkata" } }).length === 0
    );

    // ------------------------------------------------------------------
    // Route behavior against a clean slate.
    // ------------------------------------------------------------------
    await AppSetting.deleteOne({ key: KEY });

    const fresh = await getPolicy();
    check("GET with no row -> 200", fresh.status === 200, `got ${fresh.status}`);
    check(
      "GET with no row -> returns the normalized default policy",
      JSON.stringify(fresh.body) === JSON.stringify(DEFAULT_POLICY),
      JSON.stringify(fresh.body)
    );

    // --- invalid patches: rejected, and never persisted -------------------
    const invalidCases = [
      { patch: { enabled: "on" }, msgTest: /enabled/, label: "enabled not boolean" },
      { patch: { maxPerContact: { count: 0 } }, msgTest: /positive/, label: "cap count zero" },
      { patch: { maxPerContact: { count: -1 } }, msgTest: /positive/, label: "cap count negative" },
      { patch: { maxPerContact: { windowMinutes: -30 } }, msgTest: /window/, label: "cap window negative" },
      {
        patch: { quietHours: { window: { from: "22:00", to: "06:00" } } },
        msgTest: /after/,
        label: "inverted quiet-hours window",
      },
      {
        patch: { quietHours: { window: { from: "bad", to: "10:00" } } },
        msgTest: /HH:MM/,
        label: "malformed quiet-hours time",
      },
      { patch: { quietHours: { tz: "Not/AZone" } }, msgTest: /timezone/, label: "unknown timezone" },
    ];

    for (const { patch, msgTest, label } of invalidCases) {
      const beforeRow = await rawRow();
      const res = await postPolicy(patch);
      check(`POST rejects ${label} -> 400`, res.status === 400, `got ${res.status} body=${JSON.stringify(res.body)}`);
      check(`POST rejects ${label} -> message is specific`, msgTest.test(res.body.error || ""), res.body.error);
      const afterRow = await rawRow();
      check(
        `POST rejects ${label} -> row left untouched`,
        JSON.stringify(beforeRow) === JSON.stringify(afterRow)
      );
    }

    // --- a valid patch: accepted, persisted, and read back on "reload" ----
    const validPatch = {
      enabled: true,
      maxPerContact: { count: 3, windowMinutes: 45 },
      quietHours: { window: { from: "09:00", to: "18:00" }, tz: "Asia/Kolkata", skipDays: [0, 6] },
      countManualSends: true,
    };
    const saveRes = await postPolicy(validPatch);
    check("POST valid patch -> 200", saveRes.status === 200, `got ${saveRes.status} body=${JSON.stringify(saveRes.body)}`);
    check("POST valid patch -> response echoes the saved policy", JSON.stringify(saveRes.body) === JSON.stringify(validPatch));

    const reloaded = await getPolicy();
    check(
      "GET after save (simulated reload) -> same values come back",
      JSON.stringify(reloaded.body) === JSON.stringify(validPatch)
    );

    // The engine reads via lib/sendPolicy.getSendPolicy() directly, on every
    // tick, with no cache in front of it — this call is the same one the
    // walker makes, so seeing the just-saved values here (no server restart
    // in between) is exactly "picked up without a restart".
    const viaModule = await getSendPolicy();
    check(
      "lib/sendPolicy.getSendPolicy() sees the same value the route just saved, with no restart",
      JSON.stringify(viaModule) === JSON.stringify(validPatch)
    );

    // --- a partial patch merges rather than clobbers -----------------------
    const partial = await postPolicy({ enabled: false });
    check("POST partial patch (just enabled:false) -> 200", partial.status === 200);
    check("POST partial patch -> enabled flips", partial.body.enabled === false);
    check(
      "POST partial patch -> untouched fields (cap, quiet hours) survive",
      JSON.stringify(partial.body.maxPerContact) === JSON.stringify(validPatch.maxPerContact) &&
        JSON.stringify(partial.body.quietHours) === JSON.stringify(validPatch.quietHours)
    );

    // Turning the switch off is itself a no-behavior-change operation at the
    // storage layer: nothing here mutates CampaignEnrollment/DirectMessage,
    // and the enforcement decision (task 7, merged) is entirely keyed off
    // this same `enabled` flag on every tick.
    check(
      "policy off leaves the rest of the stored config intact for whenever it's switched back on",
      partial.body.maxPerContact.count === 3 && partial.body.quietHours.tz === "Asia/Kolkata"
    );
  } finally {
    if (snapshot) {
      if (snapshot.existed) {
        await AppSetting.updateOne({ key: KEY }, { $set: { value: snapshot.value } });
      } else {
        await AppSetting.deleteOne({ key: KEY });
      }
      const restored = await rawRow();
      const ok = snapshot.existed
        ? Boolean(restored) && JSON.stringify(restored.value) === JSON.stringify(snapshot.value)
        : !restored;
      console.log(ok ? "restored real sendPolicy AppSetting to its original state" : "WARNING: failed to restore original sendPolicy state");
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
