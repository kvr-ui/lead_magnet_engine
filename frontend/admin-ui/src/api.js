async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

async function sendJSON(method, url, data) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data ?? {}),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.detail || body.error || `Request failed: ${res.status}`);
  return body;
}

export function fetchAdMagnetStudents(page, search = "") {
  const params = new URLSearchParams({ page });
  if (search) params.set("search", search);
  return getJSON(`/api/ad-magnet/students?${params.toString()}`);
}

export function fetchAdMagnetStudentFields() {
  return getJSON("/api/ad-magnet/students/fields");
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
