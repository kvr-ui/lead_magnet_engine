// Standalone, black-box verification of the per-node funnel aggregation
// (routes/messageEvents.js's `nodeFunnel`, task 10) that reads back what task
// 4's CampaignNodeVisit rows and CampaignEnrollment.history/currentNodeId
// already record. Same pattern as verify-node-visits.js / verify-graph-walk.js:
// connect straight to the local dev Mongo, seed throwaway data under an
// unmistakable __verify_*__ name, drive the real code path, assert one
// invariant at a time with check(), clean up on every path, exit non-zero on
// any failure.
//
// This script does NOT modify messageEvents.js — it requires the exported
// `nodeFunnel` and calls it exactly as the route handler does, the same way
// verify-filter-facets.js drives routes/campaigns.js's exported
// `distinctValues` directly rather than standing up the app.
//
// Rather than driving the real walker (already the job of verify-node-visits.js
// / verify-graph-walk.js), this script hand-seeds CampaignNodeVisit rows and
// CampaignEnrollment documents with exactly the mixed outcomes and version
// pins the acceptance criteria describe, so every count below has a
// hand-computed expected value instead of one derived from walker behaviour.
const mongoose = require("mongoose");

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const CampaignNodeVisit = require("../models/CampaignNodeVisit");
const Lead = require("../models/Lead");
const { nodeFunnel } = require("../routes/messageEvents");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

const CAMPAIGN_NAME = "__verify_node_funnel__";
const EMPTY_CAMPAIGN_NAME = "__verify_node_funnel__empty__";
const PHONE_PREFIX = "919000000"; // + a 3-digit lead index

// v1: source -> filter -(yes)-> message -> action -> wait -> exit_done
//                        \-(no)-> exit_fail
// filter and wait are the decision kinds that write no history entry at all —
// the case "decision nodes that write no history still report a non-zero
// reached" needs at least one of them actually visited by more than one lead.
const NODES_V1 = [
  { id: "n_src", kind: "source", label: "Lead Source", config: { sourceId: "Lead", filter: {}, map: { phone: "phone" } } },
  { id: "n_filter", kind: "filter", label: "Urgent?", config: { field: "urgent", operator: "eq", value: "urgent" } },
  { id: "n_msg", kind: "message", label: "Send Hello", config: { templateId: "verify_funnel_tpl", providerMeta: {}, params: [] } },
  { id: "n_action", kind: "action", label: "Write CRM", config: { url: "https://example.invalid/hook", method: "POST", body: {} } },
  { id: "n_wait", kind: "wait", label: "Wait a bit", config: { amount: 1, unit: "hours" } },
  { id: "n_exit_done", kind: "exit", label: "Done", config: { outcome: "done" } },
  { id: "n_exit_fail", kind: "exit", label: "Not urgent", config: { outcome: "not_urgent" } },
];
const EDGES_V1 = [
  { id: "e1", from: "n_src", to: "n_filter" },
  { id: "e2", from: "n_filter", to: "n_msg", branch: "yes" },
  { id: "e3", from: "n_filter", to: "n_exit_fail", branch: "no" },
  { id: "e4", from: "n_msg", to: "n_action" },
  { id: "e5", from: "n_action", to: "n_wait" },
  { id: "e6", from: "n_wait", to: "n_exit_done" },
];

// v2 adds one node no v1 enrollment could ever have a row for — the vehicle
// for proving a node id from an older version is never conflated with one
// meaning something else (or nothing at all) in the version being viewed.
const NODES_V2 = [...NODES_V1, { id: "n_v2_extra", kind: "wait", label: "Extra V2 wait", config: { amount: 2, unit: "hours" } }];
const EDGES_V2 = [...EDGES_V1, { id: "e7", from: "n_wait", to: "n_v2_extra" }, { id: "e8", from: "n_v2_extra", to: "n_exit_done" }];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const nodesById = (funnelResult) => Object.fromEntries(funnelResult.nodes.map((n) => [n.nodeId, n]));

let wipe = async () => {};

(async () => {
  await mongoose.connect(URI);

  wipe = async () => {
    const campaigns = await Campaign.find({ name: { $regex: /^__verify_node_funnel__/ } }, { _id: 1 }).lean();
    const campaignIds = campaigns.map((c) => c._id);
    if (campaignIds.length) {
      await CampaignNodeVisit.deleteMany({ campaign: { $in: campaignIds } });
      await CampaignEnrollment.deleteMany({ campaign: { $in: campaignIds } });
    }
    await Campaign.deleteMany({ name: { $regex: /^__verify_node_funnel__/ } });
    await Lead.deleteMany({ phone: { $regex: `^${PHONE_PREFIX}` } });
  };
  await wipe(); // clean slate from any previous crashed run

  try {
    // --- campaign with zero enrollments — must come back zeroed, not error ---
    const emptyCampaign = await Campaign.create({
      name: EMPTY_CAMPAIGN_NAME,
      channelId: "",
      draft: { nodes: NODES_V1, edges: EDGES_V1 },
      versions: [{ version: 1, nodes: NODES_V1, edges: EDGES_V1, publishedAt: new Date() }],
      liveVersion: 1,
      active: true,
    });

    const emptyResult = await nodeFunnel(emptyCampaign._id, undefined);
    check(
      "a campaign with no enrollments returns a body, not null/an error",
      Boolean(emptyResult) && Array.isArray(emptyResult.nodes),
      `result=${JSON.stringify(emptyResult)}`
    );
    check(
      "a campaign with no enrollments reports every one of its nodes, all zeroed",
      Boolean(emptyResult) &&
        emptyResult.nodes.length === NODES_V1.length &&
        emptyResult.nodes.every((n) => n.reached === 0 && n.sent === 0 && n.error === 0 && n.parkedHere === 0),
      `nodes=${JSON.stringify(emptyResult && emptyResult.nodes)}`
    );
    check(
      "a campaign with no enrollments reports zero otherVersions too",
      Boolean(emptyResult) && emptyResult.otherVersions.count === 0,
      `otherVersions=${JSON.stringify(emptyResult && emptyResult.otherVersions)}`
    );
    check(
      "graphVersion defaulted to the campaign's liveVersion (1) when not requested",
      Boolean(emptyResult) && emptyResult.graphVersion === 1,
      `graphVersion=${emptyResult && emptyResult.graphVersion}`
    );

    // --- unknown campaign id — must come back null, not throw -------------
    const bogusId = new mongoose.Types.ObjectId();
    const bogusResult = await nodeFunnel(bogusId, undefined);
    check("an unknown campaign id resolves to null rather than throwing", bogusResult === null, `result=${JSON.stringify(bogusResult)}`);

    // --- the real fixture: publish v1, then v2, liveVersion ends on 2 -----
    const campaign = await Campaign.create({
      name: CAMPAIGN_NAME,
      channelId: "",
      draft: { nodes: NODES_V2, edges: EDGES_V2 },
      versions: [
        { version: 1, nodes: NODES_V1, edges: EDGES_V1, publishedAt: new Date() },
        { version: 2, nodes: NODES_V2, edges: EDGES_V2, publishedAt: new Date() },
      ],
      liveVersion: 2,
      active: true,
    });

    // Helper: create a lead + pinned enrollment + its CampaignNodeVisit rows
    // in one shot, so each of the 12 leads below reads as one paragraph.
    let leadSeq = 0;
    async function seed({ visited, history = [], currentNodeId, status, graphVersion }) {
      leadSeq += 1;
      const phone = `${PHONE_PREFIX}${String(leadSeq).padStart(3, "0")}`;
      const lead = await Lead.create({ name: `funnel-${leadSeq}`, phone, leadMagnet: "urgent" });
      const enrollment = await CampaignEnrollment.create({
        campaign: campaign._id,
        targetModel: "Lead",
        targetId: lead._id,
        phone,
        status,
        graphVersion,
        currentNodeId,
        nextSendAt: new Date(),
        history,
      });
      if (visited.length) {
        await CampaignNodeVisit.insertMany(
          visited.map((nodeId) => ({
            campaign: campaign._id,
            graphVersion,
            nodeId,
            enrollment: enrollment._id,
            firstVisitedAt: new Date(),
          }))
        );
      }
      return enrollment;
    }

    const sentEntry = (nodeId) => ({ nodeId, kind: "message", messageType: "template", templateId: "verify_funnel_tpl", sentAt: new Date(), status: "sent" });
    const errorEntry = (nodeId) => ({ nodeId, kind: "message", messageType: "template", templateId: "verify_funnel_tpl", sentAt: new Date(), status: "error", error: "boom" });
    const actionOkEntry = (nodeId) => ({ nodeId, kind: "action", messageType: "template", sentAt: new Date(), status: "ok", detail: "200" });
    const actionErrorEntry = (nodeId) => ({ nodeId, kind: "action", messageType: "template", sentAt: new Date(), status: "error", error: "boom" });

    // -- graphVersion 1 leads -------------------------------------------
    // lead1: parked mid-flow at the decision node n_filter, unresolved.
    await seed({ visited: ["n_src", "n_filter"], currentNodeId: "n_filter", status: "active", graphVersion: 1 });
    // lead2: went all the way through, one clean send, completed — done, not parked.
    await seed({
      visited: ["n_src", "n_filter", "n_msg", "n_exit_done"],
      history: [sentEntry("n_msg")],
      currentNodeId: "n_exit_done",
      status: "completed",
      graphVersion: 1,
    });
    // lead3: send errored and stayed put — failed and parked at n_msg.
    await seed({
      visited: ["n_src", "n_filter", "n_msg"],
      history: [errorEntry("n_msg")],
      currentNodeId: "n_msg",
      status: "failed",
      graphVersion: 1,
    });
    // lead4: errored once, retried and succeeded — one lead behind BOTH an
    // error and a sent at the same node, moved on to n_action afterwards.
    await seed({
      visited: ["n_src", "n_filter", "n_msg", "n_action"],
      history: [errorEntry("n_msg"), sentEntry("n_msg")],
      currentNodeId: "n_action",
      status: "active",
      graphVersion: 1,
    });
    // lead5: sent TWICE at the same node (a loop-back resend) — must count as
    // one lead in `sent`, not two.
    await seed({
      visited: ["n_src", "n_filter", "n_msg"],
      history: [sentEntry("n_msg"), sentEntry("n_msg")],
      currentNodeId: "n_msg",
      status: "active",
      graphVersion: 1,
    });
    // lead6: message sent, then the action node's write-back succeeded ("ok").
    await seed({
      visited: ["n_src", "n_filter", "n_msg", "n_action", "n_wait"],
      history: [sentEntry("n_msg"), actionOkEntry("n_action")],
      currentNodeId: "n_wait",
      status: "active",
      graphVersion: 1,
    });
    // lead7: message sent, but the action node's write-back errored, paused
    // sitting on n_action.
    await seed({
      visited: ["n_src", "n_filter", "n_msg", "n_action"],
      history: [sentEntry("n_msg"), actionErrorEntry("n_action")],
      currentNodeId: "n_action",
      status: "paused",
      graphVersion: 1,
    });
    // lead8: same happy path as lead6, paused sitting on n_wait instead.
    await seed({
      visited: ["n_src", "n_filter", "n_msg", "n_action", "n_wait"],
      history: [sentEntry("n_msg"), actionOkEntry("n_action")],
      currentNodeId: "n_wait",
      status: "paused",
      graphVersion: 1,
    });
    // lead9: sitting on n_filter but COMPLETED — must NOT count as parked there.
    await seed({ visited: ["n_src", "n_filter"], currentNodeId: "n_filter", status: "completed", graphVersion: 1 });
    // lead10: sitting on n_filter but CANCELLED — same negative case, other status.
    await seed({ visited: ["n_src", "n_filter"], currentNodeId: "n_filter", status: "cancelled", graphVersion: 1 });

    // -- graphVersion 2 leads (the campaign's live version) ---------------
    // lead11: parked on the node that ONLY exists in v2.
    await seed({ visited: ["n_src", "n_filter", "n_v2_extra"], currentNodeId: "n_v2_extra", status: "active", graphVersion: 2 });
    // lead12: completed, one send at n_msg, on v2.
    await seed({
      visited: ["n_src", "n_filter", "n_msg", "n_exit_done"],
      history: [sentEntry("n_msg")],
      currentNodeId: "n_exit_done",
      status: "completed",
      graphVersion: 2,
    });

    // ======================================================================
    // Query graphVersion 1 explicitly.
    // ======================================================================
    const v1 = await nodeFunnel(campaign._id, 1);
    check("querying graphVersion 1 explicitly echoes graphVersion:1 back", v1.graphVersion === 1, `graphVersion=${v1.graphVersion}`);
    check(
      "v1's node list carries every node id defined in v1's published graph, and nothing from v2's extra node",
      v1.nodes.length === NODES_V1.length && !v1.nodes.some((n) => n.nodeId === "n_v2_extra"),
      `nodeIds=${v1.nodes.map((n) => n.nodeId).join(",")}`
    );
    const v1Nodes = nodesById(v1);

    check(
      "decision node n_filter (writes no history) reports a non-zero `reached` from all 10 v1 leads",
      v1Nodes.n_filter.reached === 10,
      `n_filter.reached=${v1Nodes.n_filter.reached}`
    );
    check("n_filter never reports a sent/error — filter nodes write no history", v1Nodes.n_filter.sent === 0 && v1Nodes.n_filter.error === 0, JSON.stringify(v1Nodes.n_filter));
    check(
      "n_filter's `label` was resolved via the reused describeNode/graphNodeIndex helpers, matching the graph's own label",
      v1Nodes.n_filter.label === "Urgent?",
      `label=${v1Nodes.n_filter.label}`
    );
    check(
      "n_filter parkedHere counts only lead1 (active) — lead9 (completed) and lead10 (cancelled) sitting on the same node are excluded",
      v1Nodes.n_filter.parkedHere === 1,
      `parkedHere=${v1Nodes.n_filter.parkedHere}`
    );

    check("n_msg reached counts the 7 leads that got that far (2,3,4,5,6,7,8)", v1Nodes.n_msg.reached === 7, `reached=${v1Nodes.n_msg.reached}`);
    check(
      "n_msg `sent` counts distinct leads (2,4,5,6,7,8 = 6), not raw entries — lead5's two sends and lead4's retry each count once",
      v1Nodes.n_msg.sent === 6,
      `sent=${v1Nodes.n_msg.sent}`
    );
    check("n_msg `error` counts distinct leads with an error entry there (3,4 = 2)", v1Nodes.n_msg.error === 2, `error=${v1Nodes.n_msg.error}`);
    check(
      "n_msg parkedHere counts lead3 (failed) and lead5 (active) sitting there — 2",
      v1Nodes.n_msg.parkedHere === 2,
      `parkedHere=${v1Nodes.n_msg.parkedHere}`
    );
    check(
      "n_msg's templateId was resolved from the graph, matching the seeded template",
      v1Nodes.n_msg.templateId === "verify_funnel_tpl",
      `templateId=${v1Nodes.n_msg.templateId}`
    );

    check("n_action reached counts the 4 leads that got there (4,6,7,8)", v1Nodes.n_action.reached === 4, `reached=${v1Nodes.n_action.reached}`);
    check(
      "n_action `sent` folds the action-node success spelling 'ok' into the same success bucket as a message's 'sent' — leads 6 and 8 = 2",
      v1Nodes.n_action.sent === 2,
      `sent=${v1Nodes.n_action.sent}`
    );
    check("n_action `error` counts lead7's failed write-back — 1", v1Nodes.n_action.error === 1, `error=${v1Nodes.n_action.error}`);
    check(
      "n_action parkedHere counts lead4 (active) and lead7 (paused) — 2",
      v1Nodes.n_action.parkedHere === 2,
      `parkedHere=${v1Nodes.n_action.parkedHere}`
    );

    check("n_wait reached counts leads 6 and 8 — 2", v1Nodes.n_wait.reached === 2, `reached=${v1Nodes.n_wait.reached}`);
    check("n_wait parkedHere counts lead6 (active) and lead8 (paused) — 2", v1Nodes.n_wait.parkedHere === 2, `parkedHere=${v1Nodes.n_wait.parkedHere}`);
    check("n_wait never reports sent/error — wait nodes write no history", v1Nodes.n_wait.sent === 0 && v1Nodes.n_wait.error === 0, JSON.stringify(v1Nodes.n_wait));

    check("n_exit_fail, never reached by any seeded lead, is still reported, fully zeroed", v1Nodes.n_exit_fail.reached === 0 && v1Nodes.n_exit_fail.parkedHere === 0, JSON.stringify(v1Nodes.n_exit_fail));

    check(
      "requesting v1 explicitly reports the 2 v2-pinned leads as a single otherVersions total",
      v1.otherVersions.count === 2,
      `otherVersions=${JSON.stringify(v1.otherVersions)}`
    );

    // ======================================================================
    // Query with no graphVersion — must default to the campaign's liveVersion (2).
    // ======================================================================
    const liveDefault = await nodeFunnel(campaign._id, undefined);
    check("omitting graphVersion defaults to the campaign's liveVersion (2)", liveDefault.graphVersion === 2, `graphVersion=${liveDefault.graphVersion}`);
    const v2Nodes = nodesById(liveDefault);
    check(
      "v2's node list includes n_v2_extra, the node id that means nothing in v1",
      liveDefault.nodes.length === NODES_V2.length && Boolean(v2Nodes.n_v2_extra),
      `nodeIds=${liveDefault.nodes.map((n) => n.nodeId).join(",")}`
    );
    check("n_v2_extra reached/parkedHere reflect lead11 only — 1 and 1", v2Nodes.n_v2_extra.reached === 1 && v2Nodes.n_v2_extra.parkedHere === 1, JSON.stringify(v2Nodes.n_v2_extra));
    check(
      "v2's n_msg is a DIFFERENT count than v1's — only lead12 (1 send), not v1's 6 — proving no cross-version bleed for a shared node id",
      v2Nodes.n_msg.sent === 1 && v2Nodes.n_msg.sent !== v1Nodes.n_msg.sent,
      `v2.n_msg.sent=${v2Nodes.n_msg.sent} v1.n_msg.sent=${v1Nodes.n_msg.sent}`
    );
    check(
      "v2's n_action/n_wait, never touched by a v2 lead, report zero rather than v1's counts leaking across the version boundary",
      v2Nodes.n_action.reached === 0 && v2Nodes.n_wait.reached === 0,
      `n_action=${JSON.stringify(v2Nodes.n_action)} n_wait=${JSON.stringify(v2Nodes.n_wait)}`
    );
    check(
      "requesting the live version reports all 10 v1-pinned leads as a single otherVersions total",
      liveDefault.otherVersions.count === 10,
      `otherVersions=${JSON.stringify(liveDefault.otherVersions)}`
    );

    // Total enrollments sanity: 10 (v1) + 2 (v2) seeded, none double counted
    // and none dropped between the two queries' otherVersions figures.
    check(
      "the two queries' otherVersions figures are exact complements of each other's own-version enrollment count (10 and 2)",
      v1.otherVersions.count === 2 && liveDefault.otherVersions.count === 10,
      `v1.otherVersions=${v1.otherVersions.count} live.otherVersions=${liveDefault.otherVersions.count}`
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
