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
 *   AD_MAGNET_MONGODB_URI  legacy: CA Guru's database. Read once by
 *                          tools/seed-ca-guru-source.js to create the
 *                          equivalent DataSourceConnection, and needed by
 *                          nothing afterwards. Safe to remove entirely once
 *                          that connection exists. (optional)
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
const { connectDB, mongoose } = require("./db");
const { initLeadMagnets } = require("./lib/leadMagnets");
const leadsRouter = require("./routes/leads");
const adminRouter = require("./routes/admin");
const contactsRouter = require("./routes/contacts");
const campaignsRouter = require("./routes/campaigns");
const nodePresetsRouter = require("./routes/nodePresets");
const integrationsRouter = require("./routes/integrations");
const dataSourcesRouter = require("./routes/dataSources");
const settingsRouter = require("./routes/settings");
const watiRouter = require("./routes/wati");
const messageEventsRouter = require("./routes/messageEvents");
const sessionWindowsRouter = require("./routes/sessionWindows");
const activityRouter = require("./routes/activity");
const optOutsRouter = require("./routes/optOuts");
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
app.use("/api", watiRouter);
app.use("/api", requireAdminAuth, campaignsRouter);
// The reusable node preset library the campaign canvas inserts from. Presets
// are copied into a campaign's graph, never linked to it — see
// models/NodePreset.js.
app.use("/api", requireAdminAuth, nodePresetsRouter);
// Reads back what watiRouter's webhook writes. Behind admin auth on purpose —
// the webhook itself can't be, but nothing that exposes the data should be.
app.use("/api", requireAdminAuth, messageEventsRouter);
// Who can still be sent a free-typed message right now — derived from the same
// inbound events, so it is admin-only for the same reason.
app.use("/api", requireAdminAuth, sessionWindowsRouter);
// Reads the lead magnet's own database to say what leads did after a send.
// Read-only across the connection, and admin-only like everything that
// exposes lead data.
app.use("/api", requireAdminAuth, activityRouter);
app.use("/api", requireAdminAuth, integrationsRouter);
app.use("/api", requireAdminAuth, dataSourcesRouter);
app.use("/api", requireAdminAuth, settingsRouter);
// Global, always-on opt-out management (see models/OptOut.js). Admin-only,
// same as the other data-exposing routes.
app.use("/api", requireAdminAuth, optOutsRouter);
app.use("/admin", requireAdminAuth, adminRouter);
// React leads dashboard (admin-ui/), built via `npm run build` in that folder.
app.use("/admin/leads", requireAdminAuth, express.static(ADMIN_UI_DIST));

// Everything under /api is owned by this server — the Python backend only
// serves the CSV-cleaner pages at /. Answer unmatched API paths with JSON
// here rather than letting them fall through to the proxy below, which
// replies with a plain-text 504 when Python isn't running ("Error occurred
// while trying to proxy: ...") — not something the admin UI can parse.
app.use("/api", (req, res) => {
  res.status(404).json({ error: `No such API route: ${req.method} ${req.originalUrl}` });
});

app.use(
  "/",
  createProxyMiddleware({
    target: PY_TARGET,
    changeOrigin: true,
    ws: false,
    logger: console,
  })
);

// Last stop for anything a route handler threw or rejected with (async
// handlers are funnelled here by lib/asyncRouter). Without this Express
// answers with an HTML error page, and the admin UI's fetch wrapper can't
// pull a message out of it.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || err.statusCode || (err.name === "CastError" || err.name === "ValidationError" ? 400 : 500);
  console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err);
  if (res.headersSent) return res.end();
  res.status(status).json({
    error: status === 400 ? "Invalid request" : "Internal server error",
    detail: err.message,
  });
});

// Safety net for anything that escapes a request (a rejected promise in the
// campaign scheduler, a late callback). Once we're serving, log loudly but
// stay up: this process is the only thing serving the admin UI, and
// `node --watch` does NOT restart after a crash — it waits for the next file
// change — so exiting means a silent outage until someone notices.
//
// Before that point the same leniency would be wrong: a failure during
// startup (a bad MONGODB_URI, port already in use) would leave a process
// running that never listens, so those still exit.
let serving = false;

function survive(label, err) {
  if (!serving) {
    console.error(`Failed to start server (${label}):`, err);
    process.exit(1);
  }
  console.error(`[${label}] server kept alive:`, err);
}

process.on("unhandledRejection", (reason) => survive("unhandledRejection", reason));
process.on("uncaughtException", (err) => survive("uncaughtException", err));

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
  await initLeadMagnets();
  // Makes sure CA Guru — the one lead magnet that used to be wired in as code
  // — exists as an ordinary DataSourceConnection, and records the pointer that
  // lets enrollments created against the retired "AdMagnetStudent" source name
  // still resolve. Idempotent, so this is a no-op on every boot after the
  // first. Never fatal: a seed that can't run must not stop the app serving.
  try {
    const { ensureCaGuruDataSource } = require("./tools/seed-ca-guru-source");
    const seeded = await ensureCaGuruDataSource();
    if (seeded.action !== "unchanged") {
      console.log(`[seed-ca-guru-source] ${JSON.stringify(seeded)}`);
    }
  } catch (err) {
    console.warn(`[seed-ca-guru-source] skipped: ${err.message}`);
  }
  await migrateWatiEnvConfigIfNeeded();
  startScheduler();
  app.listen(PORT, HOST, () => {
    serving = true;
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
