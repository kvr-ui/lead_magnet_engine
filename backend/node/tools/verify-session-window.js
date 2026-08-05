// Checks the 24-hour WhatsApp session window lookup (lib/sessionWindow.js) and
// the members-table annotation that surfaces it.
//
// Runs entirely against Mongo — no server and no provider needed, since the
// window is derived from the inbound message log rather than fetched from
// anywhere. Seeds MessageEvent rows at controlled instants and asserts what the
// lookup says about each number.
const m = require("mongoose");

const URI = "mongodb://127.0.0.1:27017/wati_cleanup";

// Three numbers covering the three states an admin sees in the column.
const OPEN = "919000000101"; // messaged us 3 hours ago      -> open
const STALE = "919000000102"; // messaged us 30 hours ago     -> closed
const NEVER = "919000000103"; // has never messaged us at all -> never messaged

// A number written the way a source database might really hold it, to prove the
// lookup cleans its input rather than demanding pre-normalized values.
const MESSY_RAW = "+91 90000 00104";
const MESSY_CLEAN = "919000000104";

const HOUR = 60 * 60 * 1000;

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

(async () => {
  await m.connect(URI);
  const events = m.connection.db.collection("messageevents");

  const ALL = [OPEN, STALE, NEVER, MESSY_CLEAN];
  const wipe = () => events.deleteMany({ phone: { $in: ALL }, eventType: "__verify_window__" });
  await wipe();

  const now = new Date();
  const at = (msAgo) => new Date(now.getTime() - msAgo);

  const seed = (phone, status, receivedAt, extra = {}) =>
    events.insertOne({
      phone,
      eventType: "__verify_window__",
      status,
      receivedAt,
      createdAt: receivedAt,
      updatedAt: receivedAt,
      ...extra,
    });

  await seed(OPEN, "received", at(3 * HOUR));
  // An older inbound for the same number: the newest must win, not the first found.
  await seed(OPEN, "received", at(40 * HOUR));
  await seed(STALE, "received", at(30 * HOUR));
  await seed(MESSY_CLEAN, "received", at(1 * HOUR));
  // Outbound receipts must NOT open a window — only messages FROM the customer do.
  await seed(NEVER, "delivered", at(1 * HOUR), { providerMessageId: "wamid.__verify_window__.1" });
  await seed(NEVER, "read", at(1 * HOUR), { providerMessageId: "wamid.__verify_window__.2" });

  const { lastInboundAt, lastInboundFor, isWindowOpen, openWindowPhones, describeWindow } = require("../lib/sessionWindow");

  // --- single lookup ---------------------------------------------------
  check("a reply 3 hours ago leaves the window open", await isWindowOpen(OPEN, now), "");
  check("a reply 30 hours ago leaves the window closed", (await isWindowOpen(STALE, now)) === false, "");
  check("a number that never messaged us is closed", (await isWindowOpen(NEVER, now)) === false, "");
  check(
    "delivery and read receipts do not open a window",
    (await lastInboundAt(NEVER)) === null,
    "only inbound 'received' events count"
  );

  const newest = await lastInboundAt(OPEN);
  check(
    "the newest inbound wins over an older one",
    newest && Math.abs(newest.getTime() - at(3 * HOUR).getTime()) < 1000,
    `got ${newest && newest.toISOString()}`
  );

  // --- input cleaning --------------------------------------------------
  check(
    "a messy source-formatted number resolves",
    await isWindowOpen(MESSY_RAW, now),
    `${MESSY_RAW} -> ${MESSY_CLEAN}`
  );

  // --- bulk lookup (what the members table uses) ------------------------
  const bulk = await lastInboundFor([OPEN, STALE, NEVER, MESSY_RAW, "", null, "not-a-number"]);
  check("bulk lookup returns only numbers that have inbound history", bulk.size === 3, `size ${bulk.size}`);
  check("bulk lookup keys on the cleaned number", bulk.has(MESSY_CLEAN), "");
  check("bulk lookup omits a number with no inbound", !bulk.has(NEVER), "");
  check("bulk lookup of nothing does not query", (await lastInboundFor([])).size === 0, "");

  // --- describeWindow --------------------------------------------------
  const openInfo = describeWindow(bulk.get(OPEN), now);
  check("open window reports time remaining", openInfo.open && openInfo.msRemaining > 20 * HOUR, `${Math.round(openInfo.msRemaining / HOUR)}h`);
  check("open window reports when it expires", openInfo.expiresAt instanceof Date, "");
  const staleInfo = describeWindow(bulk.get(STALE), now);
  check("closed window reports no time remaining", !staleInfo.open && staleInfo.msRemaining === 0, "");
  check("closed window still records that they once messaged", staleInfo.everMessaged, "");
  const neverInfo = describeWindow(null, now);
  check(
    "never-messaged is distinguishable from closed",
    !neverInfo.open && neverInfo.everMessaged === false,
    "the column shows these differently"
  );

  // --- the open set ----------------------------------------------------
  const openSet = await openWindowPhones(now);
  check("the open set contains the recently-active numbers", openSet.includes(OPEN) && openSet.includes(MESSY_CLEAN), "");
  check("the open set excludes the stale number", !openSet.includes(STALE), "");
  check("the open set excludes the never-messaged number", !openSet.includes(NEVER), "");

  // --- boundary --------------------------------------------------------
  check(
    "exactly 24 hours old is closed, not open",
    describeWindow(at(24 * HOUR), now).open === false,
    "the window is strictly under 24h"
  );
  check("23h59m old is still open", describeWindow(at(24 * HOUR - 60000), now).open === true, "");

  await wipe();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await m.disconnect();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
