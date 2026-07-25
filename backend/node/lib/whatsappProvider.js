/**
 * The WhatsApp provider "node" — the only thing campaignEngine.js and
 * routes/campaigns.js talk to. Loads the active WhatsAppIntegration doc from
 * Mongo on each call (send volume is low, no need to cache) and dispatches
 * to the adapter matching its `type`. Today only "wati" exists; adding a
 * provider later means a new adapter module + a new `type` value here, not
 * a rewrite of the campaign/route layer.
 */
const WhatsAppIntegration = require("../models/WhatsAppIntegration");
const { encrypt, decrypt } = require("./crypto");
const wati = require("./watiClient");

const NOT_CONNECTED = "No WhatsApp provider connected — connect one from the Integrations tab";

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

async function sendMessage({ phone, templateId, params, channelId, meta }) {
  const doc = await getActiveDoc();
  if (!doc) throw new Error(NOT_CONNECTED);
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
      },
    },
    { upsert: true, returnDocument: "after" }
  );
  return status(doc);
}

async function disconnect() {
  await WhatsAppIntegration.updateMany({ active: true }, { $set: { active: false } });
}

function status(doc) {
  if (!doc) return { connected: false };
  return {
    connected: Boolean(doc.active),
    type: doc.type,
    endpoint: doc.apiEndpoint,
    channels: doc.channels.map((c) => ({ id: c.id, label: c.label || c.id })),
  };
}

async function getStatus() {
  const doc = await getActiveDoc();
  return status(doc);
}

module.exports = { isConfigured, getChannels, getTemplates, sendMessage, connect, disconnect, status: getStatus };
