const mongoose = require("mongoose");

/**
 * Pooled mongoose.createConnection()s for user-connected DataSourceConnection
 * rows, keyed by _id. Created lazily on first use and cached — a request
 * never pays a fresh-connect round trip after the first. Mirrors db.js's
 * single hardcoded adMagnetConnection, generalized to arbitrary many.
 */
const pool = new Map(); // id (string) -> Promise<Connection>

function buildOptions(databaseName) {
  return databaseName ? { dbName: databaseName } : {};
}

async function getConnectionFor(doc) {
  const id = String(doc._id);
  if (pool.has(id)) return pool.get(id);

  const { decrypt } = require("./crypto");
  const uri = decrypt(doc.mongoUriEncrypted);
  const connPromise = (async () => {
    const conn = mongoose.createConnection(uri, buildOptions(doc.databaseName));
    conn.on("error", (err) => {
      console.error(`DataSourceConnection ${id} error:`, err.message);
    });
    await conn.asPromise();
    return conn;
  })();

  pool.set(id, connPromise);
  connPromise.catch(() => pool.delete(id));
  return connPromise;
}

// Throwaway probe connection, not pooled — used to validate credentials
// before ever persisting them (create) or when they change (edit).
async function testConnection({ mongoUri, databaseName, collectionName }) {
  const conn = mongoose.createConnection(mongoUri, buildOptions(databaseName));
  try {
    await conn.asPromise();
    const collections = await conn.db.listCollections({ name: collectionName }).toArray();
    if (collections.length === 0) {
      throw new Error(`Collection "${collectionName}" not found in the target database`);
    }
    const count = await conn.db.collection(collectionName).estimatedDocumentCount();
    return { ok: true, documentCount: count };
  } finally {
    await conn.close().catch(() => {});
  }
}

async function evict(id) {
  const key = String(id);
  const connPromise = pool.get(key);
  if (!connPromise) return;
  pool.delete(key);
  try {
    const conn = await connPromise;
    await conn.close();
  } catch {
    // already broken or closing — nothing to clean up
  }
}

module.exports = { getConnectionFor, testConnection, evict };
