const crypto = require("crypto");

/**
 * HTTP Basic Auth gate for admin-only surfaces (the leads dashboard, the
 * lead-magnets admin UI, campaigns). Reads ADMIN_USER / ADMIN_PASSWORD from
 * env. If either is unset, auth is disabled and a warning is logged once at
 * startup — same "unconfigured = feature off" pattern as AD_MAGNET_MONGODB_URI
 * in db.js, so an empty .env doesn't hard-crash existing deployments.
 */
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ENABLED = Boolean(ADMIN_USER && ADMIN_PASSWORD);

if (!ENABLED) {
  console.warn(
    "[adminAuth] ADMIN_USER/ADMIN_PASSWORD not set — admin routes (dashboard, campaigns) are UNPROTECTED. Set both in .env to enable Basic Auth."
  );
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAdminAuth(req, res, next) {
  if (!ENABLED) return next();

  const header = req.get("authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep !== -1) {
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (timingSafeEqual(user, ADMIN_USER) && timingSafeEqual(pass, ADMIN_PASSWORD)) {
        return next();
      }
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="admin", charset="UTF-8"');
  return res.status(401).send("Authentication required");
}

module.exports = { requireAdminAuth };
