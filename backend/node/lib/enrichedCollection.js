/**
 * Wraps a native MongoDB collection so a handful of "virtual" numeric fields
 * computed by summing a joined sibling collection's matching documents (e.g.
 * CA Guru's MCQ attempted/correct counts, joined from `mcqprogresses` by
 * `userId`) behave like real fields to every existing caller — find/findOne/
 * countDocuments/aggregate keep their native-driver shapes, they just run as
 * an aggregation with the join baked in instead of a plain query.
 *
 * Only used when a DataSourceConnection has `enrich` configured; every other
 * data source keeps using the plain native collection untouched.
 */

function enrichmentStages({ collection, localField, foreignField, sumFields }) {
  const addFields = {};
  for (const field of sumFields) {
    addFields[field] = { $sum: `$__enrich.${field}` };
  }
  return [
    { $lookup: { from: collection, localField, foreignField, as: "__enrich" } },
    { $addFields: addFields },
    { $project: { __enrich: 0 } },
  ];
}

// Splits a flat { field: value | {$in:[...]} } filter into fields that exist
// on the base document (matched before the $lookup, so Mongo can use an
// index) vs. computed fields (only exist after $addFields, matched after).
function splitFilter(filter, computedFields) {
  const pre = {};
  const post = {};
  for (const [key, value] of Object.entries(filter || {})) {
    (computedFields.includes(key) ? post : pre)[key] = value;
  }
  return { pre, post };
}

function wrapWithEnrichment(nativeCollection, enrich) {
  const stages = enrichmentStages(enrich);

  function pipelineFor(filter, extraStages) {
    const { pre, post } = splitFilter(filter, enrich.sumFields);
    const pipeline = [];
    if (Object.keys(pre).length) pipeline.push({ $match: pre });
    pipeline.push(...stages);
    if (Object.keys(post).length) pipeline.push({ $match: post });
    pipeline.push(...extraStages);
    return pipeline;
  }

  return {
    find(filter) {
      let projection = null;
      let sortSpec = null;
      let skipN = 0;
      let limitN = 0;
      const cursor = {
        project(p) {
          projection = p;
          return cursor;
        },
        sort(s) {
          sortSpec = s;
          return cursor;
        },
        skip(n) {
          skipN = n;
          return cursor;
        },
        limit(n) {
          limitN = n;
          return cursor;
        },
        async toArray() {
          const extra = [];
          if (sortSpec) extra.push({ $sort: sortSpec });
          if (skipN) extra.push({ $skip: skipN });
          if (limitN) extra.push({ $limit: limitN });
          if (projection) extra.push({ $project: projection });
          return nativeCollection.aggregate(pipelineFor(filter, extra)).toArray();
        },
      };
      return cursor;
    },
    async findOne(filter) {
      const docs = await nativeCollection.aggregate(pipelineFor(filter, [{ $limit: 1 }])).toArray();
      return docs[0] || null;
    },
    async countDocuments(filter) {
      const rows = await nativeCollection.aggregate(pipelineFor(filter, [{ $count: "n" }])).toArray();
      return rows[0]?.n || 0;
    },
    aggregate(pipeline) {
      return nativeCollection.aggregate([...stages, ...pipeline]);
    },
  };
}

module.exports = { wrapWithEnrichment };
