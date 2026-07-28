const express = require("express");
const DataSourceConnection = require("../models/DataSourceConnection");
const { encrypt } = require("../lib/crypto");
const { testConnection, evict, getConnectionFor, listDatabases, listCollections } = require("../lib/dataSourcePool");
const { getSourceFields, sampleFieldKeys, DYNAMIC_PREFIX, DOCUMENT_PROJECTION } = require("../lib/sourceFields");
const { validateFilter } = require("../lib/sourceData");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

const DOCS_PAGE_LIMIT = 200;

// Whitelisted response shape — mongoUriEncrypted (and any decrypted URI)
// must never leave this route.
function sanitize(doc) {
  return {
    _id: doc._id,
    label: doc.label,
    databaseName: doc.databaseName,
    collectionName: doc.collectionName,
    active: doc.active,
    status: doc.status,
    lastError: doc.lastError,
    fieldsCache: doc.fieldsCache,
    fieldsCachedAt: doc.fieldsCachedAt,
    lastTestedAt: doc.lastTestedAt,
    enrich: doc.enrich,
    activity: doc.activity,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function maskUri(uri) {
  return String(uri).replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:****@");
}

async function refreshFieldsCache(doc) {
  const conn = await getConnectionFor(doc);
  const sampled = await sampleFieldKeys(conn.db.collection(doc.collectionName));
  doc.fieldsCache = doc.enrich ? [...new Set([...sampled, ...doc.enrich.sumFields])].sort() : sampled;
  doc.fieldsCachedAt = new Date();
  await doc.save();
  return doc.fieldsCache;
}

// POST /api/data-sources/discover-databases — given just a Mongo URI (no
// database picked yet), list the real databases on that cluster so the
// connect form can offer a dropdown. Requires the connection's user to have
// listDatabases privileges — scoped Atlas users may not, so callers should
// treat failure as "fall back to typing the database name" rather than fatal.
// Body: { mongoUri }
router.post("/data-sources/discover-databases", async (req, res) => {
  const { mongoUri } = req.body || {};
  if (!mongoUri) return res.status(400).json({ error: "mongoUri is required" });
  try {
    const databases = await listDatabases({ mongoUri });
    res.json({ databases });
  } catch (err) {
    res.status(400).json({ error: "Connection failed", detail: err.message });
  }
});

// Sentinel collectionName meaning "connect every collection in the database"
// instead of just one — each becomes its own DataSourceConnection.
const ALL_COLLECTIONS = "*";

// Connects each named collection as its own DataSourceConnection, labeled
// "<label> — <collection>". Used both for the "*" (all collections) sentinel
// and for an explicit array of hand-picked collection names.
async function connectManyCollections({ label, mongoUri, databaseName, names }) {
  const results = [];
  const failures = [];
  for (const name of names) {
    try {
      results.push(await connectOneCollection({ label: `${label} — ${name}`, mongoUri, databaseName, collectionName: name }));
    } catch (err) {
      failures.push({ collectionName: name, error: err.message });
    }
  }
  return { results, failures };
}

async function connectOneCollection({ label, mongoUri, databaseName, collectionName }) {
  await testConnection({ mongoUri, databaseName, collectionName });
  const doc = await DataSourceConnection.create({
    label,
    mongoUriEncrypted: encrypt(mongoUri),
    databaseName,
    collectionName,
    status: "connected",
    lastTestedAt: new Date(),
  });
  let fieldsCache = [];
  try {
    fieldsCache = await refreshFieldsCache(doc);
  } catch (err) {
    // Connection tested fine above but sampling failed (e.g. empty
    // collection) — keep the connection, just leave fields empty for now.
    console.warn(`DataSourceConnection ${doc._id} field sampling failed:`, err.message);
  }
  return { ...sanitize(doc), fieldsCache };
}

// POST /api/data-sources — connect a new external Mongo collection.
// Body: { label, mongoUri, databaseName?, collectionName? }
// collectionName is optional: if omitted, the database's collections are
// discovered and used automatically when there's exactly one. If there's
// more than one, the request is rejected with 409 + the discovered list so
// the UI can ask the admin to pick — we never guess which one is "the" data.
// Pass collectionName: "*" to connect every discovered collection at once, or
// an array of names to connect just that subset — either way each collection
// becomes its own DataSourceConnection (labeled "<label> — <collection>").
// Tests each connection before ever persisting its URI.
router.post("/data-sources", async (req, res) => {
  const { label, mongoUri, databaseName } = req.body || {};
  let { collectionName } = req.body || {};
  if (!label || !mongoUri) {
    return res.status(400).json({ error: "label and mongoUri are required" });
  }

  if (Array.isArray(collectionName)) {
    const names = [...new Set(collectionName.filter(Boolean))];
    if (!names.length) {
      return res.status(400).json({ error: "At least one collection must be selected" });
    }
    const { results, failures } = await connectManyCollections({ label, mongoUri, databaseName, names });
    if (!results.length) {
      return res.status(400).json({ error: "Failed to connect any collection", failures });
    }
    return res.status(201).json({ connections: results, failures, maskedUri: maskUri(mongoUri) });
  }

  if (!collectionName) {
    let discovered;
    try {
      discovered = await listCollections({ mongoUri, databaseName });
    } catch (err) {
      return res.status(400).json({ error: "Connection failed", detail: err.message });
    }
    if (discovered.length === 0) {
      return res.status(400).json({ error: "No collections found in that database" });
    }
    if (discovered.length > 1) {
      return res.status(409).json({
        error: "Multiple collections found in that database — pick one",
        collections: discovered,
      });
    }
    collectionName = discovered[0];
  }

  if (collectionName === ALL_COLLECTIONS) {
    let discovered;
    try {
      discovered = await listCollections({ mongoUri, databaseName });
    } catch (err) {
      return res.status(400).json({ error: "Connection failed", detail: err.message });
    }
    if (discovered.length === 0) {
      return res.status(400).json({ error: "No collections found in that database" });
    }

    const { results, failures } = await connectManyCollections({ label, mongoUri, databaseName, names: discovered });
    if (!results.length) {
      return res.status(400).json({ error: "Failed to connect any collection", failures });
    }
    return res.status(201).json({ connections: results, failures, maskedUri: maskUri(mongoUri) });
  }

  try {
    const result = await connectOneCollection({ label, mongoUri, databaseName, collectionName });
    res.status(201).json({ ...result, maskedUri: maskUri(mongoUri) });
  } catch (err) {
    res.status(400).json({ error: "Connection test failed", detail: err.message });
  }
});

// GET /api/data-sources — list all connections (sanitized).
router.get("/data-sources", async (_req, res) => {
  const docs = await DataSourceConnection.find().sort({ createdAt: -1 });
  res.json(docs.map(sanitize));
});

// GET /api/data-sources/:id — single connection detail (sanitized).
router.get("/data-sources/:id", async (req, res) => {
  const doc = await DataSourceConnection.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Data source not found" });
  res.json(sanitize(doc));
});

// PATCH /api/data-sources/:id — edit label/collectionName/mongoUri/active/enrich.
// Body: { label?, mongoUri?, databaseName?, collectionName?, active?, enrich? }
// enrich: { collection, localField, foreignField, sumFields: [...] } to set/replace
// the join, or null to remove it. Re-tests and re-encrypts when credentials or the
// target collection change; either that or an enrich change refreshes fieldsCache.
router.patch("/data-sources/:id", async (req, res) => {
  const doc = await DataSourceConnection.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Data source not found" });

  const { label, mongoUri, databaseName, collectionName, active, enrich, activity } = req.body || {};
  const credentialsChanged =
    mongoUri !== undefined ||
    (databaseName !== undefined && databaseName !== doc.databaseName) ||
    (collectionName !== undefined && collectionName !== doc.collectionName);

  if (credentialsChanged) {
    const { decrypt } = require("../lib/crypto");
    const testUri = mongoUri !== undefined ? mongoUri : decrypt(doc.mongoUriEncrypted);
    const testDb = databaseName !== undefined ? databaseName : doc.databaseName;
    const testCollection = collectionName !== undefined ? collectionName : doc.collectionName;
    try {
      await testConnection({ mongoUri: testUri, databaseName: testDb, collectionName: testCollection });
    } catch (err) {
      return res.status(400).json({ error: "Connection test failed", detail: err.message });
    }
    if (mongoUri !== undefined) doc.mongoUriEncrypted = encrypt(mongoUri);
    if (databaseName !== undefined) doc.databaseName = databaseName;
    if (collectionName !== undefined) doc.collectionName = collectionName;
    doc.status = "connected";
    doc.lastError = undefined;
    doc.lastTestedAt = new Date();
    await evict(doc._id);
  }

  if (label !== undefined) doc.label = label;
  if (active !== undefined) doc.active = active;

  let enrichChanged = false;
  if (enrich !== undefined) {
    if (enrich === null) {
      doc.enrich = undefined;
    } else {
      const { collection, localField, foreignField, sumFields } = enrich;
      if (!collection || !localField || !foreignField || !Array.isArray(sumFields) || !sumFields.length) {
        return res.status(400).json({
          error: "enrich requires collection, localField, foreignField, and at least one sumField",
        });
      }
      doc.enrich = { collection, localField, foreignField, sumFields };
    }
    enrichChanged = true;
  }

  // The activity link is what makes campaign impact measurable — a sibling
  // collection with one timestamped row per thing a lead did. Unlike enrich
  // it adds no filterable fields, so it deliberately doesn't touch
  // fieldsCache; it's read per-query by lib/leadActivity.js instead.
  if (activity !== undefined) {
    if (activity === null) {
      doc.activity = undefined;
    } else {
      const {
        collection,
        localField,
        foreignField,
        timestampField,
        correctField,
        labelFields,
        noun,
        answerField,
        correctAnswerField,
        questions,
      } = activity;
      if (!collection || !localField || !foreignField || !timestampField) {
        return res.status(400).json({
          error: "activity requires collection, localField, foreignField and timestampField",
        });
      }
      // The question link is optional, but a half-specified one would show
      // blank questions rather than fail visibly — so reject it outright.
      if (questions) {
        const { collection: qc, activityKeyField, keyField, textField } = questions;
        if (!qc || !activityKeyField || !keyField || !textField) {
          return res.status(400).json({
            error: "activity.questions requires collection, activityKeyField, keyField and textField",
          });
        }
      }
      doc.activity = {
        collection,
        localField,
        foreignField,
        timestampField,
        correctField: correctField || undefined,
        labelFields: Array.isArray(labelFields) ? labelFields : [],
        noun: noun || "activity",
        answerField: answerField || undefined,
        correctAnswerField: correctAnswerField || undefined,
        questions: questions || undefined,
      };
    }
  }

  try {
    await doc.save();
    if (credentialsChanged || enrichChanged) {
      try {
        await refreshFieldsCache(doc);
      } catch (err) {
        console.warn(`DataSourceConnection ${doc._id} field sampling failed:`, err.message);
      }
    }
    res.json(sanitize(doc));
  } catch (err) {
    res.status(400).json({ error: "Failed to update data source", detail: err.message });
  }
});

// GET /api/data-sources/:id/related-collections — other collection names in
// the same database as this data source, for the "enrich with a related
// collection" picker (e.g. CA Guru's `users` -> `mcqprogresses`).
router.get("/data-sources/:id/related-collections", async (req, res) => {
  const doc = await DataSourceConnection.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Data source not found" });
  try {
    const conn = await getConnectionFor(doc);
    const collections = await conn.db.listCollections().toArray();
    res.json({
      collections: collections
        .map((c) => c.name)
        .filter((name) => name !== doc.collectionName && !name.startsWith("system."))
        .sort(),
    });
  } catch (err) {
    res.status(400).json({ error: "Failed to list collections", detail: err.message });
  }
});

// GET /api/data-sources/:id/related-collections/:name/fields — sampled field
// names on another collection in the same database, so the enrich picker can
// offer real field names for the join key and the fields to sum.
router.get("/data-sources/:id/related-collections/:name/fields", async (req, res) => {
  const doc = await DataSourceConnection.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Data source not found" });
  try {
    const conn = await getConnectionFor(doc);
    const fields = await sampleFieldKeys(conn.db.collection(req.params.name));
    res.json({ fields });
  } catch (err) {
    res.status(400).json({ error: "Failed to sample collection fields", detail: err.message });
  }
});

// POST /api/data-sources/:id/test — re-verify an existing connection on demand.
router.post("/data-sources/:id/test", async (req, res) => {
  const doc = await DataSourceConnection.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Data source not found" });

  const { decrypt } = require("../lib/crypto");
  try {
    const result = await testConnection({
      mongoUri: decrypt(doc.mongoUriEncrypted),
      databaseName: doc.databaseName,
      collectionName: doc.collectionName,
    });
    doc.status = "connected";
    doc.lastError = undefined;
    doc.lastTestedAt = new Date();
    await doc.save();
    res.json({ ok: true, documentCount: result.documentCount, ...sanitize(doc) });
  } catch (err) {
    doc.status = "error";
    doc.lastError = err.message;
    doc.lastTestedAt = new Date();
    await doc.save();
    res.status(400).json({ error: "Connection test failed", detail: err.message, ...sanitize(doc) });
  }
});

// GET /api/data-sources/:id/fields — auto-discovered field list.
router.get("/data-sources/:id/fields", async (req, res) => {
  const fields = await getSourceFields(`${DYNAMIC_PREFIX}${req.params.id}`);
  if (!fields) return res.status(404).json({ error: "Data source not found or inactive" });
  res.json({ fields });
});

// GET  /api/data-sources/:id/documents?page=&limit=&filter=<json>
// POST /api/data-sources/:id/documents  { page, limit, filter }
//
// Both do the same read. The POST form exists because a filter is unbounded
// in size — selecting a few hundred values in the filter builder produces an
// $in list that pushed the query string past Node's 16KB header limit, and
// the request came back 431 Request Header Fields Too Large before any
// handler ran. In the body there's no such ceiling. GET stays for small
// filters and hand-made requests.
async function listDocuments(req, res) {
  const source = `${DYNAMIC_PREFIX}${req.params.id}`;
  const body = req.body || {};
  const rawFilter = body.filter !== undefined ? body.filter : req.query.filter;
  try {
    const parsed = typeof rawFilter === "string" ? JSON.parse(rawFilter || "{}") : rawFilter || {};
    const filter = await validateFilter(source, parsed);
    const page = Math.max(1, parseInt(body.page ?? req.query.page, 10) || 1);
    const limit = Math.min(parseInt(body.limit ?? req.query.limit, 10) || 50, DOCS_PAGE_LIMIT);
    const skip = (page - 1) * limit;

    const { getSourceHandle } = require("../lib/sourceData");
    const handle = await getSourceHandle(source);
    const [documents, total] = await Promise.all([
      handle.collection.find(filter).project(DOCUMENT_PROJECTION).skip(skip).limit(limit).toArray(),
      handle.collection.countDocuments(filter),
    ]);
    res.json({ documents, total, page, pageSize: limit, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

router.get("/data-sources/:id/documents", listDocuments);
router.post("/data-sources/:id/documents", listDocuments);

// DELETE /api/data-sources/:id
router.delete("/data-sources/:id", async (req, res) => {
  const doc = await DataSourceConnection.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Data source not found" });
  await evict(doc._id);
  await doc.deleteOne();
  res.json({ deleted: true });
});

module.exports = router;
