// Standalone, black-box verification of per-node visit tracking
// (models/CampaignNodeVisit.js + the instrumentation in lib/campaignEngine.js's
// walkEnrollment wrapper, task 4). Same pattern as verify-graph-walk.js /
// verify-webhook.js: connect straight to the local dev Mongo, seed throwaway
// data under an unmistakable __verify_*__ name, drive the real code path,
// assert one invariant at a time with check(), clean up on every path, exit
// non-zero on any failure.
//
// This script does NOT modify campaignEngine.js or CampaignNodeVisit.js — it
// requires them and calls/queries them exactly as any other caller would.
//
// The whole point of task 4 is that decision nodes (filter/condition/split/
// goal/wait/source/exit) write NOTHING to CampaignEnrollment.history — only a
// `message` or `action` node does — so the seeded graph below deliberately
// walks through one of each of source/filter/condition/wait, plus a message
// and a final exit, and the checks below confirm CampaignNodeVisit rows exist
// for the ones history has nothing to say about.
const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const CampaignNodeVisit = require("../models/CampaignNodeVisit");
const Lead = require("../models/Lead");
const { walkEnrollment } = require("../lib/campaignEngine");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

const CAMPAIGN_NAME = "__verify_node_visits__";
const LEAD_PHONE = "919000000099";

// source -> filter (urgent?) -yes-> condition (ready?) -yes-> message -> exit
//                    \-no-> exit (not_urgent)      \-no-> wait -> back to condition
//
// filter, condition, wait and source are the four decision/no-history kinds
// this graph deliberately exercises. message is the one kind that DOES write
// history, seeded alongside them as the contrast the acceptance criteria ask
// for ("asserts rows appear for kinds that write no history").
const NODES_V1 = [
  {
    id: "n_src",
    kind: "source",
    label: "Lead",
    config: { sourceId: "Lead", filter: {}, map: { phone: "phone", urgent: "leadMagnet", ready: "name" } },
  },
  { id: "n_filter", kind: "filter", label: "Urgent?", config: { field: "urgent", operator: "eq", value: "urgent" } },
  { id: "n_filter_no_exit", kind: "exit", label: "Not urgent", config: { outcome: "not_urgent" } },
  { id: "n_cond", kind: "condition", label: "Ready?", config: { on: "field", field: "ready", operator: "eq", value: "ready" } },
  { id: "n_wait", kind: "wait", label: "Retry later", config: { amount: 1, unit: "hours" } },
  { id: "n_msg", kind: "message", label: "Hello", config: { templateId: "verify_node_visit_tpl", providerMeta: {}, params: [] } },
  { id: "n_exit", kind: "exit", label: "Done", config: { outcome: "done" } },
];
const EDGES_V1 = [
  { id: "e_src_filter", from: "n_src", to: "n_filter" },
  { id: "e_filter_yes", from: "n_filter", to: "n_cond", branch: "yes" },
  { id: "e_filter_no", from: "n_filter", to: "n_filter_no_exit", branch: "no" },
  { id: "e_cond_yes", from: "n_cond", to: "n_msg", branch: "yes" },
  { id: "e_cond_no", from: "n_cond", to: "n_wait", branch: "no" },
  { id: "e_wait_cond", from: "n_wait", to: "n_cond" },
  { id: "e_msg_exit", from: "n_msg", to: "n_exit" },
];

// v2 of the same campaign, published only after all the live ticks below —
// used solely to prove recorded rows keep the enrollment's PINNED graphVersion
// (1) rather than picking up the campaign's new liveVersion (2).
const NODES_V2 = NODES_V1;
const EDGES_V2 = EDGES_V1;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Stands in for whatsappProvider.sendMessage — no network call, just counts.
let sendCalls = 0;
const countingSender = async () => {
  sendCalls += 1;
  return {};
};

const NOW_1 = new Date("2026-01-01T00:00:00.000Z");
const NOW_2 = new Date("2026-01-01T02:00:00.000Z"); // later — firstVisitedAt must NOT move to this
const NOW_3 = new Date("2026-01-01T04:00:00.000Z");
const NOW_4 = new Date("2026-01-01T06:00:00.000Z");

let wipe = async () => {};

(async () => {
  await mongoose.connect(URI);

  wipe = async () => {
    const campaigns = await Campaign.find({ name: { $regex: /^__verify_node_visits__/ } }, { _id: 1 }).lean();
    const campaignIds = campaigns.map((c) => c._id);
    if (campaignIds.length) await CampaignNodeVisit.deleteMany({ campaign: { $in: campaignIds } });
    await CampaignEnrollment.deleteMany({ phone: LEAD_PHONE });
    await Campaign.deleteMany({ name: { $regex: /^__verify_node_visits__/ } });
    await Lead.deleteMany({ phone: LEAD_PHONE });
  };
  await wipe(); // clean slate from any previous crashed run

  try {
    // --- seed -----------------------------------------------------------
    const lead = await Lead.create({
      name: "not-ready", // maps to canonical "ready", read by n_cond
      phone: LEAD_PHONE,
      leadMagnet: "urgent", // maps to canonical "urgent", read by n_filter
    });

    const campaign = await Campaign.create({
      name: CAMPAIGN_NAME,
      description: "throwaway fixture for tools/verify-node-visits.js",
      channelId: "",
      draft: { nodes: NODES_V1, edges: EDGES_V1 },
      versions: [{ version: 1, nodes: NODES_V1, edges: EDGES_V1, publishedAt: new Date() }],
      liveVersion: 1,
      active: true,
    });

    const enrollment = await CampaignEnrollment.create({
      campaign: campaign._id,
      targetModel: "Lead",
      targetId: lead._id,
      phone: LEAD_PHONE,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_src",
      nextSendAt: new Date(),
      history: [],
    });

    const walkNow = (now) => walkEnrollment(enrollment, campaign, { now, send: countingSender });

    // --- tick 1: source -> filter(yes) -> condition(no) -> wait, stops ---
    const tick1 = await walkNow(NOW_1);
    check(
      "tick 1 visits source, filter and condition (all no-history kinds) before parking on wait",
      tick1.stop === "waiting" &&
        JSON.stringify(tick1.path) === JSON.stringify(["n_src", "n_filter", "n_cond", "n_wait"]),
      `stop=${tick1.stop} path=${JSON.stringify(tick1.path)}`
    );
    check(
      "tick 1 writes zero CampaignEnrollment.history entries — decision nodes leave none",
      Array.isArray(enrollment.history) && enrollment.history.length === 0,
      `history.length=${enrollment.history.length}`
    );

    // Give the fire-and-forget bulkWrite a moment to land (see the "never
    // awaited" comment on the instrumentation itself).
    const settle = () => new Promise((r) => setTimeout(r, 300));
    await settle();

    const rowsAfterTick1 = await CampaignNodeVisit.find({ enrollment: enrollment._id }).lean();
    const byNode = (rows) => Object.fromEntries(rows.map((r) => [r.nodeId, r]));
    const afterTick1 = byNode(rowsAfterTick1);
    check(
      "after tick 1, a CampaignNodeVisit row exists for source, filter, condition AND wait — kinds that wrote no history",
      ["n_src", "n_filter", "n_cond", "n_wait"].every((id) => Boolean(afterTick1[id])),
      `nodeIds=${rowsAfterTick1.map((r) => r.nodeId).join(",")}`
    );
    check(
      "no row was written for n_msg or n_exit yet — this tick never reached them",
      !afterTick1.n_msg && !afterTick1.n_exit,
      `nodeIds=${rowsAfterTick1.map((r) => r.nodeId).join(",")}`
    );
    check(
      "every row after tick 1 carries the enrollment's pinned graphVersion (1)",
      rowsAfterTick1.every((r) => r.graphVersion === 1),
      `graphVersions=${rowsAfterTick1.map((r) => r.graphVersion).join(",")}`
    );
    const waitFirstVisitedAtTick1 = afterTick1.n_wait.firstVisitedAt.getTime();
    const condFirstVisitedAtTick1 = afterTick1.n_cond.firstVisitedAt.getTime();
    check(
      "firstVisitedAt on the tick-1 rows is tick 1's clock (NOW_1)",
      waitFirstVisitedAtTick1 === NOW_1.getTime() && condFirstVisitedAtTick1 === NOW_1.getTime(),
      `wait=${afterTick1.n_wait.firstVisitedAt.toISOString()} cond=${afterTick1.n_cond.firstVisitedAt.toISOString()}`
    );

    // --- tick 2: enrollment resumes at n_cond (still "no"), loops back to
    // n_wait again — a REVISIT of both n_cond and n_wait, at a later clock --
    const tick2 = await walkNow(NOW_2);
    check(
      "tick 2 re-walks condition and wait — a loop back through a wait node",
      tick2.stop === "waiting" && JSON.stringify(tick2.path) === JSON.stringify(["n_cond", "n_wait"]),
      `stop=${tick2.stop} path=${JSON.stringify(tick2.path)}`
    );
    await settle();

    const rowsAfterTick2 = await CampaignNodeVisit.find({ enrollment: enrollment._id }).lean();
    check(
      "revisiting n_cond and n_wait does not create second rows — still exactly 4 rows total",
      rowsAfterTick2.length === 4,
      `count=${rowsAfterTick2.length} nodeIds=${rowsAfterTick2.map((r) => r.nodeId).join(",")}`
    );
    const afterTick2 = byNode(rowsAfterTick2);
    check(
      "revisiting n_wait and n_cond does NOT move firstVisitedAt forward to tick 2's clock",
      afterTick2.n_wait.firstVisitedAt.getTime() === waitFirstVisitedAtTick1 &&
        afterTick2.n_cond.firstVisitedAt.getTime() === condFirstVisitedAtTick1,
      `wait=${afterTick2.n_wait.firstVisitedAt.toISOString()} cond=${afterTick2.n_cond.firstVisitedAt.toISOString()} (tick2 clock was ${NOW_2.toISOString()})`
    );

    // --- tick 3: lead becomes ready — condition now takes "yes", reaches the
    // message node, which DOES write history, and stops after the send -----
    await Lead.updateOne({ _id: lead._id }, { $set: { name: "ready" } });
    const tick3 = await walkNow(NOW_3);
    check(
      "tick 3 (lead now ready) walks condition -> message and stops after sending",
      tick3.stop === "sent" && JSON.stringify(tick3.path) === JSON.stringify(["n_cond", "n_msg"]),
      `stop=${tick3.stop} path=${JSON.stringify(tick3.path)}`
    );
    check(
      "the message node DID write a history entry, unlike the decision nodes before it",
      enrollment.history.length === 1 && enrollment.history[0].nodeId === "n_msg" && enrollment.history[0].status === "sent",
      `history=${JSON.stringify(enrollment.history)}`
    );

    // --- tick 4: exit ----------------------------------------------------
    const tick4 = await walkNow(NOW_4);
    check(
      "tick 4 reaches the exit node and completes with the configured outcome",
      tick4.stop === "completed" && tick4.exitOutcome === "done" && JSON.stringify(tick4.path) === JSON.stringify(["n_exit"]),
      `stop=${tick4.stop} exitOutcome=${tick4.exitOutcome}`
    );
    await settle();

    const rowsAfterTick4 = await CampaignNodeVisit.find({ enrollment: enrollment._id }).lean();
    const afterTick4 = byNode(rowsAfterTick4);
    check(
      "by the end, every node this enrollment ever passed through has exactly one row: source, filter, condition, wait, message, exit",
      rowsAfterTick4.length === 6 &&
        ["n_src", "n_filter", "n_cond", "n_wait", "n_msg", "n_exit"].every((id) => Boolean(afterTick4[id])),
      `count=${rowsAfterTick4.length} nodeIds=${rowsAfterTick4.map((r) => r.nodeId).join(",")}`
    );

    // --- dry run: zero rows written, on a fresh enrollment walking the same
    // graph from scratch -----------------------------------------------
    const dryLead = await Lead.create({
      name: "not-ready",
      phone: `${LEAD_PHONE}1`,
      leadMagnet: "urgent",
    });
    const dryEnrollmentId = new mongoose.Types.ObjectId();
    const dryEnrollment = {
      _id: dryEnrollmentId,
      campaign: campaign._id,
      targetModel: "Lead",
      targetId: dryLead._id,
      phone: `${LEAD_PHONE}1`,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_src",
      nextSendAt: new Date(),
      history: [],
      createdAt: new Date(),
    };
    const dryResult = await walkEnrollment(dryEnrollment, campaign, { now: NOW_1, send: countingSender, dryRun: true });
    await settle();
    const dryRows = await CampaignNodeVisit.find({ enrollment: dryEnrollmentId }).lean();
    check(
      "a dry run visits the same nodes in-memory (path is populated) but writes zero CampaignNodeVisit rows",
      dryResult.stop === "waiting" &&
        JSON.stringify(dryResult.path) === JSON.stringify(["n_src", "n_filter", "n_cond", "n_wait"]) &&
        dryRows.length === 0,
      `path=${JSON.stringify(dryResult.path)} rowsWritten=${dryRows.length}`
    );
    await Lead.deleteOne({ _id: dryLead._id });

    // --- write-failure guard: a broken bulkWrite must not throw into the
    // walk and must not touch the enrollment ------------------------------
    const failLead = await Lead.create({
      name: "not-ready",
      phone: `${LEAD_PHONE}2`,
      leadMagnet: "urgent",
    });
    const failEnrollment = await CampaignEnrollment.create({
      campaign: campaign._id,
      targetModel: "Lead",
      targetId: failLead._id,
      phone: `${LEAD_PHONE}2`,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_src",
      nextSendAt: new Date(),
      history: [],
    });
    const originalBulkWrite = CampaignNodeVisit.bulkWrite;
    CampaignNodeVisit.bulkWrite = () => {
      throw new Error("__verify_forced_bulkwrite_failure__");
    };
    let threwIntoWalk = null;
    let failResult = null;
    try {
      failResult = await walkEnrollment(failEnrollment, campaign, { now: NOW_1, send: countingSender });
    } catch (err) {
      threwIntoWalk = err;
    } finally {
      CampaignNodeVisit.bulkWrite = originalBulkWrite;
    }
    await settle();
    const failRows = await CampaignNodeVisit.find({ enrollment: failEnrollment._id }).lean();
    check(
      "a forced CampaignNodeVisit.bulkWrite failure (even a synchronous throw) never escapes walkEnrollment",
      threwIntoWalk === null,
      threwIntoWalk ? `threw: ${threwIntoWalk.message}` : ""
    );
    check(
      "the walk's result and the enrollment's own progress are unaffected by the write failure",
      Boolean(failResult) &&
        failResult.stop === "waiting" &&
        failEnrollment.currentNodeId === "n_cond" &&
        failEnrollment.status === "active",
      `stop=${failResult && failResult.stop} currentNodeId=${failEnrollment.currentNodeId} status=${failEnrollment.status}`
    );
    check(
      "no CampaignNodeVisit rows were left behind by the forced failure",
      failRows.length === 0,
      `count=${failRows.length}`
    );

    // --- graphVersion pinning: publish v2, confirm every row already
    // written still says graphVersion:1, the enrollment's pin — not the
    // campaign's new liveVersion -----------------------------------------
    campaign.versions.push({ version: 2, nodes: NODES_V2, edges: EDGES_V2, publishedAt: new Date() });
    campaign.liveVersion = 2;
    await campaign.save();

    const rowsAfterRepublish = await CampaignNodeVisit.find({ campaign: campaign._id }).lean();
    check(
      "after publishing graphVersion 2, every already-written row still carries graphVersion 1 (the enrollment's pin), not the campaign's new liveVersion",
      rowsAfterRepublish.length > 0 && rowsAfterRepublish.every((r) => r.graphVersion === 1),
      `graphVersions=${[...new Set(rowsAfterRepublish.map((r) => r.graphVersion))].join(",")}`
    );

    // --- unique index sanity: the model itself enforces one row per
    // (campaign, graphVersion, nodeId, enrollment) ------------------------
    let dupErr = null;
    try {
      await CampaignNodeVisit.create({
        campaign: campaign._id,
        graphVersion: 1,
        nodeId: "n_src",
        enrollment: enrollment._id,
        firstVisitedAt: new Date(),
      });
    } catch (err) {
      dupErr = err;
    }
    check(
      "the schema's unique index refuses a second row for the same (campaign, graphVersion, nodeId, enrollment)",
      Boolean(dupErr) && /duplicate|E11000/i.test(dupErr.message || dupErr.code || ""),
      dupErr ? `rejected as expected: ${dupErr.message}` : "insert unexpectedly succeeded"
    );

    // --- zero live sends ever reached the injected sender/provider --------
    // (every send in this run went through countingSender, never the real
    // whatsappProvider — this just confirms the count matches expectations:
    // exactly one, from tick 3's message node.)
    check("exactly one send reached the injected sender, from tick 3's message node", sendCalls === 1, `sendCalls=${sendCalls}`);

    await CampaignEnrollment.deleteMany({ _id: { $in: [failEnrollment._id] } });
    await Lead.deleteMany({ _id: { $in: [failLead._id] } });
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
