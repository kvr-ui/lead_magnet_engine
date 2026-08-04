#!/usr/bin/env node
/**
 * Idempotent seed: CA Guru's lead-magnet database as an ordinary
 * DataSourceConnection, replacing the hardcoded "AdMagnetStudent" source.
 *
 * AdMagnetStudent was written before DataSourceConnection existed. It opened
 * its own connection from AD_MAGNET_MONGODB_URI, hardcoded the `users`
 * collection, and hand-rolled a $lookup/$addFields pipeline over
 * `mcqprogresses` to derive per-user MCQ totals. Every one of those is now a
 * declarative field on a DataSourceConnection, so the special case buys
 * nothing and costs a code change every time a new lead magnet appears.
 *
 * This script makes sure the equivalent connection row exists, and records its
 * id as the compatibility pointer that lib/sourceResolver.js resolves the
 * retired "AdMagnetStudent" source name through (see LEGACY_AD_MAGNET_SOURCE
 * there). It runs at startup — a migration an operator has to remember is a
 * migration that doesn't happen — and can also be run by hand:
 *
 *     node tools/seed-ca-guru-source.js
 *
 * Running it twice does nothing the second time.
 *
 * FIELD NAMING. The old pipeline summed `totalAttempted`/`totalCorrect` from
 * the joined documents into fields it named `mcqAttempted`/`mcqCorrect`. The
 * generic `enrich` (see lib/enrichedCollection.js) sums a joined field into a
 * virtual field of the SAME name, so the values now surface as
 * `totalAttempted`/`totalCorrect`. Same numbers, same join, the names the
 * generic mechanism gives them — deliberately not a bespoke rename, which
 * would be the hardcoding this task exists to delete reappearing as config.
 */
const DataSourceConnection = require("../models/DataSourceConnection");
const AppSetting = require("../models/AppSetting");
const { encrypt, decrypt } = require("../lib/crypto");

// The key lib/sourceResolver.js reads to resolve the retired source name.
// Stored in the database rather than derived from the environment, because the
// whole point of this task is that AD_MAGNET_MONGODB_URI stops being something
// the running app needs.
const COMPAT_SETTING_KEY = "adMagnetCompatDataSourceId";

const CA_GURU_LABEL = "CA Guru — users";
const CA_GURU_COLLECTION = "users";

// The declarative equivalent of routes/adMagnet.js's hardcoded
// $lookup + $addFields. `users123` — a legacy snapshot the old code also
// listed — is deliberately NOT carried over: only `users` was ever read by the
// campaign and messaging paths this preserves.
const CA_GURU_ENRICH = {
  collection: "mcqprogresses",
  localField: "userId",
  foreignField: "userId",
  sumFields: ["totalAttempted", "totalCorrect"],
};

function sameEnrich(enrich) {
  if (!enrich) return false;
  return (
    enrich.collection === CA_GURU_ENRICH.collection &&
    enrich.localField === CA_GURU_ENRICH.localField &&
    enrich.foreignField === CA_GURU_ENRICH.foreignField &&
    JSON.stringify([...(enrich.sumFields || [])].sort()) === JSON.stringify([...CA_GURU_ENRICH.sumFields].sort())
  );
}

/**
 * The existing CA Guru connection, if there is one, found by three
 * increasingly loose rules. More than one rule because this runs against
 * databases where the connection was already made by hand through the Data
 * Sources tab — the common case, and one where neither the pointer nor the
 * environment variable necessarily says so.
 */
async function findExisting() {
  // 1. A pointer written by a previous run, still pointing at a live row.
  const pointer = await AppSetting.findOne({ key: COMPAT_SETTING_KEY }).lean();
  if (pointer && pointer.value) {
    const byPointer = await DataSourceConnection.findById(String(pointer.value));
    if (byPointer) return byPointer;
  }

  const candidates = await DataSourceConnection.find({ collectionName: CA_GURU_COLLECTION });

  // 2. Same URI as the one this app used to open itself. Compared decrypted:
  //    the stored ciphertext uses a random IV, so equal URIs do not produce
  //    equal ciphertext and matching on the stored value would never hit.
  const uri = process.env.AD_MAGNET_MONGODB_URI;
  if (uri) {
    for (const doc of candidates) {
      let plain = null;
      try {
        plain = decrypt(doc.mongoUriEncrypted);
      } catch {
        // A row encrypted under a different key isn't ours to identify.
        continue;
      }
      if (plain === uri) return doc;
    }
  }

  // 3. A row that already reproduces exactly what this seed would create — the
  //    same collection joined the same way. That is this connection whatever
  //    the admin happened to label it.
  return candidates.find((doc) => sameEnrich(doc.enrich)) || null;
}

/**
 * Ensure the CA Guru DataSourceConnection exists and the compatibility pointer
 * names it. Returns what it did, so startup can say so once and say nothing on
 * every boot after that.
 */
async function ensureCaGuruDataSource() {
  const existing = await findExisting();

  if (existing) {
    let updated = false;
    // A connection made by hand may predate the enrich config, in which case
    // the MCQ totals the old pipeline produced would be missing. Fill it in;
    // never overwrite one that is already configured differently on purpose.
    if (!existing.enrich) {
      existing.enrich = CA_GURU_ENRICH;
      await existing.save();
      updated = true;
    }
    await AppSetting.findOneAndUpdate(
      { key: COMPAT_SETTING_KEY },
      { $set: { value: String(existing._id) } },
      { upsert: true }
    );
    return { action: updated ? "updated" : "unchanged", id: String(existing._id), label: existing.label };
  }

  const uri = process.env.AD_MAGNET_MONGODB_URI;
  if (!uri) {
    // Nothing to connect and nothing to point at. Not an error: an install
    // that never had CA Guru wired up is a perfectly ordinary install, and the
    // app must boot cleanly without AD_MAGNET_MONGODB_URI set at all.
    return { action: "skipped", reason: "no existing CA Guru connection and AD_MAGNET_MONGODB_URI is not set" };
  }

  const created = await DataSourceConnection.create({
    label: CA_GURU_LABEL,
    mongoUriEncrypted: encrypt(uri),
    collectionName: CA_GURU_COLLECTION,
    active: true,
    enrich: CA_GURU_ENRICH,
  });
  await AppSetting.findOneAndUpdate(
    { key: COMPAT_SETTING_KEY },
    { $set: { value: String(created._id) } },
    { upsert: true }
  );
  return { action: "created", id: String(created._id), label: created.label };
}

module.exports = { ensureCaGuruDataSource, COMPAT_SETTING_KEY, CA_GURU_ENRICH };

// Run directly: connect, seed, report, disconnect.
if (require.main === module) {
  const { connectDB, mongoose } = require("../db");
  (async () => {
    await connectDB();
    const result = await ensureCaGuruDataSource();
    console.log(`[seed-ca-guru-source] ${JSON.stringify(result)}`);
    await mongoose.disconnect();
  })().catch((err) => {
    console.error(`[seed-ca-guru-source] failed: ${err.message}`);
    process.exit(1);
  });
}
