const express = require("express");
const { getAdMagnetConnection } = require("../db");
const { getSourceFields } = require("../lib/sourceFields");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

const PAGE_SIZE = 50;

// Known lead collections in the CA-Guru-Ai ad-magnet DB. Both share roughly
// the same shape; "users" is the live collection, "users123" looks like an
// older/legacy snapshot with mostly the same fields.
const MAPPED_COLLECTIONS = new Set(["users", "users123"]);

// GET /api/ad-magnet/collections — list collection names in the ad-magnet DB.
router.get("/collections", async (_req, res) => {
  const conn = getAdMagnetConnection();
  if (!conn) {
    return res.status(503).json({ error: "AD_MAGNET_MONGODB_URI not configured" });
  }
  const collections = await conn.db.listCollections().toArray();
  res.json({
    collections: collections
      .map((c) => c.name)
      .sort()
      .map((name) => ({ name, mapped: MAPPED_COLLECTIONS.has(name) })),
  });
});

// GET /api/ad-magnet/leads?collection=users&page=1 — paginated documents.
router.get("/leads", async (req, res) => {
  const conn = getAdMagnetConnection();
  if (!conn) {
    return res.status(503).json({ error: "AD_MAGNET_MONGODB_URI not configured" });
  }

  const { collection } = req.query;
  if (!collection) {
    return res.status(400).json({ error: '"collection" query param is required' });
  }

  const collections = await conn.db.listCollections({ name: collection }).toArray();
  if (!collections.length) {
    return res.status(404).json({ error: `Unknown collection "${collection}"` });
  }

  const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
  const coll = conn.db.collection(collection);
  const mapped = MAPPED_COLLECTIONS.has(collection);
  const sortField = mapped ? { createdAt: -1 } : { _id: -1 };

  const total = await coll.estimatedDocumentCount();
  const docs = await coll
    .find({})
    .sort(sortField)
    .skip((pageNum - 1) * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .toArray();

  res.json({
    collection,
    mapped,
    page: pageNum,
    pageSize: PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    leads: docs,
  });
});

// GET /api/ad-magnet/students?page=1&search=foo — students with MCQ performance only
// (name/email/phone/city + how many MCQs attempted/solved correctly), no raw DB dump.
router.get("/students", async (req, res) => {
  const conn = getAdMagnetConnection();
  if (!conn) {
    return res.status(503).json({ error: "AD_MAGNET_MONGODB_URI not configured" });
  }

  const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
  const search = (req.query.search || "").trim();

  const match = search
    ? {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { email: { $regex: search, $options: "i" } },
          { phoneNumber: { $regex: search, $options: "i" } },
        ],
      }
    : {};

  const usersColl = conn.db.collection("users");
  const total = await usersColl.countDocuments(match);

  const pipeline = [
    { $match: match },
    { $sort: { createdAt: -1 } },
    { $skip: (pageNum - 1) * PAGE_SIZE },
    { $limit: PAGE_SIZE },
    {
      $lookup: {
        from: "mcqprogresses",
        localField: "userId",
        foreignField: "userId",
        as: "progress",
      },
    },
    {
      $addFields: {
        mcqAttempted: { $sum: "$progress.totalAttempted" },
        mcqCorrect: { $sum: "$progress.totalCorrect" },
      },
    },
    // Keep the rest of the real document (not just a fixed subset) so the
    // frontend's field picker can show any column that actually exists, but
    // never leak OTP secrets or mongoose/join internals.
    { $project: { progress: 0, phoneOtp: 0, phoneOtpExpires: 0, __v: 0 } },
  ];

  const students = await usersColl.aggregate(pipeline).toArray();

  res.json({
    page: pageNum,
    pageSize: PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    students,
  });
});

// GET /api/ad-magnet/students/fields — distinct field names seen on the
// external "users" collection, for the leads-page column picker. There's no
// Mongoose schema for this collection (it lives in a separate DB), so
// getSourceFields() discovers fields by sampling documents instead of a
// static list.
router.get("/students/fields", async (_req, res) => {
  const conn = getAdMagnetConnection();
  if (!conn) {
    return res.status(503).json({ error: "AD_MAGNET_MONGODB_URI not configured" });
  }
  const fields = await getSourceFields("AdMagnetStudent");
  res.json({ fields: fields.map((f) => f.key) });
});

module.exports = router;
