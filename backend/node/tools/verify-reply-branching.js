// Verifies the two new condition kinds a `condition` node's config.on can
// pick — "reply-text" (did the contact's reply to a named upstream message
// node match a configured word/phrase) and "button" (did they tap a
// quick-reply/list button matching a configured label). See evaluateReplyText
// / evaluateButton / inboundEventsForNode in lib/campaignEngine.js.
//
// Both are scoped to one specific message node's send — matched via the
// reply-context id the webhook persists (inReplyToProviderMessageId, task 3)
// against the provider id captured on that node's own history entry — with a
// fallback to the same time-window scoping the pre-existing "engagement" kind
// already uses when no provider id was ever captured.
//
// Real MessageEvent documents are used (not a hand-rolled stub) so the actual
// Mongo query shapes evaluateCondition builds — the $in on
// inReplyToProviderMessageId, the enrollment+receivedAt fallback — are
// exercised for real, the same way verify-reply-flows.js exercises the real
// CampaignEnrollment/OptOut writes for its part of the plan. The walker itself
// runs dry (dryRun: true, no send override needed — there is no message node
// in any of these graphs, so send is never invoked).
const path = require("node:path");
const m = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const { walkEnrollment } = require("../lib/campaignEngine");
const MessageEvent = require("../models/MessageEvent");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

const PHONE = "919000000401"; // throwaway phone, only ever used by this fixture
const FIXTURE_TAG = "__verify_reply_branching__";

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// The walker reads only these fields off a campaign, so a plain object drives
// it — same as verify-reply-flows.js and verify-graph-walk.js. None of these
// graphs need an actual message node in `nodes`: a condition only reads the
// enrollment's own history for the nodeId it names.
const conditionGraph = (config) => ({
  name: "__verify_reply_branching_walk__",
  channelId: "",
  versions: [
    {
      version: 1,
      nodes: [
        { id: "n_cond", kind: "condition", label: "Cond", config },
        { id: "n_yes", kind: "exit", label: "Yes", config: { outcome: "yes_branch" } },
        { id: "n_no", kind: "exit", label: "No", config: { outcome: "no_branch" } },
      ],
      edges: [
        { id: "e_yes", from: "n_cond", to: "n_yes", branch: "yes" },
        { id: "e_no", from: "n_cond", to: "n_no", branch: "no" },
      ],
      publishedAt: new Date(),
    },
  ],
  liveVersion: 1,
});

const enrollmentAt = (enrollmentId, history) => ({
  _id: enrollmentId,
  campaign: "campaign-1",
  targetModel: "Lead",
  targetId: new m.Types.ObjectId(),
  phone: PHONE,
  status: "active",
  graphVersion: 1,
  currentNodeId: "n_cond",
  nextSendAt: new Date(),
  history,
  createdAt: new Date(),
});

const walk = (enrollment, config) =>
  walkEnrollment(enrollment, conditionGraph(config), { dryRun: true });

(async () => {
  await m.connect(URI);

  const wipe = () => MessageEvent.deleteMany({ "payload.fixture": FIXTURE_TAG });
  await wipe();

  try {
    const ENROLLMENT_ID = new m.Types.ObjectId();
    const T0 = new Date(Date.now() - 60 * 60 * 1000); // an hour ago — "when node X sent"

    // --- fixtures: one history entry per scenario, each naming a distinct
    // upstream "message" node so the events below can be scoped precisely ---
    const sendHistory = (nodeId, providerMessageId) => ({
      nodeId,
      kind: "message",
      templateId: "t",
      sentAt: T0,
      status: "sent",
      ...(providerMessageId ? { providerMessageId } : {}),
    });

    const WAMID_A = "wamid.__verify_reply_branching_a__"; // reply-text match
    const WAMID_A2 = "wamid.__verify_reply_branching_a2__"; // reply-text non-match
    const WAMID_SCOPE = "wamid.__verify_reply_branching_scope__"; // scoping probe
    const WAMID_UNRELATED = "wamid.__verify_reply_branching_unrelated__"; // some OTHER node's send
    const WAMID_BTN = "wamid.__verify_reply_branching_btn__"; // button match
    const WAMID_WHOLE = "wamid.__verify_reply_branching_whole__"; // whole vs contains
    const WAMID_UNSENT = "wamid.__verify_reply_branching_unsent__"; // send happened, no reply yet

    const event = (overrides) =>
      MessageEvent.create({
        phone: PHONE,
        eventType: "message",
        status: "received",
        enrollment: ENROLLMENT_ID,
        payload: { fixture: FIXTURE_TAG },
        receivedAt: new Date(T0.getTime() + 5 * 60 * 1000),
        ...overrides,
      });

    // 1. reply-text: matches a configured phrase, keyed by reply-context id.
    await event({ inReplyToProviderMessageId: WAMID_A, text: "Yes, I am Interested!!" });
    // 2. reply-text: does not match any configured phrase.
    await event({ inReplyToProviderMessageId: WAMID_A2, text: "Not right now, thanks" });
    // 3. scoping probe: content WOULD match, but it answers a DIFFERENT send
    // (this phone's other conversation) — must not count for WAMID_SCOPE.
    await event({ inReplyToProviderMessageId: WAMID_UNRELATED, text: "Interested, yes" });
    // 4. button: a quick-reply tap, label only, no payload id — the one real
    // shape this repo's own fixture (verify-webhook.js) captures.
    await event({ inReplyToProviderMessageId: WAMID_BTN, interactiveType: "button", text: "Book a Call" });
    // 5. whole vs contains: same label as (4)'s shape, different node.
    await event({ inReplyToProviderMessageId: WAMID_WHOLE, interactiveType: "button", text: "Book a Call" });
    // 6. fallback scoping: no provider id was ever captured for this send, so
    // this event carries no inReplyToProviderMessageId at all — only
    // enrollment + timing ties it back, same as evaluateEngagement's fallback.
    await event({ receivedAt: new Date(T0.getTime() + 10 * 60 * 1000), text: "Sounds good, let's do it" });

    const countEvents = () => MessageEvent.countDocuments({ "payload.fixture": FIXTURE_TAG });
    const beforeCount = await countEvents();

    // --- reply-text: matching phrase takes "yes" ----------------------------
    {
      const enrollment = enrollmentAt(ENROLLMENT_ID, [sendHistory("n_msg_a", WAMID_A)]);
      const result = await walk(enrollment, { on: "reply-text", nodeId: "n_msg_a", values: ["interested"] });
      check("a reply matching a configured phrase takes the yes branch", result.exitOutcome === "yes_branch", `outcome ${result.exitOutcome}`);
    }

    // --- reply-text: non-matching phrase takes "no" -------------------------
    {
      const enrollment = enrollmentAt(ENROLLMENT_ID, [sendHistory("n_msg_a2", WAMID_A2)]);
      const result = await walk(enrollment, { on: "reply-text", nodeId: "n_msg_a2", values: ["interested"] });
      check("a non-matching reply takes the no branch", result.exitOutcome === "no_branch", `outcome ${result.exitOutcome}`);
    }

    // --- scoping: matches on content but answers a different send ----------
    {
      const enrollment = enrollmentAt(ENROLLMENT_ID, [sendHistory("n_msg_scope", WAMID_SCOPE)]);
      const result = await walk(enrollment, { on: "reply-text", nodeId: "n_msg_scope", values: ["interested"] });
      check(
        "matching is scoped to the named node's send, not any inbound message on the phone",
        result.exitOutcome === "no_branch",
        `outcome ${result.exitOutcome}`
      );
    }

    // --- button: a tap matching the configured label takes "yes" -----------
    {
      const enrollment = enrollmentAt(ENROLLMENT_ID, [sendHistory("n_msg_btn", WAMID_BTN)]);
      const result = await walk(enrollment, { on: "button", nodeId: "n_msg_btn", values: ["book a call"] });
      check("a button tap matching a configured label takes the yes branch", result.exitOutcome === "yes_branch", `outcome ${result.exitOutcome}`);
    }

    // --- button: nothing depends on a payload id being present --------------
    {
      const enrollment = enrollmentAt(ENROLLMENT_ID, [sendHistory("n_msg_btn", WAMID_BTN)]);
      const result = await walk(enrollment, {
        on: "button",
        nodeId: "n_msg_btn",
        values: ["totally-different-payload-id-nobody-set"],
      });
      // The label still matches text even though no interactivePayloadId was
      // ever captured on the fixture event, and no payload id was configured
      // to match either — proving the label path alone is sufficient when it
      // matches, and insufficient values correctly fall through to "no"
      // rather than being rescued by a payload id that was never there.
      check(
        "button matching does not depend on a payload id, and an unmatched label alone falls to no",
        result.exitOutcome === "no_branch",
        `outcome ${result.exitOutcome}`
      );
    }

    // --- contains vs whole matching ------------------------------------------
    {
      // Each walk() call gets its own fresh enrollment object: applyWalkResult
      // mutates currentNodeId onto whatever it's given, so reusing one across
      // calls would leave the second/third call resuming from the exit node
      // the first call already finished on, instead of re-evaluating "n_cond".
      const wholeHistory = [sendHistory("n_msg_whole", WAMID_WHOLE)];
      const substring = await walk(enrollmentAt(ENROLLMENT_ID, wholeHistory), {
        on: "button",
        nodeId: "n_msg_whole",
        values: ["call"],
        match: "contains",
      });
      check("substring mode matches a phrase embedded in the label", substring.exitOutcome === "yes_branch", `outcome ${substring.exitOutcome}`);

      const wholeMismatch = await walk(enrollmentAt(ENROLLMENT_ID, wholeHistory), {
        on: "button",
        nodeId: "n_msg_whole",
        values: ["call"],
        match: "whole",
      });
      check("whole mode rejects a value that is only a substring of the label", wholeMismatch.exitOutcome === "no_branch", `outcome ${wholeMismatch.exitOutcome}`);

      const wholeMatch = await walk(enrollmentAt(ENROLLMENT_ID, wholeHistory), {
        on: "button",
        nodeId: "n_msg_whole",
        values: ["Book a Call"],
        match: "whole",
      });
      check(
        "whole mode matches the full label, case- and whitespace-normalised",
        wholeMatch.exitOutcome === "yes_branch",
        `outcome ${wholeMatch.exitOutcome}`
      );
    }

    // --- fallback: no provider id was captured for the send -----------------
    {
      const enrollment = enrollmentAt(ENROLLMENT_ID, [sendHistory("n_msg_fallback", undefined)]);
      const result = await walk(enrollment, { on: "reply-text", nodeId: "n_msg_fallback", values: ["sounds good"] });
      check(
        "with no provider id captured, the evaluator falls back to time-based scoping like engagement does",
        result.exitOutcome === "yes_branch",
        `outcome ${result.exitOutcome}`
      );
    }

    // --- misconfiguration parks rather than silently choosing a branch ------
    {
      const enrollment = enrollmentAt(ENROLLMENT_ID, [sendHistory("n_msg_a", WAMID_A)]);
      const noNode = await walk(enrollment, { on: "reply-text", values: ["interested"] });
      check(
        "no upstream node named parks the enrollment with a descriptive reason",
        noNode.status === "paused" && /upstream message node/.test(noNode.reason || ""),
        `status ${noNode.status}, reason "${noNode.reason}"`
      );

      const noValues = await walk(enrollment, { on: "reply-text", nodeId: "n_msg_a" });
      check(
        "no values configured parks the enrollment with a descriptive reason",
        noValues.status === "paused" && /match against/.test(noValues.reason || ""),
        `status ${noValues.status}, reason "${noValues.reason}"`
      );

      const noButtonValues = await walk(enrollment, { on: "button", nodeId: "n_msg_a" });
      check(
        "the same is true for the button kind",
        noButtonValues.status === "paused" && /match against/.test(noButtonValues.reason || ""),
        `status ${noButtonValues.status}, reason "${noButtonValues.reason}"`
      );
    }

    // --- no reply yet evaluates as false rather than parking -----------------
    {
      const enrollment = enrollmentAt(ENROLLMENT_ID, [sendHistory("n_msg_unsent", WAMID_UNSENT)]);
      const result = await walk(enrollment, { on: "reply-text", nodeId: "n_msg_unsent", values: ["interested"] });
      check(
        "no reply yet to a send that did happen evaluates as false, not a park",
        result.status !== "paused" && result.exitOutcome === "no_branch",
        `status ${result.status}, outcome ${result.exitOutcome}`
      );

      const neverSent = enrollmentAt(ENROLLMENT_ID, []);
      const result2 = await walk(neverSent, { on: "button", nodeId: "n_msg_never_sent", values: ["book a call"] });
      check(
        "a node that hasn't sent at all also evaluates as false rather than parking",
        result2.status !== "paused" && result2.exitOutcome === "no_branch",
        `status ${result2.status}, outcome ${result2.exitOutcome}`
      );
    }

    // --- evaluators perform no writes ----------------------------------------
    {
      const afterCount = await countEvents();
      check("no MessageEvent documents were written by any of the above walks", afterCount === beforeCount, `before ${beforeCount}, after ${afterCount}`);
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
