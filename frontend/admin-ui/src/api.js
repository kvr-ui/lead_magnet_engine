// Not every response is JSON, even when it should be: a dead or restarting
// backend gives an empty body, and the dev proxy answers with plain text when
// it can't reach the API at all. Calling res.json() on those threw a raw
// "JSON.parse: unexpected end of data at line 1 column 1", which tells nobody
// anything. Read the body as text first and turn the non-JSON cases into a
// message that names the actual problem.
async function readBody(res) {
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.trim().slice(0, 300) };
  }
}

function bodyError(res, body) {
  if (body) return new Error(body.detail || body.error || `Request failed: ${res.status}`);
  return new Error(
    res.status === 0 || res.status >= 500
      ? `The server returned an empty response (${res.status || "no status"}). It may have crashed or be restarting — check the backend is running.`
      : `Request failed: ${res.status} ${res.statusText}`
  );
}

async function getJSON(url) {
  const res = await fetch(url);
  const body = await readBody(res);
  if (!res.ok || body === null) {
    const err = bodyError(res, body);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function sendJSON(method, url, data) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data ?? {}),
  });
  const body = await readBody(res);
  if (!res.ok || body === null) {
    const err = bodyError(res, body);
    // Some endpoints (e.g. data-source create with an ambiguous collection)
    // attach extra structured info to the error body — expose it so callers
    // can react beyond just the message.
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function fetchContacts(page, pageSize = 50) {
  return getJSON(`/api/contacts?limit=${pageSize}&page=${page}`);
}

export function fetchContactFields() {
  return getJSON("/api/contacts/fields");
}

// --- Drip campaigns ---------------------------------------------------

export function fetchCampaigns() {
  return getJSON("/api/campaigns");
}

export function fetchCampaign(id) {
  return getJSON(`/api/campaigns/${id}`);
}

export function createCampaign(body) {
  return sendJSON("POST", "/api/campaigns", body);
}

export function updateCampaign(id, body) {
  return sendJSON("PATCH", `/api/campaigns/${id}`, body);
}

export function fetchFilterFields(source) {
  return getJSON(`/api/campaigns/meta/fields?source=${encodeURIComponent(source)}`);
}

export function fetchFilterValues(source, field) {
  const params = new URLSearchParams({ source, field });
  return getJSON(`/api/campaigns/meta/values?${params.toString()}`);
}

export function previewCampaignSend(id, filter) {
  return sendJSON("POST", `/api/campaigns/${id}/preview`, { filter });
}

export function enrollCampaign(id, filter) {
  return sendJSON("POST", `/api/campaigns/${id}/enroll`, { filter });
}

export function fetchEnrollments(id, status = "", page = 1) {
  const params = new URLSearchParams({ page });
  if (status) params.set("status", status);
  return getJSON(`/api/campaigns/${id}/enrollments?${params.toString()}`);
}

// --- WhatsApp message tracking --------------------------------------
// Delivery state reported back by the WATI webhook. Separate from a
// campaign's enrollment counts, which only say how far the drip got — not
// whether anything actually reached the lead.

export function fetchCampaignDelivery(id) {
  return getJSON(`/api/campaigns/${id}/delivery`);
}

export function fetchEnrollmentEvents(enrollmentId) {
  return getJSON(`/api/enrollments/${enrollmentId}/events`);
}

// Manual single-number sends. Separate from campaign delivery because they
// have no campaign to belong to — but tracked the same way, so the same
// timeline renders for both.
export function fetchDirectMessages({ page = 1, phone = "" } = {}) {
  const params = new URLSearchParams({ page });
  if (phone) params.set("phone", phone);
  return getJSON(`/api/direct-messages?${params.toString()}`);
}

export function fetchDirectMessageEvents(id) {
  return getJSON(`/api/direct-messages/${id}/events`);
}

export function fetchMessageEvents({ page = 1, status = "", phone = "", campaign = "", linked = "" } = {}) {
  const params = new URLSearchParams({ page });
  if (status) params.set("status", status);
  if (phone) params.set("phone", phone);
  if (campaign) params.set("campaign", campaign);
  if (linked) params.set("linked", linked);
  return getJSON(`/api/message-events?${params.toString()}`);
}

export function fetchMessageEventStats() {
  return getJSON("/api/message-events/stats");
}

// Sent as a POST body rather than a query string: a filter is unbounded in
// size (an $in over a few hundred picked values is easily tens of KB) and
// as a URL it blew past the server's header limit, failing with
// "431 Request Header Fields Too Large" before the request was ever handled.
export function fetchSegmentMembers(source, filter, page = 1) {
  return sendJSON("POST", "/api/campaigns/meta/members", { source, page, filter: filter || {} });
}

export function fetchTemplates() {
  return getJSON("/api/campaigns/meta/templates");
}

export function fetchChannels() {
  return getJSON("/api/campaigns/meta/channels");
}

export function sendSingleMessage({ phone, templateId, providerMeta, channelId }) {
  return sendJSON("POST", "/api/campaigns/send-message", { phone, templateId, providerMeta, channelId });
}

// --- Generic lead-magnet data source connections ------------------------

export function discoverDataSourceDatabases({ mongoUri }) {
  return sendJSON("POST", "/api/data-sources/discover-databases", { mongoUri });
}

export function fetchDataSources() {
  return getJSON("/api/data-sources");
}

export function createDataSource(body) {
  return sendJSON("POST", "/api/data-sources", body);
}

export function updateDataSource(id, body) {
  return sendJSON("PATCH", `/api/data-sources/${id}`, body);
}

export function testDataSource(id) {
  return sendJSON("POST", `/api/data-sources/${id}/test`);
}

export function deleteDataSource(id) {
  return sendJSON("DELETE", `/api/data-sources/${id}`);
}

export function fetchDataSourceFields(id) {
  return getJSON(`/api/data-sources/${id}/fields`);
}

export function fetchRelatedCollections(id) {
  return getJSON(`/api/data-sources/${id}/related-collections`);
}

export function fetchRelatedCollectionFields(id, collectionName) {
  return getJSON(`/api/data-sources/${id}/related-collections/${encodeURIComponent(collectionName)}/fields`);
}

// POST for the same reason as fetchSegmentMembers — the filter goes in the
// body so its size is never bounded by the HTTP header limit.
export function fetchDataSourceDocuments(id, page, filter) {
  return sendJSON("POST", `/api/data-sources/${id}/documents`, { page, filter: filter || {} });
}

// --- Global sending kill switch ----------------------------------------

export function fetchSendingEnabled() {
  return getJSON("/api/settings/sending");
}

export function setSendingEnabled(enabled) {
  return sendJSON("POST", "/api/settings/sending", { enabled });
}

// --- WhatsApp provider integration -------------------------------------

export function fetchIntegrationStatus() {
  return getJSON("/api/integrations/whatsapp");
}

export function connectWhatsApp({ endpoint, token, channels }) {
  return sendJSON("POST", "/api/integrations/whatsapp/connect", { endpoint, token, channels });
}

export function disconnectWhatsApp() {
  return sendJSON("POST", "/api/integrations/whatsapp/disconnect");
}
