const Contact = require("../models/Contact");
const Lead = require("../models/Lead");
const { getAdMagnetConnection } = require("../db");
const { getSourceFields, DYNAMIC_PREFIX } = require("./sourceFields");

// Resolves a source name to either a Mongoose model or a native driver
// collection, so callers (campaign filter/member endpoints, the generic
// data-source documents endpoint) can dispatch on `kind` instead of each
// re-deriving their own Contact/Lead/AdMagnetStudent/datasource:<id> branch.
// Model and collection share the same method names used here
// (.find/.aggregate/.countDocuments), so callers can treat both uniformly.
async function getSourceHandle(source) {
  if (source === "Contact") return { kind: "model", model: Contact };
  if (source === "Lead") return { kind: "model", model: Lead };
  if (source === "AdMagnetStudent") {
    const conn = getAdMagnetConnection();
    if (!conn) throw new Error("AD_MAGNET_MONGODB_URI not configured");
    return { kind: "collection", collection: conn.db.collection("users") };
  }
  if (source && source.startsWith(DYNAMIC_PREFIX)) {
    const id = source.slice(DYNAMIC_PREFIX.length);
    const DataSourceConnection = require("../models/DataSourceConnection");
    const { getConnectionFor } = require("./dataSourcePool");
    const doc = await DataSourceConnection.findById(id);
    if (!doc || !doc.active) throw new Error("Unknown or inactive data source");
    const conn = await getConnectionFor(doc);
    return { kind: "collection", collection: conn.db.collection(doc.collectionName) };
  }
  throw new Error(`Unknown source "${source}"`);
}

function isScalar(v) {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

// A filter value is safe to pass straight into MongoDB only if it's a plain
// scalar or an { $in: [...] } of scalars — anything else (raw $where,
// $expr, nested operators, etc.) is rejected so a query-string filter can't
// smuggle arbitrary Mongo operators through.
function isSafeValue(v) {
  if (isScalar(v)) return true;
  if (Array.isArray(v)) return false;
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    return keys.length === 1 && keys[0] === "$in" && Array.isArray(v.$in) && v.$in.every(isScalar);
  }
  return false;
}

// Only lets through filter keys that are whitelisted as filterable for the
// given source, and only lets through values shaped like plain equality or
// $in checks — so a query-string filter can't reach into arbitrary fields
// or inject arbitrary Mongo operators.
async function validateFilter(source, filter) {
  const fields = await getSourceFields(source);
  if (!fields) throw new Error(`Unknown source "${source}"`);
  const allowed = new Set(fields.map((f) => f.key));
  for (const [key, value] of Object.entries(filter || {})) {
    if (!allowed.has(key)) throw new Error(`Field "${key}" is not filterable for source "${source}"`);
    if (!isSafeValue(value)) throw new Error(`Unsupported filter value for field "${key}"`);
  }
  return filter || {};
}

module.exports = { getSourceHandle, validateFilter };
