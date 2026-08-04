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
const http = require("node:http");
const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const Lead = require("../models/Lead");
const { walkEnrollment, performAction, MAX_HOPS_PER_TICK, GOAL_MET_OUTCOME } = require("../lib/campaignEngine");
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

// --- graphs for the three handlers task 12 added -------------------------
//
// These drive plain in-memory campaign objects rather than persisted ones: the
// walker only ever reads `name`, `channelId` and `versions[]` off a campaign,
// and the action cases need a url that isn't known until the throwaway HTTP
// server below has been given a port. Fewer rows to seed, and none to clean up.
const SPLIT_NODES = [
  { id: "n_split", kind: "split", label: "30/70", config: { ratio: 30 } },
  { id: "n_split_a", kind: "exit", label: "A", config: { outcome: "split_a" } },
  { id: "n_split_b", kind: "exit", label: "B", config: { outcome: "split_b" } },
];
const SPLIT_EDGES = [
  { id: "e_split_a", from: "n_split", to: "n_split_a", branch: "a" },
  { id: "e_split_b", from: "n_split", to: "n_split_b", branch: "b" },
];

const GOAL_NODES = [
  { id: "n_goal", kind: "goal", label: "Solved 3?", config: { metric: "count", threshold: 3 } },
  // Deliberately declares no outcome of its own, so this doubles as the proof
  // that a met goal names the ending rather than it flattening to "completed".
  { id: "n_goal_yes", kind: "exit", label: "Converted", config: {} },
  { id: "n_goal_no", kind: "exit", label: "Not yet", config: { outcome: "not_converted" } },
  // No outgoing edges at all: a met goal here is an implicit exit, and must
  // still be recorded as a conversion.
  { id: "n_goal_bare", kind: "goal", label: "Any activity?", config: { metric: "count", threshold: 1 } },
];
const GOAL_EDGES = [
  { id: "e_goal_yes", from: "n_goal", to: "n_goal_yes", branch: "yes" },
  { id: "e_goal_no", from: "n_goal", to: "n_goal_no", branch: "no" },
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
// The throwaway HTTP endpoint the action checks call. Held here so the finally
// block can shut it down even if a check throws first — a listening server
// would otherwise keep the process alive after the last assertion.
let actionServer = null;
const closeActionServer = async () => {
  if (!actionServer) return;
  // The /hang case deliberately leaves a request unanswered, so its socket has
  // to be destroyed or close() waits for a response that never comes.
  actionServer.closeAllConnections?.();
  await new Promise((resolve) => actionServer.close(resolve));
  actionServer = null;
};

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

    // --- check 6: split is stable per lead and distributes by ratio -----
    //
    // The walker only ever reads name/channelId/versions off a campaign, so
    // these three graphs are plain objects rather than seeded rows.
    const inMemoryCampaign = (name, nodes, edges) => ({
      name,
      channelId: "",
      versions: [{ version: 1, nodes, edges, publishedAt: new Date() }],
      liveVersion: 1,
    });

    const splitCampaign = inMemoryCampaign("__verify_graph_walk__split__", SPLIT_NODES, SPLIT_EDGES);
    const walkOnce = (enrollment, camp, options = {}) =>
      walkEnrollment(enrollment, camp, { now: ARBITRARY_NOW, send: countingSender, dryRun: true, ...options });

    const splitEnrollment = (targetId) => ({
      campaign: new mongoose.Types.ObjectId(),
      targetModel: "Lead",
      targetId,
      phone: LEAD_PHONE,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_split",
      nextSendAt: new Date(),
      history: [],
      createdAt: new Date(),
    });

    const SPLIT_POPULATION = 1000;
    const splitIds = Array.from({ length: SPLIT_POPULATION }, () => new mongoose.Types.ObjectId());

    const firstPass = [];
    for (const id of splitIds) firstPass.push((await walkOnce(splitEnrollment(id), splitCampaign)).exitOutcome);

    // Same leads, evaluated again from scratch a day later on fresh enrollment
    // objects. A branch derived from anything but the targetId — a random draw,
    // the clock, a counter — would move for at least some of them.
    let flipped = 0;
    for (let i = 0; i < splitIds.length; i++) {
      const again = await walkOnce(splitEnrollment(splitIds[i]), splitCampaign, {
        now: new Date(ARBITRARY_NOW.getTime() + 24 * 60 * 60 * 1000),
      });
      if (again.exitOutcome !== firstPass[i]) flipped++;
    }
    check(
      `every one of ${SPLIT_POPULATION} leads takes the same split branch when re-evaluated (no random or clock input)`,
      flipped === 0,
      `flipped=${flipped}/${SPLIT_POPULATION}`
    );

    const shareA = (firstPass.filter((o) => o === "split_a").length / SPLIT_POPULATION) * 100;
    check(
      `split configured at ratio 30 sends ~30% of ${SPLIT_POPULATION} distinct targetIds down branch "a"`,
      Math.abs(shareA - 30) <= 5,
      `actual=${shareA.toFixed(1)}% (tolerance ±5 points)`
    );

    const badSplitCampaign = inMemoryCampaign(
      "__verify_graph_walk__split_bad__",
      [{ id: "n_split", kind: "split", label: "unset", config: {} }, ...SPLIT_NODES.slice(1)],
      SPLIT_EDGES
    );
    const badSplit = await walkOnce(splitEnrollment(new mongoose.Types.ObjectId()), badSplitCampaign);
    check(
      "split with no ratio parks with a reason instead of inventing a 50/50 experiment",
      badSplit.stop === "paused" && /ratio/i.test(badSplit.reason || ""),
      `stop=${badSplit.stop} reason=${badSplit.reason}`
    );

    // --- check 7: goal counts only post-send activity, at the boundary --
    //
    // The goal node reads lib/leadActivity.js's rollup, whose cutoff is the
    // enrollment's last send (falling back to its creation time when it never
    // sent). That dep is substituted here so rows can be fabricated either side
    // of the cutoff without standing up an external activity database — but the
    // cutoff rule is reproduced exactly as leadActivity computes it, so a row
    // landing on the wrong side of it is a real miss and not an artefact of the
    // stand-in.
    const LAST_SEND = new Date("2026-01-01T00:00:00.000Z");
    const rollupOver = (rows) => async (enrollment) => {
      const history = enrollment.history || [];
      let cutoff = enrollment.createdAt ? new Date(enrollment.createdAt) : new Date(0);
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] && history[i].status === "sent" && history[i].sentAt) {
          cutoff = new Date(history[i].sentAt);
          break;
        }
      }
      const counted = rows.filter((at) => new Date(at) > cutoff);
      return {
        configured: true,
        matched: true,
        since: cutoff,
        key: "verify",
        count: counted.length,
        correct: counted.length,
        graded: counted.length,
      };
    };

    const goalCampaign = inMemoryCampaign("__verify_graph_walk__goal__", GOAL_NODES, GOAL_EDGES);
    const goalEnrollment = (overrides = {}) => ({
      campaign: new mongoose.Types.ObjectId(),
      targetModel: "Lead",
      targetId: lead._id,
      phone: LEAD_PHONE,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_goal",
      nextSendAt: new Date(),
      createdAt: new Date("2025-12-01T00:00:00.000Z"),
      history: [{ nodeId: "n_msg", templateId: "verify_graph_tpl", sentAt: LAST_SEND, status: "sent" }],
      ...overrides,
    });

    const before = (n) => Array.from({ length: n }, (_, i) => new Date(LAST_SEND.getTime() - (i + 1) * 60_000));
    const after = (n) => Array.from({ length: n }, (_, i) => new Date(LAST_SEND.getTime() + (i + 1) * 60_000));

    // Five rows before the last send and two after it, against a threshold of
    // three. Counting the pre-send rows would total seven and wrongly convert.
    const preSendOnly = await walkOnce(goalEnrollment(), goalCampaign, {
      deps: { activitySinceLastSend: rollupOver([...before(5), ...after(2)]) },
    });
    check(
      "goal ignores activity recorded before the last send (5 before + 2 after, threshold 3 → 'no')",
      preSendOnly.exitOutcome === "not_converted",
      `exitOutcome=${preSendOnly.exitOutcome} path=${JSON.stringify(preSendOnly.path)}`
    );

    const justUnder = await walkOnce(goalEnrollment(), goalCampaign, {
      deps: { activitySinceLastSend: rollupOver(after(2)) },
    });
    check(
      "goal just under its threshold (2 of 3) takes the 'no' branch",
      justUnder.exitOutcome === "not_converted",
      `exitOutcome=${justUnder.exitOutcome}`
    );

    const atBoundary = await walkOnce(goalEnrollment(), goalCampaign, {
      deps: { activitySinceLastSend: rollupOver(after(3)) },
    });
    check(
      "goal exactly at its threshold (3 of 3) takes the 'yes' branch and exits with a conversion outcome",
      atBoundary.exitOutcome === GOAL_MET_OUTCOME &&
        JSON.stringify(atBoundary.path) === JSON.stringify(["n_goal", "n_goal_yes"]),
      `exitOutcome=${atBoundary.exitOutcome} (exit node declares none, so the goal names it) path=${JSON.stringify(atBoundary.path)}`
    );

    const overBoundary = await walkOnce(goalEnrollment(), goalCampaign, {
      deps: { activitySinceLastSend: rollupOver(after(9)) },
    });
    check(
      "goal over its threshold (9 of 3) also converts",
      overBoundary.exitOutcome === GOAL_MET_OUTCOME,
      `exitOutcome=${overBoundary.exitOutcome}`
    );

    const bareGoal = await walkOnce(goalEnrollment({ currentNodeId: "n_goal_bare" }), goalCampaign, {
      deps: { activitySinceLastSend: rollupOver(after(1)) },
    });
    check(
      "a met goal with no outgoing edge still records the conversion rather than an unlabelled ending",
      bareGoal.status === "completed" && bareGoal.exitOutcome === GOAL_MET_OUTCOME,
      `status=${bareGoal.status} exitOutcome=${bareGoal.exitOutcome}`
    );

    const noSource = await walkOnce(goalEnrollment(), goalCampaign, {
      deps: {
        activitySinceLastSend: async () => ({ configured: false, matched: false, count: 0, correct: 0, graded: 0 }),
      },
    });
    check(
      "goal with no activity source configured parks with a reason instead of guessing a branch",
      noSource.stop === "paused" && /activity/i.test(noSource.reason || ""),
      `stop=${noSource.stop} reason=${noSource.reason}`
    );

    // --- check 8: the action node --------------------------------------
    let endpointHits = 0;
    let lastUrl = null;
    actionServer = http.createServer((req, res) => {
      endpointHits += 1;
      lastUrl = req.url;
      if (req.url.startsWith("/ok")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
        return;
      }
      if (req.url.startsWith("/fail")) {
        res.writeHead(500);
        res.end("no");
        return;
      }
      // /hang — the request is accepted and deliberately never answered, so the
      // only thing that can end it is the action's own timeout.
    });
    await new Promise((resolve) => actionServer.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${actionServer.address().port}`;

    const actionCampaign = (config) =>
      inMemoryCampaign(
        "__verify_graph_walk__action__",
        [
          { id: "n_act", kind: "action", label: "Notify CRM", config },
          { id: "n_act_exit", kind: "exit", label: "Done", config: { outcome: "acted" } },
        ],
        [{ id: "e_act", from: "n_act", to: "n_act_exit" }]
      );

    const actionEnrollment = () => ({
      campaign: new mongoose.Types.ObjectId(),
      targetModel: "Lead",
      targetId: lead._id,
      phone: LEAD_PHONE,
      status: "active",
      graphVersion: 1,
      currentNodeId: "n_act",
      nextSendAt: new Date(),
      history: [],
      createdAt: new Date(),
    });

    // Every action case drives the REAL executor (not a stand-in that merely
    // claims to time out) against the server above.
    const walkAction = (config, { sendingEnabled = true } = {}) => {
      const enrollment = actionEnrollment();
      const before = JSON.stringify(enrollment);
      return walkOnce(enrollment, actionCampaign(config), {
        performAction,
        deps: { isSendingEnabled: async () => sendingEnabled },
      }).then((result) => ({ result, enrollment, untouched: JSON.stringify(enrollment) === before }));
    };

    const hitsBeforeGate = endpointHits;
    const gated = await walkAction({ enabled: true, mode: "http", method: "POST", url: `${base}/ok` }, { sendingEnabled: false });
    check(
      "action with the send kill switch off does not fire and leaves the enrollment completely untouched",
      gated.result.stop === "gated" && gated.untouched && endpointHits === hitsBeforeGate,
      `stop=${gated.result.stop} untouched=${gated.untouched} endpointHits=${endpointHits - hitsBeforeGate}`
    );

    const hitsBeforeDisabled = endpointHits;
    const disabled = await walkAction({ mode: "http", method: "POST", url: `${base}/ok` });
    check(
      "action without an explicit enabled:true never fires, even with the kill switch on",
      disabled.result.stop === "paused" &&
        /disabled/i.test(disabled.result.reason || "") &&
        endpointHits === hitsBeforeDisabled &&
        disabled.enrollment.currentNodeId === "n_act" &&
        disabled.enrollment.history.length === 0,
      `stop=${disabled.result.stop} reason=${disabled.result.reason} endpointHits=${endpointHits - hitsBeforeDisabled}`
    );

    const hung = await walkAction({ enabled: true, mode: "http", method: "POST", url: `${base}/hang`, timeoutMs: 300 });
    const hungEntry = hung.enrollment.history[hung.enrollment.history.length - 1];
    check(
      "action against an endpoint that never answers times out instead of hanging the tick, and does not advance the lead",
      hung.result.stop === "failed" &&
        hung.enrollment.currentNodeId === "n_act" &&
        hungEntry &&
        hungEntry.kind === "action" &&
        hungEntry.status === "error" &&
        /timed out/i.test(hungEntry.error || ""),
      `stop=${hung.result.stop} currentNodeId=${hung.enrollment.currentNodeId} error=${hungEntry && hungEntry.error}`
    );

    const failed = await walkAction({ enabled: true, mode: "http", method: "POST", url: `${base}/fail` });
    const failedEntry = failed.enrollment.history[failed.enrollment.history.length - 1];
    check(
      "action that gets a non-2xx records the failure on history and does NOT advance the lead to the next node",
      failed.result.stop === "failed" &&
        failed.enrollment.currentNodeId === "n_act" &&
        failedEntry &&
        failedEntry.kind === "action" &&
        failedEntry.status === "error" &&
        /500/.test(failedEntry.error || ""),
      `stop=${failed.result.stop} currentNodeId=${failed.enrollment.currentNodeId} error=${failedEntry && failedEntry.error}`
    );

    const ok = await walkAction({
      enabled: true,
      mode: "http",
      method: "POST",
      url: `${base}/ok?phone={{phone}}`,
      body: { phone: "{{phone}}" },
    });
    const okEntry = ok.enrollment.history[ok.enrollment.history.length - 1];
    check(
      "action that succeeds records the outcome on history, follows its edge, and interpolates canonical lead values",
      ok.result.stop === "acted" &&
        ok.enrollment.currentNodeId === "n_act_exit" &&
        okEntry &&
        okEntry.kind === "action" &&
        okEntry.status === "ok" &&
        /200/.test(okEntry.detail || "") &&
        String(lastUrl).includes(LEAD_PHONE),
      `stop=${ok.result.stop} currentNodeId=${ok.enrollment.currentNodeId} detail=${okEntry && okEntry.detail} url=${lastUrl}`
    );

    await closeActionServer();

    // --- check 9: the action node's other mode, writing back to the source
    const writeBack = await walkAction({
      enabled: true,
      mode: "source",
      // A raw field on the source's own documents, not a canonical key: this
      // writes into the lead magnet's collection and has to speak its
      // vocabulary. The value still interpolates canonical keys.
      field: "leadMagnet",
      value: "written-by-action-{{phone}}",
    });
    const writtenLead = await Lead.findById(lead._id).lean();
    const writeEntry = writeBack.enrollment.history[writeBack.enrollment.history.length - 1];
    check(
      "action in source write-back mode writes the interpolated value onto the source document and follows its edge",
      writeBack.result.stop === "acted" &&
        writeBack.enrollment.currentNodeId === "n_act_exit" &&
        writtenLead.leadMagnet === `written-by-action-${LEAD_PHONE}` &&
        writeEntry &&
        writeEntry.kind === "action" &&
        writeEntry.status === "ok",
      `stop=${writeBack.result.stop} leadMagnet=${writtenLead.leadMagnet} detail=${writeEntry && writeEntry.detail}`
    );

    // A write that matches nothing is a failed write, not a silent success —
    // the lead must not walk on as though the source had been updated.
    const missingTarget = await (async () => {
      const enrollment = { ...actionEnrollment(), targetId: new mongoose.Types.ObjectId() };
      const result = await walkOnce(enrollment, actionCampaign({ enabled: true, mode: "source", field: "leadMagnet", value: "x" }), {
        performAction,
        deps: { isSendingEnabled: async () => true },
      });
      return { result, enrollment };
    })();
    check(
      "action write-back that matches no source document fails and does not advance the lead",
      missingTarget.result.stop === "failed" && missingTarget.enrollment.currentNodeId === "n_act",
      `stop=${missingTarget.result.stop} currentNodeId=${missingTarget.enrollment.currentNodeId} reason=${missingTarget.result.reason}`
    );

    // --- check 10: zero calls ever reached the injected sender/provider,
    // across every scenario above, including the hop-limit scenario -------
    check(
      "zero calls reached the injected sender/provider across the entire run, including the hop-limit scenario",
      sendCalls === 0,
      `sendCalls=${sendCalls}`
    );
  } finally {
    await closeActionServer();
    await wipe();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    await closeActionServer();
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
