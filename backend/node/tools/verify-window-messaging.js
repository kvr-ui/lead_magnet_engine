// Verifies the two halves of free-text ("session") messaging:
//
//   1. the walker's `condition` node with on: "window", which lets a flow route
//      leads by whether they can be sent free text at all, and
//   2. the send-time gate in lib/whatsappProvider.js, which refuses a free-text
//      send outside the customer's window however the graph was drawn.
//
// Nothing here reaches WATI. Part 1 drives walkEnrollment with an injected
// sender and injected deps, so no provider module is even loaded into the path.
// Part 2 does exercise the real whatsappProvider.sendMessage — the point is to
// prove the gate that lives there — but replaces watiClient's two send
// functions with recorders first, so the only thing that ever leaves is a push
// onto an array. Both are asserted at the end: the real client's send functions
// are checked to have been called zero times.
const path = require("node:path");
const m = require("mongoose");

// Part 3 reads the connected provider's stored token, which is encrypted with
// the key the server loads from .env — same load as tools/migrate-to-graph.js.
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const { walkEnrollment } = require("../lib/campaignEngine");
const wati = require("../lib/watiClient");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

const OPEN_PHONE = "919000000201"; // replied an hour ago -> window open
const SHUT_PHONE = "919000000202"; // never replied       -> window closed
const HOUR = 60 * 60 * 1000;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// --- the graph: window? --yes--> free text, --no--> template ---------------
const NODES = [
  { id: "n_win", kind: "condition", label: "Window open?", config: { on: "window" } },
  { id: "n_text", kind: "message", label: "Free text", config: { type: "text", text: "Hi {{name}}, still stuck? Reply here." } },
  { id: "n_tpl", kind: "message", label: "Template", config: { templateId: "verify_window_tpl", params: [{ index: 1, from: "name" }] } },
  { id: "n_end", kind: "exit", label: "Done", config: { outcome: "done" } },
];
const EDGES = [
  { id: "e_yes", from: "n_win", to: "n_text", branch: "yes" },
  { id: "e_no", from: "n_win", to: "n_tpl", branch: "no" },
  { id: "e_text_end", from: "n_text", to: "n_end" },
  { id: "e_tpl_end", from: "n_tpl", to: "n_end" },
];

// The walker reads only these three fields off a campaign, so a plain object
// drives it exactly as a persisted one would — and leaves nothing to clean up.
const CAMPAIGN = {
  name: "__verify_window_messaging__",
  channelId: "",
  versions: [{ version: 1, nodes: NODES, edges: EDGES, publishedAt: new Date() }],
  liveVersion: 1,
};

const LEAD = { _id: "lead-1", name: "Asha", phone: OPEN_PHONE };

// Stands in for the source: the message node reads the lead through this to
// render its text, and nothing else in this graph touches it.
const fakeSource = { findById: async () => LEAD };

const enrollmentAt = (nodeId, phone) => ({
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
});

// Records what the walker asked to be sent, without sending it.
const recordingSender = (sends, err) => async (args) => {
  sends.push(args);
  if (err) throw err;
  return { whatsappMessageId: "wamid.__verify_window__" };
};

// deps.isWindowOpen is the seam the condition node asks through, so part 1 can
// state the answer outright rather than seeding a log to imply it.
const depsWithWindow = (open) => ({ resolveSource: async () => fakeSource, isWindowOpen: async () => open });

(async () => {
  // --- part 1: the condition node routes on the window ------------------
  {
    const sends = [];
    const result = await walkEnrollment(enrollmentAt("n_win", OPEN_PHONE), CAMPAIGN, {
      dryRun: true,
      send: recordingSender(sends),
      deps: depsWithWindow(true),
    });
    check("an open window takes the 'yes' branch", result.path.includes("n_text") && !result.path.includes("n_tpl"), result.path.join(" -> "));
    check("the 'yes' branch sends free text", sends.length === 1 && sends[0].type === "text", `type ${sends[0] && sends[0].type}`);
    check(
      "the text is rendered from the lead read live for this tick",
      sends[0] && sends[0].text === "Hi Asha, still stuck? Reply here.",
      JSON.stringify(sends[0] && sends[0].text)
    );
    check("a free-text send carries no template parameters", sends[0] && sends[0].params.length === 0, "");
  }

  {
    const sends = [];
    const result = await walkEnrollment(enrollmentAt("n_win", SHUT_PHONE), CAMPAIGN, {
      dryRun: true,
      send: recordingSender(sends),
      deps: depsWithWindow(false),
    });
    check("a closed window takes the 'no' branch", result.path.includes("n_tpl") && !result.path.includes("n_text"), result.path.join(" -> "));
    check(
      "the 'no' branch sends a template, unchanged from before free text existed",
      sends.length === 1 && sends[0].type === "template" && sends[0].templateId === "verify_window_tpl",
      `type ${sends[0] && sends[0].type}`
    );
    check("a template send still renders its positional params", sends[0] && sends[0].params[0] === "Asha", JSON.stringify(sends[0] && sends[0].params));
  }

  // --- part 2: a refused free-text send parks the lead -------------------
  {
    const sends = [];
    const refusal = new Error("no open window");
    refusal.windowClosed = true;
    const enrollment = enrollmentAt("n_text", SHUT_PHONE);
    const result = await walkEnrollment(enrollment, CAMPAIGN, {
      dryRun: true,
      send: recordingSender(sends, refusal),
      deps: depsWithWindow(false),
    });
    check("a window closed at send time pauses the lead", result.status === "paused", `status ${result.status}`);
    check("it is not burned as a failure", result.stop !== "failed", `stop ${result.stop}`);
    check("the lead stays on the message node it could not send", result.currentNodeId === "n_text", `at ${result.currentNodeId}`);
    check("the reason names the node and the refusal", /n_text/.test(result.reason || "") && /window/i.test(result.reason || ""), result.reason);
    check("the refused attempt is recorded in history", result.history.length === 1 && result.history[0].status === "error", "");
    check("the history entry says it was a free-text send", result.history[0] && result.history[0].messageType === "text", "");
  }

  // --- part 3: the real send-time gate ----------------------------------
  //
  // Everything above proves the walker behaves correctly GIVEN a refusal. This
  // proves the refusal actually happens, in the one place every send passes
  // through, against a window derived from real MessageEvent rows.
  await m.connect(URI);
  const events = m.connection.db.collection("messageevents");
  const wipe = () => events.deleteMany({ eventType: "__verify_window_messaging__" });
  await wipe();

  const realSendTemplate = wati.sendTemplateMessage;
  const realSendSession = wati.sendSessionMessage;

  try {
    await events.insertOne({
      phone: OPEN_PHONE,
      eventType: "__verify_window_messaging__",
      status: "received",
      receivedAt: new Date(Date.now() - HOUR),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // The recorders that stand in for the network. Installed before the
    // provider is required, so there is no window in which a real send could
    // slip out — and restored in the finally block whatever happens.
    const sessionSends = [];
    const templateSends = [];
    wati.sendSessionMessage = async (args) => {
      sessionSends.push(args);
      return { result: true };
    };
    wati.sendTemplateMessage = async (args) => {
      templateSends.push(args);
      return { result: true };
    };

    const provider = require("../lib/whatsappProvider");
    const { isSendingEnabled } = require("../lib/sendingSwitch");
    const connected = await provider.isConfigured();
    const sending = await isSendingEnabled();
    // Two gates sit in front of the window check, and a run with either of them
    // shut would report their refusal as the window's. Named individually so a
    // skip says which one to change.
    const allowlisted = !process.env.SEND_PHONE_ALLOWLIST || !process.env.SEND_PHONE_ALLOWLIST.trim();
    const blocker = !connected
      ? "no WhatsApp provider connected"
      : !sending
        ? "sending is off"
        : !allowlisted
          ? "SEND_PHONE_ALLOWLIST is set, and these throwaway numbers are not on it"
          : null;

    if (blocker) {
      // Not a failure: the gates in front of the window check are doing their
      // job, and there is nothing to learn about the window one while they are.
      console.log(`SKIP  the live send-time gate — ${blocker}.`);
    } else {
      let closedErr = null;
      try {
        await provider.sendMessage({ phone: SHUT_PHONE, type: "text", text: "should never leave" });
      } catch (err) {
        closedErr = err;
      }
      check("free text to a closed window is refused", Boolean(closedErr && closedErr.windowClosed), closedErr && closedErr.message);
      check("nothing was handed to the provider for it", sessionSends.length === 0, `${sessionSends.length} call(s)`);

      await provider.sendMessage({ phone: OPEN_PHONE, type: "text", text: "hello" });
      check("free text to an open window goes out as a session message", sessionSends.length === 1, `${sessionSends.length} call(s)`);
      check("it carries the body", sessionSends[0] && sessionSends[0].text === "hello", JSON.stringify(sessionSends[0] && sessionSends[0].text));

      let blankErr = null;
      try {
        await provider.sendMessage({ phone: OPEN_PHONE, type: "text", text: "   " });
      } catch (err) {
        blankErr = err;
      }
      check("a blank body is refused rather than sent", Boolean(blankErr) && !blankErr.windowClosed, blankErr && blankErr.message);

      // The whole point of templates: no window needed.
      await provider.sendMessage({ phone: SHUT_PHONE, templateId: "verify_window_tpl", params: ["Asha"] });
      check("a template to a closed window is not gated at all", templateSends.length === 1, `${templateSends.length} call(s)`);
    }
  } finally {
    wati.sendTemplateMessage = realSendTemplate;
    wati.sendSessionMessage = realSendSession;
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
