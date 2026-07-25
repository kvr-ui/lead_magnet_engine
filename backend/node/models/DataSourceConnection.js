const { Schema, model } = require("mongoose");

/**
 * A user-connected external Mongo collection (e.g. another lead magnet's own
 * database) that the admin UI can browse, discover fields for, and filter —
 * without any code or .env change. mongoUriEncrypted is the only place the
 * connection string is stored; it's never returned to the frontend. See
 * lib/dataSourcePool.js for the pooled connections and lib/sourceFields.js
 * for how field discovery resolves a "datasource:<id>" source string.
 */
const dataSourceConnectionSchema = new Schema(
  {
    label: { type: String, required: true, trim: true },
    mongoUriEncrypted: { type: String, required: true },
    databaseName: { type: String, trim: true },
    collectionName: { type: String, required: true, trim: true },
    active: { type: Boolean, default: true },
    status: { type: String, enum: ["connected", "error"], default: "connected" },
    lastError: { type: String, trim: true },
    fieldsCache: { type: [String], default: [] },
    fieldsCachedAt: { type: Date },
    lastTestedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = model("DataSourceConnection", dataSourceConnectionSchema);
