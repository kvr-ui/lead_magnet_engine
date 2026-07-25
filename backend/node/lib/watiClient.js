/**
 * Thin wrapper around the WATI REST API for sending approved WhatsApp
 * template messages. Called by lib/whatsappProvider.js, which supplies the
 * endpoint/token loaded from the active WhatsAppIntegration doc in Mongo —
 * this file has no config of its own and makes no assumptions about where
 * credentials come from.
 */

// phone: digits only, with country code (e.g. "919876543210") — no "+".
// params: ordered array of strings filling the template's {{1}}, {{2}}, ...
// channelNumber: WhatsApp number to send from, e.g. "+916383514285" —
// omitted/blank sends from the account's default number.
async function sendTemplateMessage({ endpoint, token, phone, templateName, broadcastName, params, channelNumber }) {
  const url = `${endpoint}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(phone)}`;
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
      Authorization: `Bearer ${token}`,
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
async function getMessageTemplates({ endpoint, token }) {
  const res = await fetch(`${endpoint}/api/v1/getMessageTemplates`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.info || data.message || JSON.stringify(data);
    throw new Error(`WATI getMessageTemplates failed (${res.status}): ${detail}`);
  }
  return (data.messageTemplates || []).map((t) => ({ name: t.elementName, status: t.status }));
}

module.exports = { sendTemplateMessage, getMessageTemplates };
