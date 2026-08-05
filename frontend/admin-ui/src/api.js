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

// Removes the campaign and its enrollments. The delivery events already
// recorded for it are kept.
export function deleteCampaign(id) {
  return sendJSON("DELETE", `/api/campaigns/${id}`);
}

// Every source a campaign can target, as the backend reports it: the built-in
// ones plus every connected, active Data Source. The picker renders this
// verbatim — there is deliberately no frontend-side list of sources to fall
// back on, because that list is exactly what stopped a newly connected
// lead-magnet database from being selectable without a code change.
export function fetchCampaignSources() {
  return getJSON("/api/campaigns/meta/sources");
}

export function fetchFilterFields(source) {
  return getJSON(`/api/campaigns/meta/fields?source=${encodeURIComponent(source)}`);
}

// `filter` narrows the counts to the segment being built, so the values offered
// for one condition are counted within what the other conditions already
// select. Posted rather than sent as a query string for the same reason the
// members call is: a filter with a long $in list overflows the header limit and
// comes back 431.
export function fetchFilterValues(source, field, filter = {}) {
  return sendJSON("POST", "/api/campaigns/meta/values", { source, field, filter });
}

// Neither of these takes a filter any more, and passing one is not merely
// redundant — the endpoint rejects it (see assertNoBodyFilter in
// routes/campaigns.js). Since campaigns became graphs, who gets enrolled is
// the union of every source node's own `config.filter` on the *published*
// version, so the only thing the caller can still decide is whether to arm
// auto-enroll. Both resolve the live version server-side, which is why the
// campaign id is the whole request.
export function previewCampaignSend(id) {
  return sendJSON("POST", `/api/campaigns/${id}/preview`, {});
}

// autoEnroll stores the segment this run confirmed as the campaign's standing
// one, so the backend keeps re-running it and targets added to a source later
// still join the drip instead of needing another manual send.
export function enrollCampaign(id, autoEnroll = false) {
  return sendJSON("POST", `/api/campaigns/${id}/enroll`, { autoEnroll });
}

// `limit` is optional and defaults to whatever the endpoint defaults to
// (100). The stuck-leads rollup (task 24, #24) passes the endpoint's own
// page-size cap (1000) explicitly so it can walk every paused/failed
// enrollment in as few requests as possible.
export function fetchEnrollments(id, status = "", page = 1, limit = null) {
  const params = new URLSearchParams({ page });
  if (status) params.set("status", status);
  if (limit) params.set("limit", limit);
  return getJSON(`/api/campaigns/${id}/enrollments?${params.toString()}`);
}

// POST /api/campaigns/:id/publish - snapshot the campaign's current draft as
// a new version and point liveVersion at it.
export function publishCampaign(id) {
  return sendJSON("POST", `/api/campaigns/${id}/publish`);
}

// GET /api/campaigns/:id/versions - publish history (counts only; the full
// nodes/edges of a version come off GET /api/campaigns/:id).
export function fetchCampaignVersions(id) {
  return getJSON(`/api/campaigns/${id}/versions`);
}

// POST /api/campaigns/:id/duplicate - clone this campaign's draft graph into a
// new, unpublished campaign with no enrollments and auto-enroll off. Returns
// the new campaign, so the caller can open it and swap its source node.
export function duplicateCampaign(id, body) {
  return sendJSON("POST", `/api/campaigns/${id}/duplicate`, body || {});
}

// --- Node presets (reusable node configurations) -------------------------
//
// A preset is copied into a campaign's graph when it is inserted, never linked
// to it: editing one below changes what the *next* insertion produces and
// nothing already on any canvas. See backend models/NodePreset.js.

export function fetchNodePresets(kind) {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return getJSON(`/api/node-presets${qs}`);
}

export function createNodePreset({ name, kind, config }) {
  return sendJSON("POST", "/api/node-presets", { name, kind, config });
}

export function updateNodePreset(id, body) {
  return sendJSON("PATCH", `/api/node-presets/${id}`, body);
}

export function deleteNodePreset(id) {
  return sendJSON("DELETE", `/api/node-presets/${id}`);
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

// Everything behind one send: the lead record, the campaign, and the events.
export function fetchEnrollmentDetail(enrollmentId) {
  return getJSON(`/api/enrollments/${enrollmentId}`);
}

export function fetchDirectMessageDetail(id) {
  return getJSON(`/api/direct-messages/${id}`);
}

// Every send, campaign and manual alike, in one feed. kind narrows it to one
// or the other; phone is a substring match.
export function fetchSends({ page = 1, phone = "", kind = "" } = {}) {
  const params = new URLSearchParams({ page });
  if (phone) params.set("phone", phone);
  if (kind) params.set("kind", kind);
  return getJSON(`/api/sends?${params.toString()}`);
}

// --- Lead activity (what leads did after we messaged them) ---------------
// The step past delivery: delivery says the message landed, this says whether
// the lead then went and used the product. Read live from the lead magnet's
// own database — see backend lib/leadActivity.js.

export function fetchCampaignActivity(id, windowHours) {
  const params = new URLSearchParams();
  if (windowHours !== undefined && windowHours !== "") params.set("windowHours", windowHours);
  const qs = params.toString();
  return getJSON(`/api/campaigns/${id}/activity${qs ? `?${qs}` : ""}`);
}

// Every question one lead answered after this campaign messaged them — the
// wording, what they picked, what was right. Scoped to the same window as the
// row it expands, so the questions listed match the count shown.
export function fetchCampaignLeadActivity(id, leadKey, windowHours) {
  const params = new URLSearchParams();
  if (windowHours !== undefined && windowHours !== "") params.set("windowHours", windowHours);
  const qs = params.toString();
  return getJSON(`/api/campaigns/${id}/activity/${encodeURIComponent(leadKey)}${qs ? `?${qs}` : ""}`);
}

// Per-campaign rollup for the campaign list, each activated lead credited to
// exactly one campaign so the columns don't overlap.
export function fetchActivitySummary(windowHours) {
  const params = new URLSearchParams();
  if (windowHours !== undefined && windowHours !== "") params.set("windowHours", windowHours);
  const qs = params.toString();
  return getJSON(`/api/activity/summary${qs ? `?${qs}` : ""}`);
}

export function fetchActivitySource() {
  return getJSON("/api/activity/source");
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
// phoneField names the raw field this source keeps phone numbers in (the
// canonical `phone` key off the source node's map). Passing it opts each row
// into a `_sessionWindow` annotation — whether that number can still be sent a
// free-typed message. Omitted, the response is exactly what it was before.
export function fetchSegmentMembers(source, filter, page = 1, phoneField = "") {
  return sendJSON("POST", "/api/campaigns/meta/members", {
    source,
    page,
    filter: filter || {},
    ...(phoneField ? { phoneField } : {}),
  });
}

// Everyone who can still be sent a free-typed message — derived from inbound
// events, so it needs no arguments: the window belongs to the phone number.
export function fetchSessionWindows() {
  return getJSON("/api/session-windows");
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
