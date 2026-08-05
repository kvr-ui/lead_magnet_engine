// Checks that the filter builder's value counts are taken within the segment
// being built, not across the whole source.
//
// The bug this exists to keep fixed: selecting "CA Intermediate (1179)" and
// then opening the attempt field showed Sep/Jan/Sec counts adding up to 1889 —
// more leads than the condition above them admits, and read by an admin as a
// send volume that would never happen.
//
// Runs entirely against Mongo. No server, no provider, and nothing outbound:
// the only thing driven is distinctValues() from routes/campaigns.js, hung off
// the exported router for exactly this purpose.
const path = require("node:path");
const m = require("mongoose");

require("dotenv").config({ path: path.resolve(__dirname, "..", ".env"), quiet: true });

const Contact = require("../models/Contact");
const { distinctValues } = require("../routes/campaigns");

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/wati_cleanup";

// Marks every row this script writes, and is the only thing the cleanup deletes
// on — a `source` value no real Bigin sync would ever set.
const MARK = "__verify_filter_facets__";

// Deliberately unreal field values, so every count asserted below is entirely
// this script's and never has to be stated as a delta against whatever real
// contacts share the collection.
const INT = "__vff_intermediate__";
const FOUND = "__vff_foundation__";
const SEP = "__vff_sep__";
const JAN = "__vff_jan__";

// The same cross-tab shape as the real one: 5 "Intermediate" (3 Sep + 2 Jan)
// and 4 "Foundation" (all Sep). Chosen so a count taken across the whole source
// (7 Sep) is impossible to confuse with one taken within Intermediate (3 Sep).
const SEED = [
  ...Array.from({ length: 3 }, (_, i) => ({ caStatus: INT, attempt: SEP, phone: `91990000${i}` })),
  ...Array.from({ length: 2 }, (_, i) => ({ caStatus: INT, attempt: JAN, phone: `91990010${i}` })),
  ...Array.from({ length: 4 }, (_, i) => ({ caStatus: FOUND, attempt: SEP, phone: `91990020${i}` })),
];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// distinctValues returns [{ value, count }] sorted by count; a Map is what the
// assertions below actually want to ask questions of.
const countsBy = (rows) => new Map(rows.map((r) => [r.value, r.count]));
const of = (map, value) => map.get(value) || 0;

(async () => {
  await m.connect(URI);

  const wipe = () => Contact.deleteMany({ source: MARK });
  await wipe();

  try {
    await Contact.insertMany(SEED.map((row) => ({ ...row, source: MARK })));

    // --- unnarrowed: the old behaviour, unchanged -------------------------
    const all = countsBy(await distinctValues("Contact", "attempt"));
    check(
      "with no filter, both CA levels are counted together",
      of(all, SEP) === 7 && of(all, JAN) === 2,
      `${of(all, SEP)} Sep, ${of(all, JAN)} Jan`
    );

    // --- narrowed: the fix ------------------------------------------------
    const inInt = countsBy(await distinctValues("Contact", "attempt", { caStatus: { $in: [INT] } }));
    check(
      "narrowing by CA level counts only that level's rows",
      of(inInt, SEP) === 3 && of(inInt, JAN) === 2,
      `${of(inInt, SEP)} Sep, ${of(inInt, JAN)} Jan — was ${of(all, SEP)}/${of(all, JAN)}`
    );

    // The assertion the bug report is really about: the parts have to add up to
    // the whole they are being counted inside, instead of overshooting it.
    const levels = countsBy(await distinctValues("Contact", "caStatus"));
    check(
      "the narrowed counts sum to the parent condition's own count",
      of(inInt, SEP) + of(inInt, JAN) === of(levels, INT),
      `attempts sum to ${of(inInt, SEP) + of(inInt, JAN)}, the level itself has ${of(levels, INT)}`
    );

    // --- a value that narrows to nothing ----------------------------------
    const inFound = countsBy(await distinctValues("Contact", "attempt", { caStatus: { $in: [FOUND] } }));
    check(
      "a value with no rows in the narrowed set is absent, not returned at zero",
      of(inFound, SEP) === 4 && !inFound.has(JAN),
      `Jan-2027 ${inFound.has(JAN) ? `present at ${of(inFound, JAN)}` : "absent"}`
    );

    // --- narrowing is symmetric ------------------------------------------
    const janLevels = countsBy(await distinctValues("Contact", "caStatus", { attempt: { $in: [JAN] } }));
    check(
      "narrowing works in the other direction too",
      of(janLevels, INT) === 2 && !janLevels.has(FOUND),
      `Intermediate ${of(janLevels, INT)}, Foundation ${janLevels.has(FOUND) ? of(janLevels, FOUND) : "absent"}`
    );

    // --- an empty filter is exactly the old call --------------------------
    const empty = countsBy(await distinctValues("Contact", "attempt", {}));
    check("an empty filter counts the whole source, as it always did", of(empty, SEP) === of(all, SEP), `${of(empty, SEP)}`);

    // --- safety: the filter is validated, not trusted ---------------------
    const refuses = async (label, filter, field = "attempt") => {
      let err = null;
      try {
        await distinctValues("Contact", field, filter);
      } catch (e) {
        err = e;
      }
      check(label, Boolean(err), err && err.message);
    };

    await refuses("a filter naming a field this source doesn't have is rejected", { notAFieldOnThisSource: "x" });
    await refuses("an unsafe operator never reaches the aggregation", { caStatus: { $where: "1" } });
    await refuses("the field whitelist still applies to the counted field", {}, "notAFieldOnThisSource");
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
