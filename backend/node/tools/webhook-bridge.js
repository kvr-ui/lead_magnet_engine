/**
 * Public bridge for the WATI webhook, for local testing.
 *
 * WATI can only deliver events to a publicly reachable URL, but this app's
 * admin API has no auth unless ADMIN_USER/ADMIN_PASSWORD are set — so putting
 * a tunnel straight onto port 3000 would publish the leads database, the
 * campaign send endpoints and the sending kill switch to anyone who guessed
 * the hostname.
 *
 * This listens on its own port and forwards exactly one route —
 * POST /api/wati/webhook — to the app. Every other path and method gets a 404
 * without ever reaching the app. Point the tunnel at THIS port, never 3000.
 *
 *   node tools/webhook-bridge.js
 *   cloudflared tunnel --url http://localhost:3100
 */
const http = require("http");

const TARGET_HOST = process.env.WEBHOOK_TARGET_HOST || "127.0.0.1";
const TARGET_PORT = parseInt(process.env.WEBHOOK_TARGET_PORT, 10) || parseInt(process.env.PORT, 10) || 3000;
const PORT = parseInt(process.env.WEBHOOK_BRIDGE_PORT, 10) || 3100;
const ALLOWED_PATH = "/api/wati/webhook";

const server = http.createServer((req, res) => {
  const { pathname, search } = new URL(req.url, "http://localhost");

  if (req.method !== "POST" || pathname !== ALLOWED_PATH) {
    console.log(`[bridge] BLOCKED ${req.method} ${pathname}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  const upstream = http.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: ALLOWED_PATH + search,
      method: "POST",
      // Only what the app needs to parse the body — no hop-by-hop or
      // client-supplied auth headers are carried through.
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        "x-webhook-secret": req.headers["x-webhook-secret"] || "",
      },
    },
    (upstreamRes) => {
      console.log(`[bridge] forwarded webhook -> ${upstreamRes.statusCode}`);
      res.writeHead(upstreamRes.statusCode, { "content-type": "application/json" });
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (err) => {
    console.error(`[bridge] upstream error: ${err.message}`);
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Bridge could not reach the app" }));
  });

  req.pipe(upstream);
});

server.listen(PORT, () => {
  console.log(`[bridge] listening on http://localhost:${PORT}`);
  console.log(`[bridge] forwarding ONLY POST ${ALLOWED_PATH} to ${TARGET_HOST}:${TARGET_PORT} — everything else 404s`);
});
