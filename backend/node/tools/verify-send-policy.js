// Standalone, black-box verification of task 7 (issue #35): the account-level
// send policy — a global frequency cap and quiet-hours window, enforced at
// send time across every campaign, off by default.
//
//   - lib/sendPolicy.js (AppSetting-backed storage, the cross-campaign
//     recentSendCount query)
//   - the message node's new pre-send check in lib/campaignEngine.js, which
//     runs after the target read and before renderParams/ctx.send, and only
//     when the policy is on AND the kill switch is on
//   - lib/campaignEngine.js's exported clampToWindow, reused verbatim rather
//     than reimplemented, for the quiet-hours arithmetic
//
// Same pattern as verify-retry-backoff.js: connect straight to the local dev
// Mongo, seed throwaway __verify_*__ fixtures, drive the real walkEnrollment
// export (never campaignEngine's internals directly), assert one invariant at
// a time with check(), clean up on every path, exit non-zero on failure.
//
// The real lib/sendPolicy.js (getSendPolicy/recentSendCount) is exercised
// end-to-end against the real AppSetting/CampaignEnrollment/DirectMessage
// collections in every scenario except the kill-switch one, where
// recentSendCount is deliberately overridden with a call counter — proving
// the dependency seam works, and proving the walk never even queries send
// counts when the kill switch is off. `send` is always an injected function
// that increments a shared "network" counter only when it actually decides to
// dispatch, exactly mirroring how the real whatsappProvider.sendMessage
// checks the kill switch before ever touching the network — so "zero calls
// reached the injected sender" means zero simulated dispatches, not zero
// invocations of the wrapper.
const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const DirectMessage = require("../models/DirectMessage");
const Lead = require("../models/Lead");
const AppSetting = require("../models/AppSetting");
const { walkEnrollment, clampToWindow } = require("../lib/campaignEngine");
const { getSendPolicy, setSendPolicy, recentSendCount, DEFAULT_POLICY } = require("../lib/sendPolicy");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";
const CAMPAIGN_A_NAME = "__verify_send_policy__a__";
const CAMPAIGN_B_NAME = "__verify_send_policy__b__";
const PHONE_PREFIX = "919000007"; // 919000007XX — an unmistakable, disposable block
const SETTING_KEY = "sendPolicy";

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// A single shared "did this reach the network" counter. Scenarios that expect
// a send assert it went up by exactly one; scenarios that expect a throttle
// or a gate assert it did not move at all.
const network = { dispatches: 0 };

// Mirrors the real chokepoint contract (whatsappProvider.sendMessage checks
// the kill switch, *then* dispatches): the flag is read at call time, so a
// single sender can be reused across a scenario that flips it mid-way.
function makeSender(flags) {
  return async () => {
    if (!flags.sendingEnabled) {
      const err = new Error("Sending is OFF (test mode)");
      err.sendingDisabled = true;
      throw err;
    }
    network.dispatches += 1;
    return { whatsappMessageId: `wamid.TEST.verify_send_policy.${network.dispatches}` };
  };
}

let wipe = async () => {};
let restoreSendPolicySetting = async () => {};

(async () => {
  await mongoose.connect(URI);

  wipe = async () => {
    await CampaignEnrollment.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await Campaign.deleteMany({ name: { $in: [CAMPAIGN_A_NAME, CAMPAIGN_B_NAME] } });
    await Lead.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
    await DirectMessage.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
  };
  await wipe(); // clean slate from any previous crashed run

  // The sendPolicy AppSetting row is a real, shared, singleton key — not a
  // __verify_*__-prefixed fixture — so its original value (or absence) is
  // saved up front and restored in the `finally` below, exactly as
  // verify-retry-backoff.js saves/restores CAMPAIGN_MAX_SEND_ATTEMPTS.
  const originalSetting = await AppSetting.findOne({ key: SETTING_KEY }).lean();
  restoreSendPolicySetting = async () => {
    if (originalSetting) {
      await AppSetting.findOneAndUpdate({ key: SETTING_KEY }, { $set: { value: originalSetting.value } }, { upsert: true });
    } else {
      await AppSetting.deleteOne({ key: SETTING_KEY });
    }
  };

  try {
    // --- seed: two campaigns, same graph shape, reused by every scenario --
    const NODES = [
      { id: "n_src", kind: "source", config: { sourceId: "Lead", filter: {}, map: { phone: "phone" } } },
      { id: "n_msg", kind: "message", config: { templateId: "verify_send_policy_tpl", params: [] } },
      { id: "n_exit", kind: "exit", config: { outcome: "done" } },
    ];
    const EDGES = [
      { id: "e1", from: "n_src", to: "n_msg" },
      { id: "e2", from: "n_msg", to: "n_exit" },
    ];
    async function seedCampaign(name) {
      return Campaign.create({
        name,
        description: "throwaway fixture for tools/verify-send-policy.js",
        channelId: "",
        draft: { nodes: NODES, edges: EDGES },
        versions: [{ version: 1, nodes: NODES, edges: EDGES, publishedAt: new Date() }],
        liveVersion: 1,
        active: true,
      });
    }
    const campaignA = await seedCampaign(CAMPAIGN_A_NAME);
    const campaignB = await seedCampaign(CAMPAIGN_B_NAME);

    let leadCounter = 0;
    async function seedEnrollment(campaign, phone) {
      leadCounter += 1;
      const lead = await Lead.create({
        name: `__verify_send_policy__ ${phone}#${leadCounter}`,
        phone,
        leadMagnet: `__verify_send_policy__lead${leadCounter}__`,
      });
      return CampaignEnrollment.create({
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
    }

    // Never dryRun: applyWalkResult's `.save()` is exactly what several
    // checks below need to prove landed (or, for a throttled tick, did NOT
    // land — no history entry, status untouched).
    const tick = (enrollment, campaign, send, now, deps) =>
      walkEnrollment(enrollment, campaign, { now, send, dryRun: false, deps });

    // === lib/sendPolicy.js in isolation: shape, defaults, no migration ====
    {
      await AppSetting.deleteOne({ key: SETTING_KEY });
      const defaults = await getSendPolicy();
      check(
        "with no AppSetting row at all, getSendPolicy() returns the documented off-by-default shape",
        defaults.enabled === false &&
          defaults.maxPerContact.count === DEFAULT_POLICY.maxPerContact.count &&
          defaults.maxPerContact.windowMinutes === DEFAULT_POLICY.maxPerContact.windowMinutes &&
          defaults.quietHours.window === null &&
          defaults.countManualSends === false,
        JSON.stringify(defaults)
      );

      await setSendPolicy({ enabled: true, maxPerContact: { count: 3 } });
      const afterPatch = await getSendPolicy();
      check(
        "setSendPolicy merges a partial patch — maxPerContact.count changes, windowMinutes keeps its default",
        afterPatch.enabled === true && afterPatch.maxPerContact.count === 3 && afterPatch.maxPerContact.windowMinutes === 60,
        JSON.stringify(afterPatch)
      );

      const row = await AppSetting.findOne({ key: SETTING_KEY }).lean();
      check(
        "the policy is stored as a single AppSetting row under key \"sendPolicy\" — no separate collection, no migration",
        Boolean(row) && row.key === SETTING_KEY && row.value.enabled === true,
        JSON.stringify(row && row.value)
      );

      await setSendPolicy({ enabled: false });
    }

    // === scenario 1: off by default — walk is byte-for-byte unchanged =====
    {
      await AppSetting.deleteOne({ key: SETTING_KEY });
      const phone = `${PHONE_PREFIX}06`;
      const enrollment = await seedEnrollment(campaignA, phone);
      const flags = { sendingEnabled: true };
      const before = network.dispatches;
      const r = await tick(enrollment, campaignA, makeSender(flags), new Date("2026-02-01T00:00:00.000Z"), {
        isSendingEnabled: async () => flags.sendingEnabled,
      });
      check(
        "with the policy off (no AppSetting row), the send goes through exactly as it would have before this feature existed",
        r.stop === "sent" && network.dispatches === before + 1,
        `stop=${r.stop} dispatches=${network.dispatches}`
      );
    }

    // === scenario 2: frequency cap across two campaigns sharing one phone ==
    {
      await setSendPolicy({
        enabled: true,
        maxPerContact: { count: 2, windowMinutes: 60 },
        quietHours: { window: null, tz: "UTC", skipDays: [] },
        countManualSends: false,
      });
      const phone = `${PHONE_PREFIX}01`;
      const flags = { sendingEnabled: true };
      const deps = { isSendingEnabled: async () => flags.sendingEnabled };
      const T0 = new Date("2026-02-01T12:00:00.000Z");
      const T1 = new Date(T0.getTime() + 60 * 1000);
      const T2 = new Date(T0.getTime() + 2 * 60 * 1000);

      const enrollA = await seedEnrollment(campaignA, phone);
      const beforeA = network.dispatches;
      const rA = await tick(enrollA, campaignA, makeSender(flags), T0, deps);
      check(
        "send 1/2 (campaign A) goes through — cap not yet reached",
        rA.stop === "sent" && network.dispatches === beforeA + 1,
        `stop=${rA.stop}`
      );

      const enrollB = await seedEnrollment(campaignB, phone);
      const beforeB = network.dispatches;
      const rB = await tick(enrollB, campaignB, makeSender(flags), T1, deps);
      check(
        "send 2/2 (campaign B, same phone, DIFFERENT campaign) still goes through — the cap counts cross-campaign, not per-campaign",
        rB.stop === "sent" && network.dispatches === beforeB + 1,
        `stop=${rB.stop}`
      );

      const enrollC = await seedEnrollment(campaignA, phone);
      const beforeC = network.dispatches;
      const rC = await tick(enrollC, campaignA, makeSender(flags), T2, deps);
      check(
        "send 3 is throttled: the cap (2 within 60 minutes) was reached by the first two sends across both campaigns",
        rC.stop === "throttled",
        `stop=${rC.stop}`
      );
      check("a throttled tick never reaches the provider", network.dispatches === beforeC, `dispatches=${network.dispatches}`);
      check(
        "a throttled tick leaves status 'active' and writes no history entry",
        enrollC.status === "active" && enrollC.history.length === 0,
        `status=${enrollC.status} history.length=${enrollC.history.length}`
      );
      check(
        "a throttled tick sets currentNodeId back to the message node explicitly",
        enrollC.currentNodeId === "n_msg",
        `currentNodeId=${enrollC.currentNodeId}`
      );
      check(
        "nextSendAt is pushed to exactly when the oldest counted send (T0) ages out of the 60-minute window",
        enrollC.nextSendAt.getTime() === T0.getTime() + 60 * 60 * 1000,
        `nextSendAt=${enrollC.nextSendAt.toISOString()} expected=${new Date(T0.getTime() + 60 * 60 * 1000).toISOString()}`
      );

      // Reload from Mongo — proves applyWalkResult actually persisted (or, on
      // the throttled tick, deliberately did NOT touch) these fields.
      const reloaded = await CampaignEnrollment.findById(enrollC._id).lean();
      check(
        "the throttled enrollment's untouched status and cleared history are actually what's in Mongo, not just the in-memory object",
        reloaded.status === "active" && reloaded.history.length === 0,
        `status=${reloaded.status} history.length=${reloaded.history.length}`
      );
    }

    // === scenario 3: manual one-off sends count only when the toggle is on
    {
      const flags = { sendingEnabled: true };
      const deps = { isSendingEnabled: async () => flags.sendingEnabled };

      // 3a — toggle OFF: a recent manual DirectMessage must not count.
      {
        const phone = `${PHONE_PREFIX}02`;
        const now = new Date("2026-02-02T09:00:00.000Z");
        await DirectMessage.create({
          phone,
          templateId: "verify_send_policy_manual",
          sentAt: new Date(now.getTime() - 60 * 1000),
          status: "sent",
        });
        await setSendPolicy({
          enabled: true,
          maxPerContact: { count: 1, windowMinutes: 60 },
          quietHours: { window: null, tz: "UTC", skipDays: [] },
          countManualSends: false,
        });
        const enrollment = await seedEnrollment(campaignA, phone);
        const before = network.dispatches;
        const r = await tick(enrollment, campaignA, makeSender(flags), now, deps);
        check(
          "countManualSends:false — a manual send one minute ago does not count against the cap, so the campaign send goes through",
          r.stop === "sent" && network.dispatches === before + 1,
          `stop=${r.stop}`
        );
      }

      // 3b — toggle ON: the same shape of manual send now DOES count.
      {
        const phone = `${PHONE_PREFIX}03`;
        const now = new Date("2026-02-02T09:00:00.000Z");
        const manualSentAt = new Date(now.getTime() - 60 * 1000);
        await DirectMessage.create({
          phone,
          templateId: "verify_send_policy_manual",
          sentAt: manualSentAt,
          status: "sent",
        });
        await setSendPolicy({
          enabled: true,
          maxPerContact: { count: 1, windowMinutes: 60 },
          quietHours: { window: null, tz: "UTC", skipDays: [] },
          countManualSends: true,
        });
        const enrollment = await seedEnrollment(campaignA, phone);
        const before = network.dispatches;
        const r = await tick(enrollment, campaignA, makeSender(flags), now, deps);
        check(
          "countManualSends:true — the same manual send now fills the cap of 1, so the campaign send is throttled",
          r.stop === "throttled" && network.dispatches === before,
          `stop=${r.stop} dispatches=${network.dispatches}`
        );
        check(
          "the throttle's nextSendAt is exactly the manual send's timestamp plus the 60-minute window",
          enrollment.nextSendAt.getTime() === manualSentAt.getTime() + 60 * 60 * 1000,
          `nextSendAt=${enrollment.nextSendAt.toISOString()}`
        );
      }
    }

    // === scenario 4: quiet hours defer to exactly what clampToWindow says =
    {
      await setSendPolicy({
        enabled: true,
        maxPerContact: { count: 0, windowMinutes: 60 }, // cap disabled — isolate quiet hours
        quietHours: { window: { from: "10:00", to: "20:00" }, tz: "Asia/Kolkata", skipDays: [] },
        countManualSends: false,
      });
      const phone = `${PHONE_PREFIX}04`;
      const flags = { sendingEnabled: true };
      const deps = { isSendingEnabled: async () => flags.sendingEnabled };
      // 2026-02-06T01:00:00Z is 06:30 IST — before the 10:00 opening, no
      // skipped days involved, so the expected instant is unambiguous.
      const outsideWindow = new Date("2026-02-06T01:00:00.000Z");
      const expected = clampToWindow(outsideWindow, {
        window: { from: "10:00", to: "20:00" },
        tz: "Asia/Kolkata",
        skipDays: [],
      });
      check(
        "sanity: the chosen instant is genuinely outside the configured quiet-hours window",
        expected.getTime() !== outsideWindow.getTime(),
        `expected=${expected.toISOString()} outsideWindow=${outsideWindow.toISOString()}`
      );

      const enrollment = await seedEnrollment(campaignA, phone);
      const before = network.dispatches;
      const r = await tick(enrollment, campaignA, makeSender(flags), outsideWindow, deps);
      check(
        "a send attempted inside the configured quiet hours is throttled",
        r.stop === "throttled" && network.dispatches === before,
        `stop=${r.stop} dispatches=${network.dispatches}`
      );
      check(
        "the deferral lands on EXACTLY the instant lib/campaignEngine.js's own exported clampToWindow returns — no second implementation",
        enrollment.nextSendAt.getTime() === expected.getTime(),
        `nextSendAt=${enrollment.nextSendAt.toISOString()} expected=${expected.toISOString()}`
      );
      check(
        "the deferred enrollment writes no history and leaves status 'active'",
        enrollment.status === "active" && enrollment.history.length === 0,
        `status=${enrollment.status} history.length=${enrollment.history.length}`
      );

      // Ticking again at exactly the deferred instant proves it isn't just a
      // plausible-looking timestamp — sending genuinely resumes there.
      const beforeRetry = network.dispatches;
      const rRetry = await tick(enrollment, campaignA, makeSender(flags), expected, deps);
      check(
        "ticking again at exactly that deferred instant now sends — quiet hours have genuinely opened",
        rRetry.stop === "sent" && network.dispatches === beforeRetry + 1,
        `stop=${rRetry.stop}`
      );
    }

    // === scenario 5: kill switch off — policy check skipped entirely,
    //                 existing gated behaviour unchanged, provider never hit
    {
      await setSendPolicy({
        enabled: true,
        maxPerContact: { count: 1, windowMinutes: 60 },
        quietHours: { window: { from: "10:00", to: "20:00" }, tz: "Asia/Kolkata", skipDays: [] },
        countManualSends: false,
      });
      const phone = `${PHONE_PREFIX}05`;
      const flags = { sendingEnabled: false }; // kill switch off
      let recentSendCountCalls = 0;
      const deps = {
        isSendingEnabled: async () => flags.sendingEnabled,
        // Poisoned with a counter rather than a throw, so a bug that DOES
        // call it surfaces as a failed check rather than an uncaught-looking
        // "graph walk failed" park that could be mistaken for something else.
        recentSendCount: async (...args) => {
          recentSendCountCalls += 1;
          return recentSendCount(...args);
        },
      };
      // Deliberately chosen to be outside the quiet-hours window too, so a
      // bug that skips only the cap (but not quiet hours) would still show up.
      const now = new Date("2026-02-06T01:00:00.000Z");

      const enrollment = await seedEnrollment(campaignA, phone);
      const before = JSON.stringify(enrollment.toObject());
      const beforeDispatches = network.dispatches;
      const r = await tick(enrollment, campaignA, makeSender(flags), now, deps);
      const after = JSON.stringify(enrollment.toObject());

      check(
        "with the kill switch off, the send-count query is never called — the policy check is skipped entirely, not evaluated-then-ignored",
        recentSendCountCalls === 0,
        `recentSendCountCalls=${recentSendCountCalls}`
      );
      check(
        "the tick still ends 'gated', exactly as it would with no send policy at all",
        r.stop === "gated",
        `stop=${r.stop}`
      );
      check(
        "a gated tick writes nothing at all — the enrollment is byte-for-byte unchanged",
        before === after,
        `unchanged=${before === after}`
      );
      check(
        "zero calls reached the injected sender's dispatch path — the provider was never actually hit",
        network.dispatches === beforeDispatches,
        `dispatches=${network.dispatches}`
      );
    }
  } finally {
    await wipe();
    await restoreSendPolicySetting();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await wipe();
    await restoreSendPolicySetting();
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
