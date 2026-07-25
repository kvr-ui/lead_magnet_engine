const express = require("express");
const DataSourceConnection = require("../models/DataSourceConnection");
const { encrypt } = require("../lib/crypto");
const { testConnection, evict, getConnectionFor, listDatabases, listCollections } = require("../lib/dataSourcePool");
const { getSourceFields, sampleFieldKeys, ALWAYS_EXCLUDED, DYNAMIC_PREFIX } = require("../lib/sourceFields");

// Same fields hidden from the field-picker are stripped from the raw
// documents too — otherwise something like phoneOtp just isn't offered as a
// column, but still goes out over the wire in the JSON response. _id stays
// (the frontend table keys rows on it).
const DOCUMENT_PROJECTION = Object.fromEntries(
  [...ALWAYS_EXCLUDED].filter((key) => key !== "_id").map((key) => [key, 0])
);
const { validateFilter } = require("../lib/sourceData");

const router = express.Router();

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
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function maskUri(uri) {
  return String(uri).replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:****@");
}

async function refreshFieldsCache(doc) {
  const conn = await getConnectionFor(doc);
  const keys = await sampleFieldKeys(conn.db.collection(doc.collectionName));
  doc.fieldsCache = keys;
  doc.fieldsCachedAt = new Date();
  await doc.save();
  return keys;
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

// POST /api/data-sources — connect a new external Mongo collection.
// Body: { label, mongoUri, databaseName?, collectionName? }
// collectionName is optional: if omitted, the database's collections are
// discovered and used automatically when there's exactly one. If there's
// more than one, the request is rejected with 409 + the discovered list so
// the UI can ask the admin to pick — we never guess which one is "the" data.
// Tests the connection before ever persisting the URI.
router.post("/data-sources", async (req, res) => {
  const { label, mongoUri, databaseName } = req.body || {};
  let { collectionName } = req.body || {};
  if (!label || !mongoUri) {
    return res.status(400).json({ error: "label and mongoUri are required" });
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

  try {
    await testConnection({ mongoUri, databaseName, collectionName });
  } catch (err) {
    return res.status(400).json({ error: "Connection test failed", detail: err.message });
  }

  try {
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
    res.status(201).json({ ...sanitize(doc), fieldsCache, maskedUri: maskUri(mongoUri) });
  } catch (err) {
    res.status(400).json({ error: "Failed to save data source", detail: err.message });
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

// PATCH /api/data-sources/:id — edit label/collectionName/mongoUri/active.
// Body: { label?, mongoUri?, databaseName?, collectionName?, active? }
// Re-tests and re-encrypts when credentials or the target collection change.
router.patch("/data-sources/:id", async (req, res) => {
  const doc = await DataSourceConnection.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Data source not found" });

  const { label, mongoUri, databaseName, collectionName, active } = req.body || {};
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

  try {
    await doc.save();
    if (credentialsChanged) {
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

// GET /api/data-sources/:id/documents?page=&limit=&filter=<json>
router.get("/data-sources/:id/documents", async (req, res) => {
  const source = `${DYNAMIC_PREFIX}${req.params.id}`;
  try {
    const filter = await validateFilter(source, req.query.filter ? JSON.parse(req.query.filter) : {});
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, DOCS_PAGE_LIMIT);
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
});

// DELETE /api/data-sources/:id
router.delete("/data-sources/:id", async (req, res) => {
  const doc = await DataSourceConnection.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: "Data source not found" });
  await evict(doc._id);
  await doc.deleteOne();
  res.json({ deleted: true });
});

module.exports = router;
