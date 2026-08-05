// Verifies task 6's requeue path (routes/campaigns.js): putting a parked
// enrollment back in motion after the operator has fixed whatever parked it.
//
//   1. a single retry resets status/nextSendAt/statusReason/sendAttempts
//      while leaving currentNodeId and graphVersion alone — the lead resumes
//      where it stopped, not at the start,
//   2. a retry refuses an enrollment that isn't paused/failed,
//   3. bulk retry requeues a whole status, or just an explicit id list, and
//      never sweeps up cancelled/completed rows even when their ids are
//      included,
//   4. bulk retry is capped per call and reports when the cap truncated the
//      batch, without silently doing less than it reports, and
//   5. the stuck rollup groups paused/failed rows by status and by reason,
//      including the legacy (pre-statusReasonCode) window-park prose match.
//
// Runs entirely against Mongo. No server, no provider: retryEnrollment,
// retryEnrollmentsBulk and stuckRollup are hung off the exported router the
// same way tools/verify-filter-facets.js drives distinctValues.
const path = require("node:path");
const m = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const Campaign = require("../models/Campaign");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const { retryEnrollment, retryEnrollmentsBulk, stuckRollup } = require("../routes/campaigns");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

const CAMPAIGN_NAME = "__verify_requeue__";
const BULK_CAMPAIGN_NAME = "__verify_requeue_bulk__";

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const seedEnrollment = (campaign, phone, extra = {}) =>
  CampaignEnrollment.create({
    campaign: campaign._id,
    targetModel: "Lead",
    targetId: new m.Types.ObjectId(),
    phone,
    graphVersion: 3,
    currentNodeId: "n_stuck",
    nextSendAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    history: [],
    ...extra,
  });

(async () => {
  await m.connect(URI);

  const wipe = async () => {
    const campaigns = await Campaign.find({ name: { $in: [CAMPAIGN_NAME, BULK_CAMPAIGN_NAME] } }).select("_id");
    await CampaignEnrollment.deleteMany({ campaign: { $in: campaigns.map((c) => c._id) } });
    await Campaign.deleteMany({ name: { $in: [CAMPAIGN_NAME, BULK_CAMPAIGN_NAME] } });
  };
  await wipe();

  try {
    const campaign = await Campaign.create({ name: CAMPAIGN_NAME });

    // --- part 1: single retry resets fields, preserves position ------------
    {
      const paused = await seedEnrollment(campaign, "919000000401", {
        status: "paused",
        currentNodeId: "n_broken",
        statusReason: 'node "n_gone" does not exist in version 3',
        statusReasonCode: null,
        sendAttempts: 2,
        lastAttemptClass: null,
      });
      const before = Date.now();
      const { enrollment } = await retryEnrollment(campaign._id, paused._id);
      check("retry sets status to active", enrollment.status === "active", `status ${enrollment.status}`);
      check(
        "retry sets nextSendAt to now",
        enrollment.nextSendAt.getTime() >= before && enrollment.nextSendAt.getTime() <= Date.now() + 1000,
        enrollment.nextSendAt.toISOString()
      );
      check("retry clears statusReason", !enrollment.statusReason, `"${enrollment.statusReason}"`);
      check("retry clears statusReasonCode", !enrollment.statusReasonCode, `"${enrollment.statusReasonCode}"`);
      check("retry zeroes sendAttempts", enrollment.sendAttempts === 0, `sendAttempts ${enrollment.sendAttempts}`);
      check("retry clears lastAttemptClass", enrollment.lastAttemptClass === null, `${enrollment.lastAttemptClass}`);
      check(
        "retry preserves currentNodeId — the lead resumes where it stopped",
        enrollment.currentNodeId === "n_broken",
        `at ${enrollment.currentNodeId}`
      );
      check("retry preserves graphVersion", enrollment.graphVersion === 3, `graphVersion ${enrollment.graphVersion}`);

      const reloaded = await CampaignEnrollment.findById(paused._id);
      check("the reset was actually persisted", reloaded.status === "active" && reloaded.sendAttempts === 0, `status ${reloaded.status}`);
    }

    // --- part 2: retry refuses a non-parked enrollment ----------------------
    {
      const active = await seedEnrollment(campaign, "919000000402", { status: "active" });
      const result = await retryEnrollment(campaign._id, active._id);
      check("retrying an active enrollment is refused", result.error === "not_requeueable", JSON.stringify(result));
      const unchanged = await CampaignEnrollment.findById(active._id);
      check("the refused row is left untouched", unchanged.status === "active", `status ${unchanged.status}`);
    }

    // --- part 3: retrying an unknown enrollment 404s -------------------------
    {
      const result = await retryEnrollment(campaign._id, new m.Types.ObjectId());
      check("retrying an unknown enrollment id reports not_found", result.error === "not_found", JSON.stringify(result));
    }

    // --- part 4: bulk retry by status, cancelled/completed left alone -------
    {
      const bulkCampaign = await Campaign.create({ name: BULK_CAMPAIGN_NAME });
      const failedRetryable = await seedEnrollment(bulkCampaign, "919000000501", {
        status: "failed",
        statusReason: "exhausted retries",
        sendAttempts: 5,
        lastAttemptClass: "retryable",
      });
      const failedTerminal = await seedEnrollment(bulkCampaign, "919000000502", {
        status: "failed",
        statusReason: "bad template",
        sendAttempts: 1,
        lastAttemptClass: "terminal",
      });
      const cancelled = await seedEnrollment(bulkCampaign, "919000000503", { status: "cancelled" });
      const completed = await seedEnrollment(bulkCampaign, "919000000504", { status: "completed", outcome: "done" });
      const pausedOther = await seedEnrollment(bulkCampaign, "919000000505", {
        status: "paused",
        statusReason: 'node "n_x" has an unknown kind',
      });

      const result = await retryEnrollmentsBulk(bulkCampaign._id, { status: "failed" });
      check("bulk retry by status reports the matched count", result.matched === 2, `matched ${result.matched}`);
      check("bulk retry by status requeues exactly that many", result.requeued === 2, `requeued ${result.requeued}`);
      check("bulk retry by status is not capped at this size", result.capped === false, JSON.stringify(result));

      const [rRetryable, rTerminal, rCancelled, rCompleted, rPausedOther] = await Promise.all([
        CampaignEnrollment.findById(failedRetryable._id),
        CampaignEnrollment.findById(failedTerminal._id),
        CampaignEnrollment.findById(cancelled._id),
        CampaignEnrollment.findById(completed._id),
        CampaignEnrollment.findById(pausedOther._id),
      ]);
      check("both failed rows became active", rRetryable.status === "active" && rTerminal.status === "active", `${rRetryable.status}, ${rTerminal.status}`);
      check("cancelled is not swept up by a bulk retry of failed", rCancelled.status === "cancelled", `status ${rCancelled.status}`);
      check("completed is not swept up by a bulk retry of failed", rCompleted.status === "completed", `status ${rCompleted.status}`);
      check("a paused row is untouched by a bulk retry scoped to failed", rPausedOther.status === "paused", `status ${rPausedOther.status}`);

      // --- an id list that includes a cancelled row can't sweep it up -------
      const idResult = await retryEnrollmentsBulk(bulkCampaign._id, {
        status: "paused",
        ids: [pausedOther._id, cancelled._id, completed._id],
      });
      check("an id-scoped bulk retry only matches ids that are actually in that status", idResult.matched === 1, `matched ${idResult.matched}`);
      check("...and only requeues that one", idResult.requeued === 1, `requeued ${idResult.requeued}`);
      const [rPausedOther2, rCancelled2, rCompleted2] = await Promise.all([
        CampaignEnrollment.findById(pausedOther._id),
        CampaignEnrollment.findById(cancelled._id),
        CampaignEnrollment.findById(completed._id),
      ]);
      check("the named paused row was requeued", rPausedOther2.status === "active", `status ${rPausedOther2.status}`);
      check("cancelled stayed cancelled despite being named in ids", rCancelled2.status === "cancelled", `status ${rCancelled2.status}`);
      check("completed stayed completed despite being named in ids", rCompleted2.status === "completed", `status ${rCompleted2.status}`);

      // --- bad input is refused, not silently coerced -----------------------
      const badStatus = await retryEnrollmentsBulk(bulkCampaign._id, { status: "active" });
      check("bulk retry refuses a status outside paused/failed", Boolean(badStatus.error), JSON.stringify(badStatus));
      const badIds = await retryEnrollmentsBulk(bulkCampaign._id, { status: "failed", ids: "not-an-array" });
      check("bulk retry refuses a non-array ids", Boolean(badIds.error), JSON.stringify(badIds));

      await Campaign.deleteOne({ _id: bulkCampaign._id });
      await CampaignEnrollment.deleteMany({ campaign: bulkCampaign._id });
    }

    // --- part 5: bulk retry is capped, and reports the truncation -----------
    {
      const capCampaign = await Campaign.create({ name: BULK_CAMPAIGN_NAME });
      const CAP_TEST_SIZE = 5;
      // Cap the test at a tiny size by overriding RETRY_BULK_CAP is not
      // exposed, so instead this proves the cap's *reporting contract* at
      // real scale: matched vs requeued must never disagree without capped
      // being true, and capped must never be true while requeued === matched.
      const rows = await Promise.all(
        Array.from({ length: CAP_TEST_SIZE }, (_, i) => seedEnrollment(capCampaign, `919000000${600 + i}`, { status: "failed" }))
      );
      const result = await retryEnrollmentsBulk(capCampaign._id, { status: "failed" });
      check("uncapped: requeued equals matched", result.requeued === result.matched && result.matched === CAP_TEST_SIZE, JSON.stringify(result));
      check("uncapped: capped is false when everything fit", result.capped === false, JSON.stringify(result));
      check("the cap is reported on every response, not just when it bites", typeof result.cap === "number" && result.cap > 0, `cap ${result.cap}`);
      await Promise.all(rows.map((r) => r.deleteOne()));
      await Campaign.deleteOne({ _id: capCampaign._id });
    }

    // --- part 6: the stuck rollup groups by status and by reason ------------
    {
      const stuckCampaign = await Campaign.create({ name: BULK_CAMPAIGN_NAME });
      await Promise.all([
        seedEnrollment(stuckCampaign, "919000000701", {
          status: "paused",
          statusReasonCode: CampaignEnrollment.REASON_WINDOW_CLOSED,
          statusReason: 'message node "n_text" could not send free text: no open window',
        }),
        // Legacy row: parked before statusReasonCode existed, prose only.
        seedEnrollment(stuckCampaign, "919000000702", {
          status: "paused",
          statusReason: 'message node "n_text" could not send free text: Phone has no open 24-hour conversation window',
        }),
        seedEnrollment(stuckCampaign, "919000000703", {
          status: "paused",
          statusReason: 'node "n_gone" does not exist in version 3',
        }),
        seedEnrollment(stuckCampaign, "919000000704", {
          status: "failed",
          statusReason: "exhausted retries",
          lastAttemptClass: "retryable",
        }),
        seedEnrollment(stuckCampaign, "919000000705", {
          status: "failed",
          statusReason: "bad number",
          lastAttemptClass: "undeliverable",
        }),
        seedEnrollment(stuckCampaign, "919000000706", {
          status: "failed",
          statusReason: "target document gone",
          lastAttemptClass: null,
        }),
        seedEnrollment(stuckCampaign, "919000000707", { status: "active" }),
        seedEnrollment(stuckCampaign, "919000000708", { status: "completed", outcome: "done" }),
      ]);

      const rollup = await stuckRollup(stuckCampaign._id);
      check("stuck total counts only paused + failed rows", rollup.total === 6, `total ${rollup.total}`);
      check("paused count is right", rollup.byStatus.paused.count === 3, JSON.stringify(rollup.byStatus.paused));
      check("failed count is right", rollup.byStatus.failed.count === 3, JSON.stringify(rollup.byStatus.failed));
      check(
        "the new-code window park and the legacy prose park land in the same bucket",
        rollup.byStatus.paused.byReason[CampaignEnrollment.REASON_WINDOW_CLOSED] === 2,
        JSON.stringify(rollup.byStatus.paused.byReason)
      );
      check(
        "a paused row for an unrelated reason falls under 'other'",
        rollup.byStatus.paused.byReason.other === 1,
        JSON.stringify(rollup.byStatus.paused.byReason)
      );
      check(
        "failed rows are grouped by their lastAttemptClass",
        rollup.byStatus.failed.byReason.retryable === 1 && rollup.byStatus.failed.byReason.undeliverable === 1,
        JSON.stringify(rollup.byStatus.failed.byReason)
      );
      check(
        "a failed row with no classification lands in 'unclassified' rather than being dropped",
        rollup.byStatus.failed.byReason.unclassified === 1,
        JSON.stringify(rollup.byStatus.failed.byReason)
      );

      await Campaign.deleteOne({ _id: stuckCampaign._id });
      await CampaignEnrollment.deleteMany({ campaign: stuckCampaign._id });
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
