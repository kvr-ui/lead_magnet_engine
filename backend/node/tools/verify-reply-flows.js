// Verifies reply-driven flow control (lib/replyFlows.js and its seams):
//
//   1. the walker stamps the machine-readable "window-closed" reason code when
//      a free-text send is refused, so the webhook can find exactly those rows,
//   2. handleInboundReply resumes window-parked enrollments (new code and
//      legacy prose alike), completes stop-on-reply enrollments with outcome
//      "replied", refuses to resume an opted-out phone, and leaves every other
//      paused row alone, and
//   3. the walker's `condition` node with on: "reply" branches on whether the
//      phone sent anything inbound since the last send.
//
// Nothing here reaches WATI. The walker runs dry with an injected sender and
// injected deps; the replyFlows checks run against real Campaign /
// CampaignEnrollment / OptOut rows seeded with throwaway phones and campaign
// names, all deleted in the finally block.
const path = require("node:path");
const m = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const { walkEnrollment } = require("../lib/campaignEngine");
const { handleInboundReply } = require("../lib/replyFlows");
const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const OptOut = require("../models/OptOut");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

const RESUME_PHONE = "919000000301"; // window-parked, plain campaign -> resumes
const LEGACY_PHONE = "919000000302"; // parked before the reason code existed -> still resumes
const STOP_PHONE = "919000000303"; // enrolled in a stop-on-reply campaign -> completed
const OPTED_PHONE = "919000000304"; // opted out earlier -> never resumed
const OTHER_PHONE = "919000000305"; // paused for an unrelated reason -> untouched

const CAMPAIGN_NAMES = ["__verify_reply_flows__", "__verify_reply_flows_stop__"];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- part 1 graph: a lone free-text message ---------------------------------
const TEXT_NODES = [
  { id: "n_text", kind: "message", label: "Free text", config: { type: "text", text: "Hi {{name}}, ready to continue?" } },
  { id: "n_end", kind: "exit", label: "Done", config: { outcome: "done" } },
];
const TEXT_EDGES = [{ id: "e_text_end", from: "n_text", to: "n_end" }];

// --- part 3 graph: reply? --yes--> exit(engaged), --no--> exit(quiet) -------
const REPLY_NODES = [
  { id: "n_reply", kind: "condition", label: "Replied?", config: { on: "reply" } },
  { id: "n_yes", kind: "exit", label: "Engaged", config: { outcome: "engaged" } },
  { id: "n_no", kind: "exit", label: "Quiet", config: { outcome: "quiet" } },
];
const REPLY_EDGES = [
  { id: "e_yes", from: "n_reply", to: "n_yes", branch: "yes" },
  { id: "e_no", from: "n_reply", to: "n_no", branch: "no" },
];

// The walker reads only these fields off a campaign, so plain objects drive it.
const campaignObj = (nodes, edges) => ({
  name: "__verify_reply_flows_walk__",
  channelId: "",
  versions: [{ version: 1, nodes, edges, publishedAt: new Date() }],
  liveVersion: 1,
});

const LEAD = { _id: "lead-1", name: "Asha", phone: RESUME_PHONE };
const fakeSource = { findById: async () => LEAD };

const enrollmentAt = (nodeId, phone, extra = {}) => ({
  campaign: "campaign-1",
  targetModel: "Lead",
  targetId: LEAD._id,
  phone,
  status: "active",
  graphVersion: 1,
  currentNodeId: nodeId,
  nextSendAt: new Date(),
  history: [],
  createdAt: new Date(),
  ...extra,
});

const recordingSender = (sends, err) => async (args) => {
  sends.push(args);
  if (err) throw err;
  return { whatsappMessageId: "wamid.__verify_reply_flows__" };
};

(async () => {
  // --- part 1: the park carries the machine-readable reason code ----------
  {
    const refusal = new Error("no open window");
    refusal.windowClosed = true;
    const result = await walkEnrollment(enrollmentAt("n_text", RESUME_PHONE), campaignObj(TEXT_NODES, TEXT_EDGES), {
      dryRun: true,
      send: recordingSender([], refusal),
      deps: { resolveSource: async () => fakeSource, isWindowOpen: async () => false },
    });
    check("a refused free-text send still pauses the lead", result.status === "paused", `status ${result.status}`);
    check(
      "the park carries the window-closed reason code",
      result.reasonCode === CampaignEnrollment.REASON_WINDOW_CLOSED,
      `reasonCode ${result.reasonCode}`
    );
    check("the lead stays on the message node for the retry", result.currentNodeId === "n_text", `at ${result.currentNodeId}`);
  }

  // --- part 2: what an inbound reply does to seeded enrollments -----------
  await m.connect(URI);

  const allPhones = [RESUME_PHONE, LEGACY_PHONE, STOP_PHONE, OPTED_PHONE, OTHER_PHONE];
  const wipe = async () => {
    const campaigns = await Campaign.find({ name: { $in: CAMPAIGN_NAMES } }).select("_id");
    await CampaignEnrollment.deleteMany({
      $or: [{ campaign: { $in: campaigns.map((c) => c._id) } }, { phone: { $in: allPhones } }],
    });
    await Campaign.deleteMany({ name: { $in: CAMPAIGN_NAMES } });
    await OptOut.deleteMany({ phone: { $in: allPhones } });
  };
  await wipe();

  try {
    const plain = await Campaign.create({ name: CAMPAIGN_NAMES[0] });
    const stopper = await Campaign.create({ name: CAMPAIGN_NAMES[1], stopOnReply: true });

    const seed = (campaign, phone, extra) =>
      CampaignEnrollment.create({
        campaign: campaign._id,
        targetModel: "Lead",
        targetId: new m.Types.ObjectId(),
        phone,
        graphVersion: 1,
        currentNodeId: "n_text",
        nextSendAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        ...extra,
      });

    const windowPark = {
      status: "paused",
      statusReason: 'message node "n_text" could not send free text: no open window',
      statusReasonCode: CampaignEnrollment.REASON_WINDOW_CLOSED,
    };

    await seed(plain, RESUME_PHONE, windowPark);
    // Parked before statusReasonCode existed: prose only, no code.
    await seed(plain, LEGACY_PHONE, {
      status: "paused",
      statusReason: 'message node "n_text" could not send free text: Phone has no open 24-hour conversation window',
    });
    await seed(stopper, STOP_PHONE, { status: "active" });
    await seed(stopper, STOP_PHONE, windowPark);
    await seed(plain, OPTED_PHONE, windowPark);
    await OptOut.create({ phone: OPTED_PHONE, source: "inbound-keyword", keyword: "STOP" });
    await seed(plain, OTHER_PHONE, { status: "paused", statusReason: 'node "n_gone" does not exist in version 1' });

    {
      const before = Date.now();
      const { resumed } = await handleInboundReply(RESUME_PHONE);
      const row = await CampaignEnrollment.findOne({ phone: RESUME_PHONE });
      check("a reply resumes the window-parked enrollment", resumed === 1 && row.status === "active", `resumed ${resumed}, status ${row.status}`);
      check("the resumed row is due immediately", row.nextSendAt <= new Date() && row.nextSendAt.getTime() >= before - 1000, row.nextSendAt.toISOString());
      check("the stale reason and code are cleared", !row.statusReason && !row.statusReasonCode, "");
      check("the row still points at the refused message node", row.currentNodeId === "n_text", `at ${row.currentNodeId}`);

      // And the resumed enrollment actually sends once the window is open.
      const sends = [];
      const walk = await walkEnrollment(enrollmentAt("n_text", RESUME_PHONE), campaignObj(TEXT_NODES, TEXT_EDGES), {
        dryRun: true,
        send: recordingSender(sends),
        deps: { resolveSource: async () => fakeSource, isWindowOpen: async () => true },
      });
      check("the resumed tick re-attempts the parked free-text send", sends.length === 1 && sends[0].type === "text", `${sends.length} send(s)`);
      // A send ends the tick (stop: "sent"); the exit node is reached on the
      // next one. What matters here is that the walk is no longer parked.
      check("and the walk ends on the send, not parked again", walk.stop === "sent" && !walk.reason, `stop ${walk.stop}`);
    }

    {
      const { resumed } = await handleInboundReply(LEGACY_PHONE);
      const row = await CampaignEnrollment.findOne({ phone: LEGACY_PHONE });
      check("a row parked before the reason code existed also resumes", resumed === 1 && row.status === "active", `status ${row.status}`);
    }

    {
      const { stopped, resumed } = await handleInboundReply(STOP_PHONE);
      const rows = await CampaignEnrollment.find({ phone: STOP_PHONE });
      check("stop-on-reply completes the active enrollment AND the parked one", stopped === 2 && rows.every((r) => r.status === "completed"), `stopped ${stopped}`);
      check('both carry outcome "replied"', rows.every((r) => r.outcome === "replied"), rows.map((r) => r.outcome).join(", "));
      check("neither was resumed instead", resumed === 0, `resumed ${resumed}`);
    }

    {
      const { stopped, resumed } = await handleInboundReply(OPTED_PHONE);
      const row = await CampaignEnrollment.findOne({ phone: OPTED_PHONE });
      check("an opted-out phone is never resurrected by a later message", stopped === 0 && resumed === 0 && row.status === "paused", `status ${row.status}`);
    }

    {
      const { resumed } = await handleInboundReply(OTHER_PHONE);
      const row = await CampaignEnrollment.findOne({ phone: OTHER_PHONE });
      check("a row paused for an unrelated reason is untouched", resumed === 0 && row.status === "paused" && Boolean(row.statusReason), `status ${row.status}`);
    }

    // --- part 3: the on:"reply" condition ---------------------------------
    {
      const lastSend = new Date(Date.now() - 60 * 60 * 1000);
      const withHistory = {
        history: [{ nodeId: "n_earlier", kind: "message", templateId: "t", sentAt: lastSend, status: "sent" }],
      };
      const deps = (repliedAt) => ({
        resolveSource: async () => fakeSource,
        MessageEvent: {
          countDocuments: async (q) => {
            const since = q.receivedAt && q.receivedAt.$gte;
            return repliedAt && q.status === "received" && (!since || repliedAt >= since) ? 1 : 0;
          },
        },
      });

      const yes = await walkEnrollment(enrollmentAt("n_reply", RESUME_PHONE, withHistory), campaignObj(REPLY_NODES, REPLY_EDGES), {
        dryRun: true,
        send: recordingSender([]),
        deps: deps(new Date()),
      });
      check("a reply since the last send takes the 'yes' branch", yes.exitOutcome === "engaged", `outcome ${yes.exitOutcome}`);

      const no = await walkEnrollment(enrollmentAt("n_reply", RESUME_PHONE, withHistory), campaignObj(REPLY_NODES, REPLY_EDGES), {
        dryRun: true,
        send: recordingSender([]),
        deps: deps(new Date(lastSend.getTime() - 60 * 60 * 1000)),
      });
      check("an old reply that predates the last send takes 'no'", no.exitOutcome === "quiet", `outcome ${no.exitOutcome}`);
    }
  } finally {
    await wipe();
    await m.disconnect();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
