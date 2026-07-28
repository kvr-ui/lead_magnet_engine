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

    // Optional link to a sibling collection that records one row per thing a
    // lead *did*, each stamped with when they did it (e.g. CA Guru's
    // `mcqevaluations` — one row per MCQ answered, stamped `submittedAt`).
    //
    // This is what makes campaign impact measurable. `enrich` above can only
    // sum lifetime totals, which carry no time dimension: a lead showing 6
    // questions answered gives no way to tell whether they did them before or
    // after we messaged them. A per-row timestamp does — anything stamped
    // after a send is attributable to that send (see lib/leadActivity.js).
    //
    // correctField is an optional boolean marking a successful row, so the
    // rollup can report "3 answered, 1 correct" rather than a bare count.
    // labelFields are shown per row in the UI (e.g. subject + chapter) to say
    // what the lead actually engaged with.
    activity: {
      type: new Schema(
        {
          collection: { type: String, required: true, trim: true },
          localField: { type: String, required: true, trim: true },
          foreignField: { type: String, required: true, trim: true },
          timestampField: { type: String, required: true, trim: true },
          correctField: { type: String, trim: true },
          labelFields: { type: [String], default: [] },
          // Shown in the UI instead of the raw collection name.
          noun: { type: String, trim: true, default: "activity" },

          // What the lead actually answered, for the per-question drill-down.
          answerField: { type: String, trim: true },
          correctAnswerField: { type: String, trim: true },

          // Where the question text itself lives. The activity row records
          // only the answer letters ("B", correct "C"), which is unreadable
          // on its own — the wording and options are in a separate
          // collection, joined by the id the activity row carries.
          //
          // arrayField covers the common case of questions stored batched in
          // an array on a generation/batch document (CA Guru's
          // `mcqgenerations.mcqData[]`) rather than one per document.
          questions: {
            type: new Schema(
              {
                collection: { type: String, required: true, trim: true },
                // Field on the *activity* row holding the question id.
                activityKeyField: { type: String, required: true, trim: true },
                // Array on the question document holding the questions, if
                // they're batched. Omit when one document is one question.
                arrayField: { type: String, trim: true },
                // Matching id field, inside arrayField when that's set.
                keyField: { type: String, required: true, trim: true },
                textField: { type: String, required: true, trim: true },
                optionsField: { type: String, trim: true },
                explanationField: { type: String, trim: true },
              },
              { _id: false }
            ),
            default: undefined,
          },
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { timestamps: true }
);

module.exports = model("DataSourceConnection", dataSourceConnectionSchema);
