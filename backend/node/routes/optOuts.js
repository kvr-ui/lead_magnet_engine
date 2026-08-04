const OptOut = require("../models/OptOut");
const { cleanPhone } = require("../lib/phone");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

// Opt-out management. Kept as its own always-on, campaign-independent
// mechanism rather than a node on the campaign graph — see the comment on
// models/OptOut.js and the STOP-keyword handling in routes/wati.js for why.
// Mounted behind requireAdminAuth in index.js, same as the other admin-only
// data routes (contrast with routes/wati.js's webhook, which cannot be
// authenticated because WATI calls it directly).

// GET /api/opt-outs?page=1&limit=50 — paginated list + total count.
router.get("/opt-outs", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const [optOuts, total] = await Promise.all([
    OptOut.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    OptOut.estimatedDocumentCount(),
  ]);
  res.json({
    total,
    count: optOuts.length,
    page,
    pageSize: limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    optOuts,
  });
});

// POST /api/opt-outs { phone } — manually opt a phone out (source: "manual").
// Upserts, so re-adding an already-opted-out phone (inbound or manual) is a
// no-op rather than a duplicate-key error.
router.post("/opt-outs", async (req, res) => {
  const phone = cleanPhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ error: "A valid phone number is required" });
  }

  const optOut = await OptOut.findOneAndUpdate(
    { phone },
    { $setOnInsert: { phone, source: "manual" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.status(201).json({ ok: true, optOut });
});

// DELETE /api/opt-outs/:id — remove an opt-out record, re-permitting the phone.
router.delete("/opt-outs/:id", async (req, res) => {
  const deleted = await OptOut.findByIdAndDelete(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Opt-out not found" });
  res.json({ ok: true });
});

module.exports = router;
