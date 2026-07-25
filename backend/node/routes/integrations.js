const express = require("express");
const whatsappProvider = require("../lib/whatsappProvider");

const router = express.Router();

router.get("/integrations/whatsapp", async (_req, res) => {
  res.json(await whatsappProvider.status());
});

// Body: { endpoint, token, channels?: [{id, label?}] }
router.post("/integrations/whatsapp/connect", async (req, res) => {
  const { endpoint, token, channels } = req.body || {};
  if (!endpoint || !token) {
    return res.status(400).json({ error: "endpoint and token are required" });
  }
  try {
    const status = await whatsappProvider.connect({ endpoint, token, channels });
    res.status(201).json(status);
  } catch (err) {
    res.status(400).json({ error: "Connect failed", detail: err.message });
  }
});

router.post("/integrations/whatsapp/disconnect", async (_req, res) => {
  await whatsappProvider.disconnect();
  res.json({ connected: false });
});

module.exports = router;
