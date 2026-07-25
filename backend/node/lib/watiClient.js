/**
 * Thin wrapper around the WATI REST API for sending approved WhatsApp
 * template messages. Used by lib/campaignEngine.js to fire each drip step.
 *
 * Config (.env):
 *   WATI_API_ENDPOINT   your tenant's WATI API base, e.g.
 *                       https://live-mt-server.wati.io/12345
 *   WATI_API_TOKEN      the Bearer token from WATI > API Docs
 *
 * Left unset on purpose in dev/CI — isConfigured() lets callers no-op instead
 * of crashing, same pattern as AD_MAGNET_MONGODB_URI in db.js.
 */

const WATI_API_ENDPOINT = (process.env.WATI_API_ENDPOINT || "").replace(/\/+$/, "");
const WATI_API_TOKEN = process.env.WATI_API_TOKEN || "";

function isConfigured() {
  return Boolean(WATI_API_ENDPOINT && WATI_API_TOKEN);
}

// phone: digits only, with country code (e.g. "919876543210") — no "+".
// params: ordered array of strings filling the template's {{1}}, {{2}}, ...
async function sendTemplateMessage({ phone, templateName, broadcastName, params }) {
  if (!isConfigured()) {
    throw new Error("WATI_API_ENDPOINT / WATI_API_TOKEN not set — see .env.example");
  }

  const url = `${WATI_API_ENDPOINT}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`;
  const body = {
    template_name: templateName,
    broadcast_name: broadcastName,
    parameters: (params || []).map((value, i) => ({ name: String(i + 1), value: String(value ?? "") })),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WATI_API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === false) {
    const detail = data.info || data.message || JSON.stringify(data);
    throw new Error(`WATI send failed (${res.status}): ${detail}`);
  }
  return data;
}

module.exports = { isConfigured, sendTemplateMessage };
