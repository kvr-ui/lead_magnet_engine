/**
 * Thin wrapper around the WATI REST API for sending approved WhatsApp
 * template messages. Used by lib/campaignEngine.js to fire each drip step.
 *
 * Config (.env):
 *   WATI_API_ENDPOINT   your tenant's WATI API base, e.g.
 *                       https://live-mt-server.wati.io/12345
 *   WATI_API_TOKEN      the Bearer token from WATI > API Docs
 *   CHANNEL_NUMBER      first WhatsApp number (with country code, e.g. +916383514285)
 *   CHANNEL_NUMBER_2    second WhatsApp number, etc. — numbered sequentially
 *
 * Left unset on purpose in dev/CI — isConfigured() lets callers no-op instead
 * of crashing, same pattern as AD_MAGNET_MONGODB_URI in db.js.
 */

const WATI_API_ENDPOINT = (process.env.WATI_API_ENDPOINT || "").replace(/\/+$/, "");
const WATI_API_TOKEN = process.env.WATI_API_TOKEN || "";

function isConfigured() {
  return Boolean(WATI_API_ENDPOINT && WATI_API_TOKEN);
}

// The account's WhatsApp numbers, read from CHANNEL_NUMBER, CHANNEL_NUMBER_2,
// CHANNEL_NUMBER_3, ... — WATI's channel-list API doesn't expose phone
// numbers, and `channel_number` in sendTemplateMessage takes the actual
// number (e.g. "+916383514285"), so these are configured directly.
function getChannels() {
  const channels = [];
  let i = 1;
  while (true) {
    const key = i === 1 ? "CHANNEL_NUMBER" : `CHANNEL_NUMBER_${i}`;
    const number = (process.env[key] || "").trim();
    if (!number) break;
    channels.push({ number, name: i === 1 ? `${number} (Default)` : number });
    i++;
  }
  return channels;
}

// phone: digits only, with country code (e.g. "919876543210") — no "+".
// params: ordered array of strings filling the template's {{1}}, {{2}}, ...
// channelNumber: WhatsApp number to send from, e.g. "+916383514285" (see
// getChannels()) — omitted/blank sends from the account's default number.
async function sendTemplateMessage({ phone, templateName, broadcastName, params, channelNumber }) {
  if (!isConfigured()) {
    throw new Error("WATI_API_ENDPOINT / WATI_API_TOKEN not set — see .env.example");
  }

  const url = `${WATI_API_ENDPOINT}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`;
  const body = {
    template_name: templateName,
    broadcast_name: broadcastName,
    parameters: (params || []).map((value, i) => ({ name: String(i + 1), value: String(value ?? "") })),
  };
  if (channelNumber) body.channel_number = channelNumber;

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

// Approved WhatsApp templates configured in the WATI dashboard — powers the
// campaign builder's template picker so users select by name instead of
// typing (and possibly mistyping) it.
async function getMessageTemplates() {
  if (!isConfigured()) {
    throw new Error("WATI_API_ENDPOINT / WATI_API_TOKEN not set — see .env.example");
  }

  const res = await fetch(`${WATI_API_ENDPOINT}/api/v1/getMessageTemplates`, {
    headers: { Authorization: `Bearer ${WATI_API_TOKEN}` },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.info || data.message || JSON.stringify(data);
    throw new Error(`WATI getMessageTemplates failed (${res.status}): ${detail}`);
  }
  return (data.messageTemplates || []).map((t) => ({ name: t.elementName, status: t.status }));
}

module.exports = { isConfigured, sendTemplateMessage, getMessageTemplates, getChannels };
