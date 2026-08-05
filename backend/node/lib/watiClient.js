/**
 * Thin wrapper around the WATI REST API for sending approved WhatsApp
 * template messages. Called by lib/whatsappProvider.js, which supplies the
 * endpoint/token loaded from the active WhatsAppIntegration doc in Mongo —
 * this file has no config of its own and makes no assumptions about where
 * credentials come from.
 */

// Tagged with the structured fields lib/errorClassification.js reads —
// httpStatus, providerErrorCode, providerResponse — instead of leaving the
// caller to regex a status code back out of the message string, which is the
// same convention lib/sendingSwitch.js's sendingDisabledError and
// lib/whatsappProvider.js's notAllowlistedError/windowClosedError already
// use for the errors they tag. providerErrorCode is best-effort: WATI's error
// bodies aren't consistent about which key carries it, so every spelling seen
// so far is checked.
function sendError(message, httpStatus, data) {
  const err = new Error(message);
  err.httpStatus = httpStatus;
  err.providerErrorCode = (data && (data.errorCode ?? data.error_code ?? data.code)) ?? undefined;
  err.providerResponse = data;
  return err;
}

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
    throw sendError(`WATI send failed (${res.status}): ${detail}`, res.status, data);
  }
  return data;
}

// A free-typed ("session") message. Legal only inside the customer-initiated
// 24-hour window, which is NOT checked here — lib/whatsappProvider.js owns that
// gate, so every caller passes through it rather than each one remembering.
//
// WATI takes the number in the path and the body as a query parameter on this
// endpoint, unlike sendTemplateMessage which takes a JSON body. Both shapes are
// the provider's, not ours.
async function sendSessionMessage({ endpoint, token, phone, text, channelNumber }) {
  const query = new URLSearchParams({ messageText: String(text ?? "") });
  if (channelNumber) query.set("channel_number", channelNumber);
  const url = `${endpoint}/api/v1/sendSessionMessage/${encodeURIComponent(phone)}?${query.toString()}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === false) {
    const detail = data.info || data.message || JSON.stringify(data);
    throw sendError(`WATI session send failed (${res.status}): ${detail}`, res.status, data);
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
    throw sendError(`WATI getMessageTemplates failed (${res.status}): ${detail}`, res.status, data);
  }
  return (data.messageTemplates || []).map((t) => ({ name: t.elementName, status: t.status }));
}

module.exports = { sendTemplateMessage, sendSessionMessage, getMessageTemplates };
