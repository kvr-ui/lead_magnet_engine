/**
 * The WhatsApp provider "node" — the only thing campaignEngine.js and
 * routes/campaigns.js talk to. Loads the active WhatsAppIntegration doc from
 * Mongo on each call (send volume is low, no need to cache) and dispatches
 * to the adapter matching its `type`. Today only "wati" exists; adding a
 * provider later means a new adapter module + a new `type` value here, not
 * a rewrite of the campaign/route layer.
 */
const crypto = require("crypto");
const WhatsAppIntegration = require("../models/WhatsAppIntegration");
const { encrypt, decrypt } = require("./crypto");
const wati = require("./watiClient");
const { isSendingEnabled, sendingDisabledError } = require("./sendingSwitch");
const { isWindowOpen, WINDOW_HOURS } = require("./sessionWindow");

const NOT_CONNECTED = "No WhatsApp provider connected — connect one from the Integrations tab";

// Tagged so advanceEnrollment/sendSingleMessage can tell "deliberately dropped
// by the allowlist" apart from "the provider rejected this", and treat it the
// same way they treat a closed kill switch: leave things alone, don't fail.
function notAllowlistedError(phone) {
  const err = new Error(`Phone ${phone} is not on SEND_PHONE_ALLOWLIST — send dropped`);
  err.notAllowlisted = true;
  return err;
}

// Parses SEND_PHONE_ALLOWLIST into a Set of cleaned entries (no leading "+",
// no other non-digit characters), or null when the env var is unset/empty —
// null means "no allowlist configured, don't filter at all".
function getAllowlist() {
  const raw = process.env.SEND_PHONE_ALLOWLIST;
  if (!raw || !raw.trim()) return null;
  const entries = raw
    .split(",")
    .map((entry) => entry.trim().replace(/\D/g, ""))
    .filter(Boolean);
  return entries.length ? new Set(entries) : null;
}

// Tagged so the graph walker can tell "Meta would refuse this" apart from a
// provider outage and park the lead with a reason it can act on, rather than
// burning it as a generic failure.
function windowClosedError(phone) {
  const err = new Error(
    `Phone ${phone} has no open ${WINDOW_HOURS}-hour conversation window, so a free-text message cannot be sent — use a template`
  );
  err.windowClosed = true;
  return err;
}

async function getActiveDoc() {
  return WhatsAppIntegration.findOne({ active: true }).sort({ updatedAt: -1 });
}

async function isConfigured() {
  const doc = await getActiveDoc();
  return Boolean(doc && doc.apiEndpoint && doc.apiTokenEncrypted);
}

async function getChannels() {
  const doc = await getActiveDoc();
  if (!doc) return [];
  return doc.channels.map((c) => ({ id: c.id, label: c.label || c.id }));
}

async function getTemplates() {
  const doc = await getActiveDoc();
  if (!doc) throw new Error(NOT_CONNECTED);
  const templates = await wati.getMessageTemplates({ endpoint: doc.apiEndpoint, token: decrypt(doc.apiTokenEncrypted) });
  return templates.map((t) => ({ id: t.name, status: t.status }));
}

/**
 * The single gate every outbound message passes through. The kill-switch
 * check is first and unconditional — before the provider lookup, before any
 * network call — so "sending is off" can never be reached past.
 *
 * `type` picks what is being sent:
 *
 *   "template" (the default) — an approved template. Legal at any time, which
 *   is why every send before free text existed needed no window check at all.
 *
 *   "text" — a free-typed message, legal ONLY inside the customer-initiated
 *   window. The check sits here rather than in the graph walker deliberately:
 *   this is the last point before the network, so a window that closed between
 *   a condition node's branch and this call is still caught, and the manual
 *   send path gets the same gate for free. A caller that has already checked
 *   pays one indexed query for the certainty.
 */
async function sendMessage({ phone, templateId, params, channelId, meta, type, text }) {
  if (!(await isSendingEnabled())) throw sendingDisabledError();
  const allowlist = getAllowlist();
  if (allowlist && !allowlist.has(String(phone).replace(/\D/g, ""))) {
    console.log(`[allowlist] dropped send to ${phone} (template ${templateId}) — not on SEND_PHONE_ALLOWLIST`);
    throw notAllowlistedError(phone);
  }
  const doc = await getActiveDoc();
  if (!doc) throw new Error(NOT_CONNECTED);

  if (String(type || "template").toLowerCase() === "text") {
    const body = String(text ?? "").trim();
    // Not a window problem, so not tagged as one: an empty body is a broken
    // node, and sending a blank message would be worse than failing.
    if (!body) throw new Error("A free-text message has no text to send");
    if (!(await isWindowOpen(phone))) throw windowClosedError(phone);
    return wati.sendSessionMessage({
      endpoint: doc.apiEndpoint,
      token: decrypt(doc.apiTokenEncrypted),
      phone,
      text: body,
      channelNumber: channelId,
    });
  }

  return wati.sendTemplateMessage({
    endpoint: doc.apiEndpoint,
    token: decrypt(doc.apiTokenEncrypted),
    phone,
    templateName: templateId,
    broadcastName: meta?.broadcastName,
    params,
    channelNumber: channelId,
  });
}

// Upserts the connection and marks it active. Does a live check against the
// given credentials first so a bad token fails fast in the UI instead of
// silently saving broken config.
async function connect({ endpoint, token, channels }) {
  await wati.getMessageTemplates({ endpoint, token }); // throws if creds are bad

  await WhatsAppIntegration.updateMany({ active: true }, { $set: { active: false } });
  const existing = await WhatsAppIntegration.findOne({ type: "wati" });
  const doc = await WhatsAppIntegration.findOneAndUpdate(
    { type: "wati" },
    {
      $set: {
        type: "wati",
        apiEndpoint: endpoint,
        apiTokenEncrypted: encrypt(token),
        channels: channels || [],
        active: true,
        connectedAt: new Date(),
        // Keep the same secret across reconnects so a previously-registered
        // WATI webhook URL doesn't silently break.
        webhookSecret: existing?.webhookSecret || crypto.randomBytes(24).toString("hex"),
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return status(doc);
}

async function disconnect() {
  await WhatsAppIntegration.updateMany({ active: true }, { $set: { active: false } });
}

// Generates a fresh webhook secret for the active integration and saves it,
// invalidating the old one immediately. Used from the Integrations tab when
// an operator suspects a leak or has shared the webhook URL too widely.
async function rotateWebhookSecret() {
  const doc = await getActiveDoc();
  if (!doc) throw new Error(NOT_CONNECTED);
  doc.webhookSecret = crypto.randomBytes(24).toString("hex");
  await doc.save();
  return status(doc);
}

// Looked up by routes/wati.js to verify the shared secret on inbound webhook
// calls. Checks the secret directly against Mongo (not the request's own
// active-doc lookup) since a webhook call carries no other identifying info.
async function findBySecret(secret) {
  if (!secret) return null;
  return WhatsAppIntegration.findOne({ webhookSecret: secret, active: true });
}

function status(doc) {
  if (!doc) return { connected: false };
  return {
    connected: Boolean(doc.active),
    type: doc.type,
    endpoint: doc.apiEndpoint,
    channels: doc.channels.map((c) => ({ id: c.id, label: c.label || c.id })),
    webhookSecret: doc.webhookSecret,
  };
}

async function getStatus() {
  const doc = await getActiveDoc();
  return status(doc);
}

module.exports = {
  isConfigured,
  getChannels,
  getTemplates,
  sendMessage,
  connect,
  disconnect,
  rotateWebhookSecret,
  status: getStatus,
  findBySecret,
};
