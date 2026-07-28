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

export function fetchSegmentMembers(source, filter, page = 1) {
  const params = new URLSearchParams({ source, page, filter: JSON.stringify(filter || {}) });
  return getJSON(`/api/campaigns/meta/members?${params.toString()}`);
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

export function fetchDataSourceDocuments(id, page, filter) {
  const params = new URLSearchParams({ page, filter: JSON.stringify(filter || {}) });
  return getJSON(`/api/data-sources/${id}/documents?${params.toString()}`);
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
