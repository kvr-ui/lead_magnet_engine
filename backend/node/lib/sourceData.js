const { getSourceFields } = require("./sourceFields");
const { resolveSource } = require("./sourceResolver");

// The raw handle onto a source — either a Mongoose model or a native driver
// collection — for callers (campaign filter/member endpoints, the generic
// data-source documents endpoint) that run their own aggregation and
// pagination against it and dispatch on `kind` rather than reading through
// the resolver's canonical find/mapDoc. Model and collection share the method
// names used there (.find/.aggregate/.countDocuments), so callers can treat
// both uniformly.
//
// A thin wrapper rather than its own switch: lib/sourceResolver.js owns the
// one Contact/Lead/AdMagnetStudent/datasource:<id> branch in the codebase.
async function getSourceHandle(source) {
  const resolved = await resolveSource(source);
  return resolved.kind === "model"
    ? { kind: "model", model: resolved.model }
    : { kind: "collection", collection: resolved.collection };
}

function isScalar(v) {
  return v === null || ["string", "number", "boolean"].includes(typeof v);
}

// Numeric comparisons the filter builder's "compare number" mode can emit
// (e.g. an enrichment sum field like totalAttempted < 1) — deliberately not
// $eq/$ne (plain equality already goes through the $in case) or anything
// that isn't a bounded numeric check.
const COMPARISON_OPS = new Set(["$lt", "$lte", "$gt", "$gte"]);

// A filter value is safe to pass straight into MongoDB only if it's a plain
// scalar, an { $in: [...] } of scalars, or a single numeric comparison —
// anything else (raw $where, $expr, nested operators, etc.) is rejected so a
// query-string filter can't smuggle arbitrary Mongo operators through.
function isSafeValue(v) {
  if (isScalar(v)) return true;
  if (Array.isArray(v)) return false;
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length !== 1) return false;
    const [key] = keys;
    if (key === "$in") return Array.isArray(v.$in) && v.$in.every(isScalar);
    if (COMPARISON_OPS.has(key)) return typeof v[key] === "number";
    return false;
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

// isSafeValue is exported alongside the validator because the graph walker
// evaluates the same filter shape in memory (a `filter` node, a "field"
// condition) and must agree with this file on exactly which shapes exist.
module.exports = { getSourceHandle, validateFilter, isSafeValue };
