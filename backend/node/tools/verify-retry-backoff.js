// Standalone, black-box verification of task 2's error classification and
// bounded retry with backoff:
//
//   - lib/errorClassification.js (pure, no I/O)
//   - the structured httpStatus/providerErrorCode/providerResponse fields
//     lib/watiClient.js now attaches at its throw sites
//   - the two new CampaignEnrollment fields, sendAttempts and lastAttemptClass
//   - the message node's catch block in lib/campaignEngine.js that ties all
//     three together, plus applyWalkResult's two new conditional writes
//
// Same pattern as verify-graph-walk.js: connect straight to the local dev
// Mongo, seed throwaway __verify_*__ fixtures, drive the real walkEnrollment
// export (never campaignEngine's internals directly), assert one invariant
// at a time with check(), clean up on every path, exit non-zero on failure.
//
// Every send in this file is an INJECTED function crafted to throw an error
// carrying the exact httpStatus/providerErrorCode combination each scenario
// needs — never a real network call and never lib/watiClient.js itself. That
// keeps this a test of the classify-and-retry contract in campaignEngine.js,
// not of what WATI itself happens to return on any given day.
const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const Lead = require("../models/Lead");
const OptOut = require("../models/OptOut");
const { walkEnrollment } = require("../lib/campaignEngine");
const { BACKOFF_SCHEDULE_MS } = require("../lib/errorClassification");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";
const CAMPAIGN_NAME = "__verify_retry_backoff__";
const PHONE_PREFIX = "919000009"; // 919000009XX — an unmistakable, disposable block

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// A frozen instant, advanced by hand between ticks rather than by real
// wall-clock time — walkEnrollment's `now` option freezes the whole tick at
// whatever instant it is given, so a scenario can assert nextSendAt against
// an exact expected value instead of a fuzzy "sometime later", and without
// this script actually waiting out a 4-hour backoff to prove it landed.
const BASE_NOW = new Date("2026-01-01T00:00:00.000Z");

// A provider error shaped exactly like lib/watiClient.js's sendError()
// attaches at its throw sites: httpStatus/providerErrorCode/providerResponse
// on the Error object, nothing left in the message string for a classifier
// to (and it must not) regex out.
function providerError(message, { httpStatus, providerErrorCode } = {}) {
  const err = new Error(message);
  if (httpStatus !== undefined) err.httpStatus = httpStatus;
  if (providerErrorCode !== undefined) err.providerErrorCode = providerErrorCode;
  err.providerResponse = { info: message };
  return err;
}

// A genuine network failure shape: fetch() itself threw before any response
// ever existed, so there is no httpStatus at all — not zero, not null,
// simply absent, exactly as a DNS failure/timeout/connection-refused would
// leave it.
function networkError(message) {
  return new Error(message);
}

// One entry per call into the injected sender: an Error to throw, or a falsy
// entry to succeed.
function scriptedSender(script) {
  let i = 0;
  return async () => {
    const step = script[i];
    i += 1;
    if (step) throw step;
    return { whatsappMessageId: `wamid.TEST.verify_retry.${i}` };
  };
}

let wipe = async () => {};

(async () => {
  await mongoose.connect(URI);

  wipe = async () => {
    await CampaignEnrollment.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await Campaign.deleteMany({ name: CAMPAIGN_NAME });
    await Lead.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await OptOut.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
  };
  await wipe(); // clean slate from any previous crashed run

  try {
    // --- seed: one campaign, one message node, reused by every scenario --
    const NODES = [
      { id: "n_src", kind: "source", config: { sourceId: "Lead", filter: {}, map: { phone: "phone" } } },
      { id: "n_msg", kind: "message", config: { templateId: "verify_retry_tpl", params: [] } },
      { id: "n_exit", kind: "exit", config: { outcome: "done" } },
    ];
    const EDGES = [
      { id: "e1", from: "n_src", to: "n_msg" },
      { id: "e2", from: "n_msg", to: "n_exit" },
    ];

    const campaign = await Campaign.create({
      name: CAMPAIGN_NAME,
      description: "throwaway fixture for tools/verify-retry-backoff.js",
      channelId: "",
      draft: { nodes: NODES, edges: EDGES },
      versions: [{ version: 1, nodes: NODES, edges: EDGES, publishedAt: new Date() }],
      liveVersion: 1,
      active: true,
    });

    // One Lead + one enrollment per scenario, sitting directly on the
    // message node, so a failed assertion in one scenario can never leak
    // sendAttempts into another's.
    let phoneCounter = 0;
    async function seedEnrollment() {
      phoneCounter += 1;
      const phone = `${PHONE_PREFIX}${String(phoneCounter).padStart(2, "0")}`;
      const lead = await Lead.create({ name: `__verify_retry_backoff__ ${phone}`, phone, leadMagnet: CAMPAIGN_NAME });
      const enrollment = await CampaignEnrollment.create({
        campaign: campaign._id,
        targetModel: "Lead",
        targetId: lead._id,
        phone,
        status: "active",
        graphVersion: 1,
        currentNodeId: "n_msg",
        nextSendAt: new Date(),
        history: [],
      });
      return { phone, lead, enrollment };
    }

    // Never dryRun — this drives the real persistence path (applyWalkResult's
    // `.save()`), because "does this actually land in Mongo" is exactly what
    // several checks below need to prove, not just "is the in-memory object
    // right".
    const tick = (enrollment, send, now) => walkEnrollment(enrollment, campaign, { now, send, dryRun: false });

    // === scenario 1: 503 -> 429 -> success, across three ticks ===========
    {
      const { enrollment } = await seedEnrollment();
      const send = scriptedSender([
        providerError("WATI send failed (503): upstream unavailable", { httpStatus: 503 }),
        providerError("WATI send failed (429): rate limited", { httpStatus: 429 }),
        null, // succeeds
      ]);

      const r1 = await tick(enrollment, send, BASE_NOW);
      check(
        "503 on attempt 1/5 leaves status 'active' and stops the tick as 'retrying'",
        r1.stop === "retrying" && enrollment.status === "active",
        `stop=${r1.stop} status=${enrollment.status}`
      );
      check(
        "503 restores currentNodeId to the message node explicitly",
        enrollment.currentNodeId === "n_msg",
        `currentNodeId=${enrollment.currentNodeId}`
      );
      check(
        "503 sets nextSendAt to exactly BASE_NOW + the schedule's 1st step (1 minute)",
        enrollment.nextSendAt.getTime() === BASE_NOW.getTime() + BACKOFF_SCHEDULE_MS[0],
        `nextSendAt=${enrollment.nextSendAt.toISOString()} expected=${new Date(BASE_NOW.getTime() + BACKOFF_SCHEDULE_MS[0]).toISOString()}`
      );
      check(
        "503 records sendAttempts=1 and lastAttemptClass='retryable'",
        enrollment.sendAttempts === 1 && enrollment.lastAttemptClass === "retryable",
        `sendAttempts=${enrollment.sendAttempts} lastAttemptClass=${enrollment.lastAttemptClass}`
      );
      check(
        "503 appends a history entry naming attempt 1/5",
        /attempt 1\/5/.test(enrollment.history[enrollment.history.length - 1]?.detail || ""),
        `detail=${enrollment.history[enrollment.history.length - 1]?.detail}`
      );

      const NOW_2 = new Date(BASE_NOW.getTime() + BACKOFF_SCHEDULE_MS[0]);
      const r2 = await tick(enrollment, send, NOW_2);
      check(
        "429 on attempt 2/5 also retries and leaves status 'active'",
        r2.stop === "retrying" && enrollment.status === "active",
        `stop=${r2.stop} status=${enrollment.status}`
      );
      check(
        "429 sets nextSendAt to exactly NOW_2 + the schedule's 2nd step (5 minutes)",
        enrollment.nextSendAt.getTime() === NOW_2.getTime() + BACKOFF_SCHEDULE_MS[1],
        `nextSendAt=${enrollment.nextSendAt.toISOString()}`
      );
      check(
        "429 increments sendAttempts to 2, still classified retryable",
        enrollment.sendAttempts === 2 && enrollment.lastAttemptClass === "retryable",
        `sendAttempts=${enrollment.sendAttempts}`
      );

      const NOW_3 = new Date(NOW_2.getTime() + BACKOFF_SCHEDULE_MS[1]);
      const r3 = await tick(enrollment, send, NOW_3);
      check(
        "the third attempt succeeds, stops as 'sent', and advances past the message node",
        r3.stop === "sent" && enrollment.currentNodeId === "n_exit",
        `stop=${r3.stop} currentNodeId=${enrollment.currentNodeId}`
      );
      check("a successful send resets sendAttempts to 0", enrollment.sendAttempts === 0, `sendAttempts=${enrollment.sendAttempts}`);

      // Reload from Mongo — proves applyWalkResult actually persisted the
      // counters via .save(), not just mutated the in-memory object this
      // script happens to be holding a reference to.
      const reloaded = await CampaignEnrollment.findById(enrollment._id).lean();
      check(
        "sendAttempts=0 and status='active' at the end of a fully-recovered streak are actually persisted to Mongo",
        reloaded.sendAttempts === 0 && reloaded.status === "active",
        `sendAttempts=${reloaded.sendAttempts} status=${reloaded.status}`
      );
    }

    // === scenario 2: a network failure (no httpStatus at all) ============
    {
      const { enrollment } = await seedEnrollment();
      const send = scriptedSender([networkError("fetch failed: ECONNREFUSED")]);
      const r = await tick(enrollment, send, BASE_NOW);
      check(
        "a network failure with no httpStatus classifies as retryable and retries rather than parking",
        r.stop === "retrying" && enrollment.lastAttemptClass === "retryable" && enrollment.status === "active",
        `stop=${r.stop} lastAttemptClass=${enrollment.lastAttemptClass} status=${enrollment.status}`
      );
    }

    // === scenario 3: a terminal failure parks immediately =================
    {
      const { enrollment } = await seedEnrollment();
      const send = scriptedSender([providerError("WATI send failed (400): invalid template", { httpStatus: 400 })]);
      const r = await tick(enrollment, send, BASE_NOW);
      check(
        "a terminal failure (400, no undeliverable code) parks as 'failed' on the very first attempt, budget untouched",
        r.stop === "failed" && enrollment.status === "failed",
        `stop=${r.stop} status=${enrollment.status}`
      );
      check(
        "the failed reason names both the attempt count and the classification",
        /1 attempt/.test(enrollment.statusReason || "") && /terminal/.test(enrollment.statusReason || ""),
        `statusReason=${enrollment.statusReason}`
      );
    }

    // === scenario 4: undeliverable parks, but never opts the phone out ===
    {
      const { enrollment, phone } = await seedEnrollment();
      const send = scriptedSender([
        providerError("WATI send failed (400): number not on WhatsApp", {
          httpStatus: 400,
          providerErrorCode: "number_not_on_whatsapp",
        }),
      ]);
      const r = await tick(enrollment, send, BASE_NOW);
      check(
        "an undeliverable provider error code parks as 'failed' immediately with a distinct reason",
        r.stop === "failed" && enrollment.status === "failed" && /undeliverable/.test(enrollment.statusReason || ""),
        `stop=${r.stop} status=${enrollment.status} statusReason=${enrollment.statusReason}`
      );
      const optOutCount = await OptOut.countDocuments({ phone });
      check("an undeliverable classification does not create an OptOut row", optOutCount === 0, `optOutCount=${optOutCount}`);
      const stillOtherEnrollments = await CampaignEnrollment.countDocuments({ phone, status: "cancelled" });
      check("an undeliverable classification does not cancel any enrollment", stillOtherEnrollments === 0, `cancelled=${stillOtherEnrollments}`);
    }

    // === scenario 5: exhausting the attempt budget parks as failed =======
    {
      const previousBudget = process.env.CAMPAIGN_MAX_SEND_ATTEMPTS;
      process.env.CAMPAIGN_MAX_SEND_ATTEMPTS = "2";
      try {
        const { enrollment } = await seedEnrollment();
        const send = scriptedSender([
          providerError("WATI send failed (503): upstream unavailable", { httpStatus: 503 }),
          providerError("WATI send failed (503): upstream unavailable", { httpStatus: 503 }),
        ]);

        const r1 = await tick(enrollment, send, BASE_NOW);
        check(
          "with CAMPAIGN_MAX_SEND_ATTEMPTS=2, attempt 1 still retries",
          r1.stop === "retrying" && enrollment.sendAttempts === 1,
          `stop=${r1.stop} sendAttempts=${enrollment.sendAttempts}`
        );

        const NOW_2 = new Date(BASE_NOW.getTime() + BACKOFF_SCHEDULE_MS[0]);
        const r2 = await tick(enrollment, send, NOW_2);
        check(
          "attempt 2 exhausts a budget of 2 and parks as 'failed' instead of retrying a 6th time",
          r2.stop === "failed" && enrollment.status === "failed",
          `stop=${r2.stop} status=${enrollment.status}`
        );
        check(
          "the exhausted-budget reason names the attempt count (2) and the classification (retryable)",
          /2 attempt/.test(enrollment.statusReason || "") && /retryable/.test(enrollment.statusReason || ""),
          `statusReason=${enrollment.statusReason}`
        );
      } finally {
        if (previousBudget === undefined) delete process.env.CAMPAIGN_MAX_SEND_ATTEMPTS;
        else process.env.CAMPAIGN_MAX_SEND_ATTEMPTS = previousBudget;
      }
    }

    // === scenario 6: the gated path still writes nothing at all ==========
    {
      const { enrollment } = await seedEnrollment();
      const gateErr = new Error("Sending is OFF (test mode)");
      gateErr.sendingDisabled = true;
      const send = scriptedSender([gateErr]);
      const before = JSON.stringify(enrollment.toObject());
      const r = await tick(enrollment, send, BASE_NOW);
      const after = JSON.stringify(enrollment.toObject());
      check(
        "a gated send (kill switch / allowlist) still writes nothing at all — byte-for-byte unchanged enrollment",
        r.stop === "gated" && before === after,
        `stop=${r.stop} unchanged=${before === after}`
      );
    }

    // === scenario 7: walkEnrollment never throws, whatever the error =====
    {
      const { enrollment } = await seedEnrollment();
      const weird = new Error("something bizarre");
      weird.httpStatus = "not-a-number"; // deliberately malformed, not undefined/null and not numeric
      const send = scriptedSender([weird]);
      let threw = null;
      let r = null;
      try {
        r = await tick(enrollment, send, BASE_NOW);
      } catch (err) {
        threw = err;
      }
      check("walkEnrollment never throws, even given a malformed error shape", threw === null, threw && threw.message);
      check("a malformed error still resolves to a definite outcome instead of hanging the walk", Boolean(r && r.stop), `stop=${r && r.stop}`);
    }
  } finally {
    await wipe();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await wipe();
  } catch (cleanupErr) {
    console.error("cleanup also failed:", cleanupErr);
  }
  try {
    await mongoose.disconnect();
  } catch {
    /* already disconnected or never connected */
  }
  process.exit(1);
});
