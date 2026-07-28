const express = require("express");
const whatsappProvider = require("../lib/whatsappProvider");
const CampaignEnrollment = require("../models/CampaignEnrollment");
const MessageEvent = require("../models/MessageEvent");
const { cleanPhone } = require("../lib/phone");
const { asyncRouter } = require("../lib/asyncRouter");

const router = asyncRouter();

// WATI's payload shape varies by event (message status vs. inbound reply vs.
// button click). Pull whatever's there instead of assuming one schema —
// unrecognized fields just land in `payload` for later inspection.
function extractPhone(body) {
  const raw = body.waId || body.whatsappNumber || body.phone || body.senderPhone || body.customerPhone || "";
  return raw ? cleanPhone(String(raw)) : "";
}

function extractEventType(body) {
  return body.eventType || body.type || body.statusString || body.event || "unknown";
}

// POST /api/wati/webhook?secret=... — WATI calls this on message status
// changes, replies, and button clicks. Registered per-connection under
// Integrations > WhatsApp in the admin UI, which shows the exact URL+secret
// to paste into WATI's dashboard.
router.post("/wati/webhook", async (req, res) => {
  const secret = req.query.secret || req.get("x-webhook-secret");
  const integration = await whatsappProvider.findBySecret(secret);
  if (!integration) {
    console.log("[wati/webhook] rejected: invalid or missing secret");
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  const body = req.body || {};
  console.log(`[wati/webhook] ${new Date().toISOString()} body:`, JSON.stringify(body));

  const phone = extractPhone(body);
  const eventType = extractEventType(body);

  const event = await MessageEvent.create({ phone: phone || "unknown", eventType, payload: body });

  if (phone) {
    const enrollment = await CampaignEnrollment.findOne({ phone, status: "active" }).sort({ updatedAt: -1 });
    if (enrollment) {
      event.enrollment = enrollment._id;
      event.campaign = enrollment.campaign;
      await event.save();
    }
  }

  // WATI expects a 200 regardless of whether we matched an enrollment —
  // a non-2xx here just makes WATI retry the same event.
  res.json({ ok: true });
});

module.exports = router;
