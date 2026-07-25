#!/usr/bin/env node
/**
 * Express front door for the WATI CSV cleaner.
 *
 * All request handling still happens in the Python app (../app.py) —
 * this just terminates the public port and proxies everything through.
 * That's where new Node-side features (auth, routing, another API, etc.)
 * for the wider project would get added, without touching the Python
 * cleaning logic.
 *
 * Config via environment (set these once in .env after deployment):
 *   PORT                 port this Express server listens on   (default 3000)
 *   HOST                 bind address for this server           (default 0.0.0.0)
 *   PY_TARGET            where the Python backend is running     (default http://127.0.0.1:8000)
 *   MONGODB_URI          MongoDB connection string               (see db.js)
 *   AD_MAGNET_MONGODB_URI  connection string for the external ad/lead-magnet
 *                          DB, read-only via /api/ad-magnet/* (optional)
 *   LEAD_MAGNETS_CONFIG  path to the lead magnets JSON file       (default ./config/leadMagnets.json)
 *
 * Lead magnets (which fields each one collects) are configured once via the
 * /admin/lead-magnets form and stored in MongoDB — no code change, no
 * restart. On first boot with an empty LeadMagnetConfig collection, they're
 * seeded from config/leadMagnets.json so existing setups keep working. See
 * lib/leadMagnets.js, routes/admin.js and routes/leads.js.
 *
 * Run:
 *   npm install
 *   npm start
 */

require("dotenv").config();

const path = require("path");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { connectDB, connectAdMagnetDB, mongoose } = require("./db");
const { initLeadMagnets } = require("./lib/leadMagnets");
const leadsRouter = require("./routes/leads");
const adminRouter = require("./routes/admin");
const contactsRouter = require("./routes/contacts");
const adMagnetRouter = require("./routes/adMagnet");
const campaignsRouter = require("./routes/campaigns");
const integrationsRouter = require("./routes/integrations");
const dataSourcesRouter = require("./routes/dataSources");
const { startScheduler } = require("./lib/campaignEngine");
const { requireAdminAuth } = require("./lib/adminAuth");
const whatsappProvider = require("./lib/whatsappProvider");
const WhatsAppIntegration = require("./models/WhatsAppIntegration");

const ADMIN_UI_DIST = path.join(__dirname, "..", "..", "frontend", "admin-ui", "dist");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PY_TARGET = process.env.PY_TARGET || "http://127.0.0.1:8000";

const app = express();

app.get("/node-health", (_req, res) => {
  res.json({
    ok: true,
    proxyTarget: PY_TARGET,
    mongo: mongoose.connection.readyState === 1 ? "connected" : "down",
  });
});

// Large limits so a full contact CSV / batched webhook payload fits.
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: false }));
// Raw CSV body for POST /api/contacts/import (Content-Type: text/csv).
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "50mb" }));
app.use("/api", leadsRouter);
app.use("/api", contactsRouter);
app.use("/api", requireAdminAuth, campaignsRouter);
app.use("/api", requireAdminAuth, integrationsRouter);
app.use("/api", requireAdminAuth, dataSourcesRouter);
app.use("/api/ad-magnet", requireAdminAuth, adMagnetRouter);
app.use("/admin", requireAdminAuth, adminRouter);
// React leads dashboard (admin-ui/), built via `npm run build` in that folder.
app.use("/admin/leads", requireAdminAuth, express.static(ADMIN_UI_DIST));

app.use(
  "/",
  createProxyMiddleware({
    target: PY_TARGET,
    changeOrigin: true,
    ws: false,
    logger: console,
  })
);

// One-time bootstrap: if nothing's been connected via the Integrations tab
// yet but WATI_* env vars are set (the old hardcoded config), migrate them
// into an active WhatsAppIntegration doc so upgrading doesn't break existing
// sends. After this runs once, the env vars are no longer read — the UI
// becomes the source of truth.
async function migrateWatiEnvConfigIfNeeded() {
  const endpoint = (process.env.WATI_API_ENDPOINT || "").replace(/\/+$/, "");
  const token = process.env.WATI_API_TOKEN || "";
  if (!endpoint || !token) return;
  if ((await WhatsAppIntegration.countDocuments()) > 0) return;

  const channels = [];
  let i = 1;
  while (true) {
    const key = i === 1 ? "CHANNEL_NUMBER" : `CHANNEL_NUMBER_${i}`;
    const number = (process.env[key] || "").trim();
    if (!number) break;
    channels.push({ id: number, label: i === 1 ? `${number} (Default)` : number });
    i++;
  }

  try {
    await whatsappProvider.connect({ endpoint, token, channels });
    console.log("[whatsappProvider] Migrated WATI_* env config into MongoDB — manage the connection from the Integrations tab going forward.");
  } catch (err) {
    console.warn(`[whatsappProvider] Auto-migration from .env failed: ${err.message}`);
  }
}

async function start() {
  await connectDB();
  await connectAdMagnetDB();
  await initLeadMagnets();
  await migrateWatiEnvConfigIfNeeded();
  startScheduler();
  app.listen(PORT, HOST, () => {
    console.log(`Express proxy listening on http://${HOST}:${PORT}`);
    console.log(`Forwarding to Python backend at ${PY_TARGET}`);
    console.log(`Lead magnet admin UI at /admin/lead-magnets`);
    console.log(`Leads dashboard (React) at /admin/leads`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
