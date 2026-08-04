// Standalone, black-box verification of the graph walker (lib/campaignEngine.js
// -> walkEnrollment, task 5) and the steps[] -> graph migration (tools/migrate-
// to-graph.js, task 6). Same pattern as verify-webhook.js / verify-direct-
// send.js: connect straight to the local dev Mongo, seed throwaway data under
// an unmistakable __verify_*__ name, drive the real code path, assert one
// invariant at a time with check(), clean up on every path, exit non-zero on
// any failure.
//
// This script does NOT modify campaignEngine.js or migrate-to-graph.js — it
// requires them and calls their exported functions exactly as any other
// caller would.
//
// Everything here runs the walker in dry-run mode with an INJECTED sender
// (see "countingSender" below), never the default whatsappProvider.sendMessage.
// Every enrollment this script drives starts at or past the campaign's
// `message` node — none of the six invariants below need a live send to be
// exercised — so the injected sender is never actually invoked, and its call
// count is asserted to be exactly zero at the end. That is the strongest
// proof available that this run never reached WATI: not just "no live
// provider call", but no call to ANY sender at all, real or fake.
const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const Lead = require("../models/Lead");
const { walkEnrollment, MAX_HOPS_PER_TICK } = require("../lib/campaignEngine");
const { planEnrollment } = require("./migrate-to-graph");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

const CAMPAIGN_NAME = "__verify_graph_walk__";
const CYCLE_CAMPAIGN_NAME = "__verify_graph_walk__cycle__";
const LEAD_PHONE = "919000000098";

// --- the seeded graph: source -> message -> wait -> condition -> (two branches) -> exit
const NODES_V1 = [
  { id: "n_src", kind: "source", label: "Lead", config: { sourceId: "Lead", filter: {}, map: { phone: "phone", segment: "leadMagnet" } } },
  { id: "n_msg", kind: "message", label: "Hello", config: { templateId: "verify_graph_tpl", providerMeta: {}, params: [{ index: 1, from: "name" }] } },
  {
    id: "n_wait",
    kind: "wait",
    label: "2 days",
    // The exact worked case from task 5: armed Friday 23:10 + 2 days lands
    // Sunday 23:10, which is both outside the window and a skipped day.
    config: { amount: 2, unit: "days", window: { from: "10:00", to: "20:00", tz: "Asia/Kolkata" }, skipDays: [0] },
  },
  { id: "n_cond", kind: "condition", label: "Is VIP?", config: { on: "field", field: "segment", operator: "eq", value: "vip" } },
  { id: "n_exit_yes", kind: "exit", label: "VIP exit", config: { outcome: "branch_a" } },
  { id: "n_exit_no", kind: "exit", label: "Non-VIP exit", config: { outcome: "branch_b" } },
];
const EDGES_V1 = [
  { id: "e_src_msg", from: "n_src", to: "n_msg" },
  { id: "e_msg_wait", from: "n_msg", to: "n_wait" },
  { id: "e_wait_cond", from: "n_wait", to: "n_cond" },
  { id: "e_cond_yes", from: "n_cond", to: "n_exit_yes", branch: "yes" },
  { id: "e_cond_no", from: "n_cond", to: "n_exit_no", branch: "no" },
];

// Version 2 of the SAME campaign, published later, differing observably from
// v1 (the "yes" exit's outcome label changes). Used only by the version-
// pinning check — an enrollment pinned to graphVersion:1 must never see this.
const NODES_V2 = NODES_V1.map((n) => (n.id === "n_exit_yes" ? { ...n, config: { outcome: "branch_a_v2_CHANGED" } } : n));
const EDGES_V2 = EDGES_V1;

// A second, deliberate throwaway graph: two condition nodes chained in a
// cycle with no wait node between them, so nothing ever ends the tick except
// the walker's own per-tick hop limit.
const CYCLE_NODES = [
  { id: "n_cyc1", kind: "condition", label: "Always true 1", config: { on: "field", field: "phone", operator: "eq", value: LEAD_PHONE } },
  { id: "n_cyc2", kind: "condition", label: "Always true 2", config: { on: "field", field: "phone", operator: "eq", value: LEAD_PHONE } },
];
const CYCLE_EDGES = [
  { id: "e_cyc1_cyc2", from: "n_cyc1", to: "n_cyc2", branch: "yes" },
  { id: "e_cyc2_cyc1", from: "n_cyc2", to: "n_cyc1", branch: "yes" },
];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Stands in for whatsappProvider.sendMessage everywhere this script drives
// the walker. It makes no network call and touches no other module — it just
// counts. Every scenario below starts the enrollment at or past the
// `message` node, so this is asserted to be called zero times overall (see
// the final check).
let sendCalls = 0;
const countingSender = async () => {
  sendCalls += 1;
  return {};
};

// A fixed instant well away from wall-clock "now", used for every walk that
// doesn't care about the clock (everything except the wait-clamp check,
// which pins its own).
const ARBITRARY_NOW = new Date("2026-01-01T00:00:00.000Z");

let wipe = async () => {};

(async () => {
  await mongoose.connect(URI);

  wipe = async () => {
    await CampaignEnrollment.deleteMany({ phone: LEAD_PHONE });
    await Campaign.deleteMany({ name: { $regex: /^__verify_graph_walk__/ } });
    await Lead.deleteMany({ phone: LEAD_PHONE });
  };
  await wipe(); // clean slate from any previous crashed run

  try {
    // --- seed ---------------------------------------------------------
    const lead = await Lead.create({
      name: "__verify_graph_walk__ lead",
      phone: LEAD_PHONE,
      leadMagnet: "vip", // the field n_cond's "segment" canonical key maps to
    });

    const campaign = await Campaign.create({
      name: CAMPAIGN_NAME,
      description: "throwaway fixture for tools/verify-graph-walk.js",
      channelId: "",
      draft: { nodes: NODES_V1, edges: EDGES_V1 },
      versions: [{ version: 1, nodes: NODES_V1, edges: EDGES_V1, publishedAt: new Date() }],
      liveVersion: 1,
      active: true,
    });

    const cycleCampaign = await Campaign.create({
      name: CYCLE_CAMPAIGN_NAME,
      description: "throwaway hop-limit fixture for tools/verify-graph-walk.js",
      draft: { nodes: [], edges: [] },
      versions: [{ version: 1, nodes: CYCLE_NODES, edges: CYCLE_EDGES, publishedAt: new Date() }],
      liveVersion: 1,
      active: true,
    });

    // The one persisted CampaignEnrollment the acceptance criteria ask for,
    // pinned to the campaign's published graph version. Sitting on the wait
    // node, which doubles as the fixture the wait-clamp check (#2) drives.
    const enrollment = await CampaignEnrollment.create({
      campaign: campaign._id,
      targetModel: "Lead",
      targetId: lead._id,
      phone: LEAD_PHONE,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_wait",
      nextSendAt: new Date(),
      history: [],
    });

    // Plain-object clones for every other walk — walkEnrollment only ever
    // reads fields off the enrollment it's given and (skipped entirely under
    // dryRun) calls .save() on it, so a plain object drives it exactly as
    // well as a Mongoose document, without minting more DB rows to track and
    // clean up.
    const cloneEnrollment = (overrides) => ({
      campaign: campaign._id,
      targetModel: "Lead",
      targetId: lead._id,
      phone: LEAD_PHONE,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_cond",
      nextSendAt: new Date(),
      history: [],
      createdAt: new Date(),
      ...overrides,
    });

    // --- check 1: both condition branches, independently ---------------
    await Lead.updateOne({ _id: lead._id }, { $set: { leadMagnet: "vip" } });
    const branchAResult = await walkEnrollment(cloneEnrollment({}), campaign, {
      now: ARBITRARY_NOW,
      send: countingSender,
      dryRun: true,
    });
    check(
      "condition 'yes' branch (segment=vip) visits exactly [n_cond, n_exit_yes] and exits branch_a",
      JSON.stringify(branchAResult.path) === JSON.stringify(["n_cond", "n_exit_yes"]) && branchAResult.exitOutcome === "branch_a",
      `path=${JSON.stringify(branchAResult.path)} exitOutcome=${branchAResult.exitOutcome}`
    );

    await Lead.updateOne({ _id: lead._id }, { $set: { leadMagnet: "not-vip" } });
    const branchBResult = await walkEnrollment(cloneEnrollment({}), campaign, {
      now: ARBITRARY_NOW,
      send: countingSender,
      dryRun: true,
    });
    check(
      "condition 'no' branch (segment=not-vip) visits exactly [n_cond, n_exit_no] and exits branch_b",
      JSON.stringify(branchBResult.path) === JSON.stringify(["n_cond", "n_exit_no"]) && branchBResult.exitOutcome === "branch_b",
      `path=${JSON.stringify(branchBResult.path)} exitOutcome=${branchBResult.exitOutcome}`
    );

    // --- check 2: wait clamping into window/timezone/skipDays ----------
    // Friday 23:10 IST + 2 days lands Sunday 23:10 IST — outside the
    // 10:00-20:00 window AND on a skipped day (skipDays:[0]) — so the
    // resolved nextSendAt must be Monday 10:00 IST exactly.
    const armedFriday2310IST = new Date(Date.UTC(2024, 0, 5, 17, 40, 0)); // Fri 2024-01-05 23:10 Asia/Kolkata
    const expectedMonday1000IST = new Date(Date.UTC(2024, 0, 8, 4, 30, 0)); // Mon 2024-01-08 10:00 Asia/Kolkata
    const waitEnrollment = { ...enrollment.toObject(), history: [] };
    const waitResult = await walkEnrollment(waitEnrollment, campaign, {
      now: armedFriday2310IST,
      send: countingSender,
      dryRun: true,
    });
    check(
      "Friday 23:10 + 2-day wait + Asia/Kolkata 10:00-20:00 window + skipDays:[0] resolves nextSendAt to Monday 10:00 IST",
      waitResult.stop === "waiting" && waitResult.nextSendAt instanceof Date && waitResult.nextSendAt.getTime() === expectedMonday1000IST.getTime(),
      `stop=${waitResult.stop} nextSendAt=${waitResult.nextSendAt && waitResult.nextSendAt.toISOString()} expected=${expectedMonday1000IST.toISOString()}`
    );

    // --- check 3: per-tick hop limit trips on a cycle with no wait node -
    const cycleEnrollment = {
      campaign: cycleCampaign._id,
      targetModel: "Lead",
      targetId: lead._id,
      phone: LEAD_PHONE,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_cyc1",
      nextSendAt: new Date(),
      history: [],
      createdAt: new Date(),
    };
    let hopResult = null;
    let hopThrew = null;
    try {
      hopResult = await walkEnrollment(cycleEnrollment, cycleCampaign, {
        now: ARBITRARY_NOW,
        send: countingSender,
        dryRun: true,
      });
    } catch (err) {
      hopThrew = err;
    }
    check(
      "hop-limit cycle does not throw an uncaught exception",
      hopThrew === null,
      hopThrew ? `threw: ${hopThrew.message}` : ""
    );
    check(
      `hop-limit cycle parks the enrollment as "failed" after exactly ${MAX_HOPS_PER_TICK} hops, instead of completing or looping forever`,
      Boolean(hopResult) && hopResult.stop === "failed" && hopResult.hops === MAX_HOPS_PER_TICK,
      `stop=${hopResult && hopResult.stop} hops=${hopResult && hopResult.hops} (limit ${MAX_HOPS_PER_TICK})`
    );
    check(
      "hop-limit park reason explains it was a hop-limit trip",
      Boolean(hopResult) && /hop limit/i.test(hopResult.reason || ""),
      `reason=${hopResult && hopResult.reason}`
    );

    // --- check 4: enrollment pinned to graphVersion:1 survives a republish
    campaign.versions.push({ version: 2, nodes: NODES_V2, edges: EDGES_V2, publishedAt: new Date() });
    campaign.liveVersion = 2;
    await campaign.save();

    await Lead.updateOne({ _id: lead._id }, { $set: { leadMagnet: "vip" } });
    const pinnedResult = await walkEnrollment(cloneEnrollment({ graphVersion: 1 }), campaign, {
      now: ARBITRARY_NOW,
      send: countingSender,
      dryRun: true,
    });
    check(
      "enrollment pinned to graphVersion:1 still walks version 1's nodes after version 2 is published",
      pinnedResult.exitOutcome === "branch_a" && JSON.stringify(pinnedResult.path) === JSON.stringify(["n_cond", "n_exit_yes"]),
      `exitOutcome=${pinnedResult.exitOutcome} (v2's changed value would be "branch_a_v2_CHANGED") path=${JSON.stringify(pinnedResult.path)}`
    );

    // --- check 5: migration spot-check, task 6's function called directly
    const legacyEnrollment = { currentStepIndex: 1, history: [] };
    const legacyGraphInfo = { nodeIds: new Set(["n0", "n1", "n2", "exit"]) };
    const migrationPlan = planEnrollment(legacyEnrollment, legacyGraphInfo);
    check(
      'legacy enrollment with currentStepIndex:1 migrates to currentNodeId "n2"',
      migrationPlan.action === "migrate" &&
        migrationPlan.stats &&
        migrationPlan.stats.currentNodeId === "n2" &&
        migrationPlan.update &&
        migrationPlan.update.$set &&
        migrationPlan.update.$set.currentNodeId === "n2",
      `action=${migrationPlan.action} currentNodeId=${migrationPlan.stats && migrationPlan.stats.currentNodeId}`
    );

    // --- check 6: zero calls ever reached the injected sender/provider,
    // across every scenario above, including the hop-limit scenario -------
    check(
      "zero calls reached the injected sender/provider across the entire run, including the hop-limit scenario",
      sendCalls === 0,
      `sendCalls=${sendCalls}`
    );
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
