const Contact = require("../models/Contact");
const Lead = require("../models/Lead");
const { getAdMagnetConnection } = require("../db");
const { DYNAMIC_PREFIX } = require("./sourceFields");

/**
 * The one place that answers "what is this source, and how do I read it".
 *
 * A source is named by a single string — "Contact", "Lead", "AdMagnetStudent",
 * or "datasource:<DataSourceConnection id>" — and every part of the app that
 * has to read from one (the campaign engine's enroll/send loop, the segment
 * builder's member/value endpoints, the enrollment detail panel, activity
 * reporting) resolves it here instead of re-deriving its own branch. Before
 * this module the same switch existed twice, in lib/campaignEngine.js and
 * lib/sourceData.js, and the two had already drifted: one wrapped enrichment
 * and guessed a phone column, the other did neither.
 *
 * resolveSource(sourceId, map) returns:
 *
 *   { kind, model | collection, find(filter), findById(id), mapDoc(doc) }
 *
 * `kind` ("model" for the Mongoose-backed Contact/Lead, "collection" for the
 * native-driver AdMagnetStudent and user-connected data sources) and the
 * matching handle are the raw escape hatch for callers that run their own
 * aggregation or pagination against the source. find/findById/mapDoc are the
 * canonical read: they speak in canonical keys, not in whatever the source
 * happens to call its columns.
 *
 * `map` is that translation — a canonical field map, e.g.
 * { phone: "phoneNumber", name: "firstName", stage: "caStatus" }. Downstream
 * consumers (message templates, condition nodes, filters) read canonical keys
 * only, which is what lets one node serve differently-shaped sources without
 * per-node field wiring. Authoring the map lives elsewhere; this module only
 * threads it through and applies it.
 */

// Candidate field names (checked case-insensitively against the connection's
// discovered fields) for the phone number on a user-connected Data Source,
// used only when the source has no canonical `phone` mapping — guessed from
// common naming conventions. This is the single copy: it used to be duplicated
// verbatim in lib/campaignEngine.js and lib/leadActivity.js.
const PHONE_FIELD_CANDIDATES = ["phone", "phonenumber", "mobile", "mobilenumber", "contactnumber", "whatsappnumber"];

function guessPhoneField(fieldsCache) {
  const byLower = new Map((fieldsCache || []).map((k) => [k.toLowerCase(), k]));
  for (const candidate of PHONE_FIELD_CANDIDATES) {
    if (byLower.has(candidate)) return byLower.get(candidate);
  }
  return null;
}

/**
 * The phone column of a user-connected Data Source: what the canonical map
 * says, and only failing that the name guess. An explicit mapping always wins
 * — the guess exists for connections made before maps did, not to override one
 * that was configured deliberately.
 *
 * Exported because activity reporting needs the column name itself (to project
 * it out of the base collection) rather than a whole resolved source.
 */
function phoneFieldFor(connectionDoc, map) {
  return (map && map.phone) || guessPhoneField(connectionDoc && connectionDoc.fieldsCache);
}

// Canonical map for a source: the per-source defaults, overridden by whatever
// the caller declared explicitly. Falsy entries in `map` are ignored so an
// absent key never erases a working default.
function mergeMap(defaults, map) {
  const fields = { ...defaults };
  for (const [canonical, field] of Object.entries(map || {})) {
    if (field) fields[canonical] = field;
  }
  return fields;
}

/**
 * Builds the resolved-source handle around an already-opened model/collection.
 *
 * `fields` is canonical key -> real field name on this source's documents.
 * `phone` is the one canonical key everything downstream assumes exists (there
 * is nobody to message without it), so the three canonical readers refuse to
 * run when it couldn't be determined — raising the same error the campaign
 * engine used to raise while building its adapter. It is raised on use rather
 * than on resolve on purpose: callers that only want the raw handle (the
 * segment builder listing members, the documents browser) never needed a phone
 * column and must keep working on a source that has none.
 */
function buildSource({ kind, model, collection, fields, phoneError }) {
  function requireFields() {
    if (!fields.phone) throw new Error(phoneError);
    return fields;
  }

  // Canonical view of one raw document: always at least { _id, phone }, plus
  // every other canonical key the map declares. Deliberately not a copy of the
  // whole document — callers that want the whole record use findById.
  function mapDoc(doc) {
    if (!doc) return null;
    const canonical = requireFields();
    const out = { _id: doc._id, phone: undefined };
    for (const [key, field] of Object.entries(canonical)) out[key] = doc[field];
    return out;
  }

  // Every matching document, projected down to just the mapped fields —
  // enroll/preview scan whole sources, so pulling full documents would drag
  // back thousands of fields nobody reads.
  async function find(filter) {
    const canonical = requireFields();
    const names = [...new Set(Object.values(canonical))];
    if (kind === "model") {
      const docs = await model
        .find(filter || {})
        .select([...new Set(["_id", ...names])].join(" "))
        .lean();
      return docs.map(mapDoc);
    }
    const projection = Object.fromEntries(names.map((name) => [name, 1]));
    const docs = await collection
      .find(filter || {})
      .project(projection)
      .toArray();
    return docs.map(mapDoc);
  }

  // The whole document with the canonical keys merged on top — the detail
  // views render every field they get, so this one isn't projected.
  async function findById(id) {
    requireFields();
    const doc = kind === "model" ? await model.findById(id).lean() : await collection.findOne({ _id: id });
    return doc ? { ...doc, ...mapDoc(doc) } : null;
  }

  return kind === "model"
    ? { kind, model, find, findById, mapDoc }
    : { kind, collection, find, findById, mapDoc };
}

/**
 * Resolves a source name to a canonical, readable handle.
 *
 * Contact/Lead are our own Mongoose models. AdMagnetStudent is CA Guru's
 * `users` collection on the separate, read-only ad-magnet connection (it calls
 * the column `phoneNumber` and has no schema here). "datasource:<id>" is any
 * user-connected external collection, read over the pooled connection and —
 * when the connection has `enrich` configured — wrapped so the joined virtual
 * fields keep resolving through find/findById/mapDoc as well.
 */
async function resolveSource(sourceId, map) {
  if (sourceId === "Contact") {
    return buildSource({
      kind: "model",
      model: Contact,
      fields: mergeMap({ phone: "phone" }, map),
      phoneError: 'No phone field mapped for source "Contact"',
    });
  }

  if (sourceId === "Lead") {
    return buildSource({
      kind: "model",
      model: Lead,
      fields: mergeMap({ phone: "phone" }, map),
      phoneError: 'No phone field mapped for source "Lead"',
    });
  }

  if (sourceId === "AdMagnetStudent") {
    const conn = getAdMagnetConnection();
    if (!conn) throw new Error("AD_MAGNET_MONGODB_URI not configured — AdMagnetStudent target unavailable");
    return buildSource({
      kind: "collection",
      collection: conn.db.collection("users"),
      fields: mergeMap({ phone: "phoneNumber" }, map),
      phoneError: 'No phone field mapped for source "AdMagnetStudent"',
    });
  }

  if (sourceId && sourceId.startsWith(DYNAMIC_PREFIX)) {
    // Required lazily, exactly as both previous implementations did: the
    // connection model and pool pull in encryption and extra mongoose plumbing
    // that has no business loading for the three built-in sources.
    const DataSourceConnection = require("../models/DataSourceConnection");
    const { getConnectionFor } = require("./dataSourcePool");
    const { wrapWithEnrichment } = require("./enrichedCollection");

    const doc = await DataSourceConnection.findById(sourceId.slice(DYNAMIC_PREFIX.length));
    if (!doc || !doc.active) throw new Error("Unknown or inactive data source");

    // Pooled — one connection per data source for the process's lifetime,
    // never one per read.
    const conn = await getConnectionFor(doc);
    const raw = conn.db.collection(doc.collectionName);
    const collection = doc.enrich ? wrapWithEnrichment(raw, doc.enrich) : raw;

    const phoneField = phoneFieldFor(doc, map);
    return buildSource({
      kind: "collection",
      collection,
      fields: mergeMap(phoneField ? { phone: phoneField } : {}, map),
      phoneError: `Couldn't find a phone field on data source "${doc.label}"`,
    });
  }

  throw new Error(`Unknown source "${sourceId}"`);
}

module.exports = { resolveSource, phoneFieldFor, PHONE_FIELD_CANDIDATES };
