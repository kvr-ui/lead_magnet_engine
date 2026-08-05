const Contact = require("../models/Contact");
const Lead = require("../models/Lead");

// Field names never surfaced to the UI regardless of source: mongoose
// internals, dynamic Map sub-paths, and the OTP secrets CA Guru's user
// documents carry.
const ALWAYS_EXCLUDED = new Set(["_id", "__v", "phoneOtp", "phoneOtpExpires"]);

const DYNAMIC_PREFIX = "datasource:";

// The built-in, code-level sources a campaign may target: the ones
// getSourceFields() answers for by name rather than by DataSourceConnection
// lookup. Exported so the API can *report* the selectable source list and the
// admin UI can render whatever it is told, instead of keeping its own literal
// copy of this pair — the copy that made a newly connected lead-magnet
// database unselectable until someone edited the frontend.
//
// Every other source is a DataSourceConnection the admin connected, listed
// alongside these by GET /api/campaigns/meta/sources.
const BUILT_IN_SOURCES = [
  { value: "Contact", label: "Zoho Contacts" },
  { value: "Lead", label: "Lead Magnet Leads" },
];

function humanize(key) {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function schemaFieldKeys(Model) {
  return Object.keys(Model.schema.paths).filter(
    (k) => !ALWAYS_EXCLUDED.has(k) && !k.startsWith("raw") && !k.startsWith("extra")
  );
}

// Discovers field names on a schemaless collection by sampling documents —
// every user-connected DataSourceConnection goes through this, since none of
// them has a schema here to read the field list off.
async function sampleFieldKeys(collection, { excluded = ALWAYS_EXCLUDED, sampleSize = 300 } = {}) {
  const [result] = await collection
    .aggregate([
      { $sample: { size: sampleSize } },
      { $project: { fields: { $map: { input: { $objectToArray: "$$ROOT" }, as: "f", in: "$$f.k" } } } },
      { $unwind: "$fields" },
      { $group: { _id: null, keys: { $addToSet: "$fields" } } },
    ])
    .toArray();

  return (result?.keys || []).filter((k) => !excluded.has(k)).sort();
}

// Cached briefly since this is called on every filter validation, not just
// when the picker loads.
const CACHE_TTL_MS = 60_000;

// One field-keys cache entry per connected data source.
const dynamicCache = new Map(); // id -> { keys, at }

async function dynamicSourceFieldKeys(dataSourceId) {
  const cached = dynamicCache.get(dataSourceId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.keys;

  const DataSourceConnection = require("../models/DataSourceConnection");
  const { getConnectionFor } = require("./dataSourcePool");

  const doc = await DataSourceConnection.findById(dataSourceId);
  if (!doc || !doc.active) return null;

  const conn = await getConnectionFor(doc);
  const sampled = await sampleFieldKeys(conn.db.collection(doc.collectionName));
  // Virtual fields from an optional join (e.g. CA Guru's mcqAttempted/
  // mcqCorrect) don't exist on the raw documents sampling above just read,
  // so they're never discovered that way — list them explicitly instead.
  const keys = doc.enrich ? [...new Set([...sampled, ...doc.enrich.sumFields])].sort() : sampled;
  dynamicCache.set(dataSourceId, { keys, at: Date.now() });

  // Best-effort refresh of the persisted cache — don't block the response on it.
  DataSourceConnection.updateOne(
    { _id: doc._id },
    { fieldsCache: keys, fieldsCachedAt: new Date() }
  ).catch(() => {});

  return keys;
}

// Returns [{ key, label }] for every real field on the given source, or null
// for an unknown source. Used both to populate field-picker dropdowns and as
// the whitelist for validating user-supplied filter keys before they reach a
// MongoDB query. `source` is either a built-in name ("Contact"/"Lead") or
// "datasource:<DataSourceConnection id>" for a user-connected external
// collection.
async function getSourceFields(source) {
  let keys;
  if (source === "Contact") keys = schemaFieldKeys(Contact);
  else if (source === "Lead") keys = schemaFieldKeys(Lead);
  else if (source && source.startsWith(DYNAMIC_PREFIX)) {
    keys = await dynamicSourceFieldKeys(source.slice(DYNAMIC_PREFIX.length));
    if (!keys) return null;
  } else return null;

  return keys.map((key) => ({ key, label: humanize(key) }));
}

// Same fields hidden from the field-picker are stripped from raw documents
// too — shared by the data-source documents endpoint and campaign member
// listing so an excluded field like phoneOtp never goes out over the wire
// just because a caller skipped the field-picker's whitelist. _id stays (the
// frontend tables key rows on it).
const DOCUMENT_PROJECTION = Object.fromEntries(
  [...ALWAYS_EXCLUDED].filter((key) => key !== "_id").map((key) => [key, 0])
);

module.exports = {
  getSourceFields,
  sampleFieldKeys,
  humanize,
  ALWAYS_EXCLUDED,
  BUILT_IN_SOURCES,
  DYNAMIC_PREFIX,
  DOCUMENT_PROJECTION,
};
