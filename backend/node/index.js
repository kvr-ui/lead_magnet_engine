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

const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const { connectDB, mongoose } = require("./db");
const { initLeadMagnets } = require("./lib/leadMagnets");
const leadsRouter = require("./routes/leads");
const adminRouter = require("./routes/admin");
const contactsRouter = require("./routes/contacts");

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
app.use("/admin", adminRouter);

app.use(
  "/",
  createProxyMiddleware({
    target: PY_TARGET,
    changeOrigin: true,
    ws: false,
    logger: console,
  })
);

async function start() {
  await connectDB();
  await initLeadMagnets();
  app.listen(PORT, HOST, () => {
    console.log(`Express proxy listening on http://${HOST}:${PORT}`);
    console.log(`Forwarding to Python backend at ${PY_TARGET}`);
    console.log(`Lead magnet admin UI at /admin/lead-magnets`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
