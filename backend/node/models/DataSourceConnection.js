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

    // Optional join to a sibling collection in the same database, for
    // deriving numeric fields that don't exist directly on this collection
    // (e.g. CA Guru's per-user MCQ attempted/correct counts, summed from the
    // separate `mcqprogresses` collection). When set, every matching document
    // in `enrich.collection` where enrich.foreignField === this doc's
    // enrich.localField is joined in, and each of enrich.sumFields is
    // exposed as a virtual field equal to its sum across the joined docs.
    enrich: {
      type: new Schema(
        {
          collection: { type: String, required: true, trim: true },
          localField: { type: String, required: true, trim: true },
          foreignField: { type: String, required: true, trim: true },
          sumFields: { type: [String], required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { timestamps: true }
);

module.exports = model("DataSourceConnection", dataSourceConnectionSchema);
