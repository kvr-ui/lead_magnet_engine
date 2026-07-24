const express = require("express");
const Lead = require("../models/Lead");
const { getLeadMagnet, listLeadMagnets, validateExtraFields } = require("../lib/leadMagnets");

const router = express.Router();

// GET /api/lead-magnets — what's configured right now (for a frontend picker, etc.)
router.get("/lead-magnets", (_req, res) => {
  res.json({ leadMagnets: listLeadMagnets() });
});

// POST /api/leads/:magnetKey — ingest one lead for a configured magnet.
// Body: { name, phone, email, ...magnet-specific fields }
router.post("/leads/:magnetKey", async (req, res) => {
  const magnet = getLeadMagnet(req.params.magnetKey);
  if (!magnet) {
    return res.status(404).json({ error: `Unknown lead magnet "${req.params.magnetKey}"` });
  }

  const { name, phone, email, ...rest } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: '"phone" is required' });
  }

  let extra;
  try {
    extra = validateExtraFields(magnet, rest);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message, details: err.details });
  }

  try {
    const lead = await Lead.findOneAndUpdate(
      { leadMagnet: magnet.key, phone },
      { $set: { name, email, extra } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ lead });
  } catch (err) {
    res.status(500).json({ error: "Failed to save lead", detail: err.message });
  }
});

// GET /api/leads/:magnetKey — list leads for one magnet
router.get("/leads/:magnetKey", async (req, res) => {
  const magnet = getLeadMagnet(req.params.magnetKey);
  if (!magnet) {
    return res.status(404).json({ error: `Unknown lead magnet "${req.params.magnetKey}"` });
  }
  const leads = await Lead.find({ leadMagnet: magnet.key }).sort({ createdAt: -1 }).limit(1000);
  res.json({ leads });
});

module.exports = router;
