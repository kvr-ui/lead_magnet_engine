import { useEffect, useMemo, useState } from "react";
import {
  fetchCampaigns,
  fetchCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  duplicateCampaign,
  fetchTemplates,
  fetchChannels,
  fetchEnrollments,
  fetchCampaignSources,
  fetchActivitySummary,
} from "./api";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";
import { DeliveryFunnel, DeliveryCell, EnrollmentTimeline } from "./MessageDelivery";
import CampaignActivity from "./LeadActivity";
import FlowCanvas from "./FlowCanvas";
import CampaignStatus from "./CampaignStatus";
import AudienceSendPanel from "./AudienceSendPanel";
import ConfirmDialog from "./ConfirmDialog";

/**
 * What to call a campaign's source in the list.
 *
 * `sourceIds` is what the backend reads off the campaign's graph — a campaign
 * has no single `targetModel` field any more, and a graph may feed from more
 * than one source, so this is a list. `targetModel` is only consulted for rows
 * written before campaigns became graphs. A campaign whose graph has no source
 * node yet says so rather than rendering an empty cell that reads as a bug.
 */
function campaignSourceLabel(campaign, sourceLabels) {
  const ids = campaign.sourceIds && campaign.sourceIds.length ? campaign.sourceIds : [campaign.targetModel];
  const named = ids.filter(Boolean).map((id) => sourceLabels[id] || id);
  if (!named.length) return <span className="muted">No source yet</span>;
  return named.join(", ");
}

// --- Create campaign form ---------------------------------------------

function CreateCampaignForm({ sources, onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Seeded from whatever the backend offers first rather than from a source
  // name written here, so this form has no opinion about which sources exist.
  // Where this campaign's leads come from - on submit this becomes a real
  // source node in the new campaign's draft graph (see handleSubmit) rather
  // than a campaign-level field, which nothing reads any more.
  const [sourceId, setSourceId] = useState("");
  useEffect(() => {
    setSourceId((current) => current || (sources[0] && sources[0].value) || "");
  }, [sources]);
  const [channelId, setChannelId] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState([]);
  const [channelsError, setChannelsError] = useState(null);
  const [providerConnected, setProviderConnected] = useState(true);

  useEffect(() => {
    // Only used here to detect whether a provider is connected at all - the
    // template list itself is fetched by FlowCanvas's own message node panel.
    fetchTemplates()
      .then((d) => {
        if (d.connected === false) setProviderConnected(false);
      })
      .catch(() => {});
    fetchChannels()
      .then((d) => {
        setChannels(d.channels);
        if (d.connected === false) setProviderConnected(false);
      })
      .catch((err) => setChannelsError(err.message));
  }, []);

  // The chosen source becomes the seed for the new campaign's graph: a
  // single source node, carrying the chosen source id in its config and
  // labelled with the source's display name, positioned near the top-left of
  // the canvas so it reads as the flow's starting point. Mirrors the node
  // shape FlowCanvas.jsx itself builds on drop (id/kind/label/position/config
  // - see its onDrop/toDomainGraph). It still needs a phone mapping and an
  // outgoing edge before it can be published or enrolled (graphValidation.js
  // / campaignTargets.js), which the validation panel surfaces the moment the
  // new campaign opens on its Flow tab - exactly the next step for the admin.
  function seedSourceNode() {
    const chosen = sources.find((s) => s.value === sourceId);
    return {
      id: `source-${Date.now().toString(36)}-seed`,
      kind: "source",
      label: (chosen && chosen.label) || sourceId,
      position: { x: 80, y: 80 },
      config: { sourceId },
    };
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const created = await createCampaign({
        name,
        description,
        channelId,
        draft: { nodes: [seedSourceNode()], edges: [] },
      });
      onCreated(created);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel panel-form" onSubmit={handleSubmit}>
      <h3>New campaign</h3>
      {error && <p className="error">{error}</p>}
      {!providerConnected && (
        <p className="error">No WhatsApp provider connected — connect one from the Integrations tab first.</p>
      )}

      <label className="form-row">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>

      <label className="form-row">
        Description
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>

      <label className="form-row">
        Send from (channel)
        {channelsError && <p className="error">{channelsError}</p>}
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
          <option value="">Pick a channel…</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="form-row">
        Leads from (source)
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          {sources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Create campaign"}
        </button>
        <button type="button" className="secondary-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- Campaign detail: filter, preview, send, enrollments -----------------

// The three sub-tabs a campaign's detail view is split into (task 5). Order
// here is also render order and chip order.
const DETAIL_TABS = [
  { id: "flow", label: "Flow" },
  { id: "audience", label: "Audience & Send" },
  { id: "results", label: "Results" },
];

// --- Stuck-leads rollup (task 24, #24) ------------------------------------
//
// The engine's contract is that a broken graph parks the enrollment
// (paused/failed) with a human-readable `statusReason` rather than throwing.
// The enrollments table below is paginated, so a rollup built from whatever
// page happens to be loaded would under-count and mislead — it has to walk
// every paused and every failed row itself. GET /campaigns/:id/enrollments
// makes that possible without a backend change: it takes a status filter and
// its `total` is an exact countDocuments, uncapped by page size. So this
// pages through status=paused and status=failed at the endpoint's own
// maximum page size (1000) and tallies statusReason across every row.
//
// ROLLUP_MAX_PAGES bounds how far it will page per status, purely so one
// pathological campaign can't turn a tab load into thousands of requests. In
// the (expected to be rare) case that bound is hit, `complete` comes back
// false and the UI says so rather than presenting a partial breakdown as the
// whole picture — the total count itself stays exact either way, since it
// comes from the endpoint's `total`, not from how many rows were fetched.
const ROLLUP_STATUSES = ["paused", "failed"];
const ROLLUP_PAGE_SIZE = 1000;
const ROLLUP_MAX_PAGES = 20;

async function fetchStuckLeadRollup(campaignId) {
  const counts = new Map(); // "status\u0000reason" -> count
  let total = 0;
  let complete = true;

  for (const status of ROLLUP_STATUSES) {
    let page = 1;
    let seen = 0;
    let statusTotal = 0;
    for (;;) {
      const res = await fetchEnrollments(campaignId, status, page, ROLLUP_PAGE_SIZE);
      if (page === 1) statusTotal = res.total || 0;
      const rows = res.enrollments || [];
      for (const e of rows) {
        const reason = (e.statusReason || "").trim() || "No reason recorded";
        const key = `${status}\u0000${reason}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      seen += rows.length;
      if (seen >= statusTotal || rows.length === 0) break;
      if (page >= ROLLUP_MAX_PAGES) {
        complete = false;
        break;
      }
      page += 1;
    }
    total += statusTotal;
  }

  const reasons = [...counts.entries()]
    .map(([key, count]) => {
      const [status, reason] = key.split("\u0000");
      return { status, reason, count };
    })
    .sort((a, b) => b.count - a.count);

  return { total, reasons, complete };
}

function CampaignDetail({
  campaign,
  sourceLabels,
  sources,
  onClose,
  onChanged,
  onDuplicate,
  duplicating,
  // Global sending kill switch, lifted to the app root (see App.jsx) and fed
  // straight into CampaignStatus below, which is what actually renders it —
  // this component just threads it through.
  sendingEnabled,
  sendingQueued,
  sendingBusy,
  onToggleSending,
}) {
  // Which sub-tab is showing. Only Flow needs "hide, don't unmount" treatment
  // (see below) — Audience & Send and Results hold no state of their own that
  // would be lost by unmounting; every piece of state they read lives here,
  // in this component, regardless of which tab is on screen.
  const [activeTab, setActiveTab] = useState("flow");
  const [flowDirty, setFlowDirty] = useState(false);

  // The last completed send, reported up by AudienceSendPanel. Kept here
  // rather than inside that panel because it is what the Results tab below
  // refreshes off: a send should immediately re-pull the delivery funnel, the
  // activity roll-up, the enrollments table and the stuck-lead breakdown.
  const [enrollResult, setEnrollResult] = useState(null);

  // The campaign list's row only carries nodeCount/versionCount (see
  // GET /api/campaigns) - the flow canvas below needs the actual draft graph
  // and the full versions[] (to know what's currently live), so those are
  // fetched separately, once per campaign shown.
  const [fullCampaign, setFullCampaign] = useState(null);
  const [graphError, setGraphError] = useState(null);
  useEffect(() => {
    setFullCampaign(null);
    fetchCampaign(campaign._id)
      .then(setFullCampaign)
      .catch((err) => setGraphError(err.message));
  }, [campaign._id]);

  const livePublished = useMemo(() => {
    if (!fullCampaign || fullCampaign.liveVersion === null || fullCampaign.liveVersion === undefined) {
      return { nodes: [], edges: [] };
    }
    const entry = (fullCampaign.versions || []).find((v) => v.version === fullCampaign.liveVersion);
    return entry ? { nodes: entry.nodes || [], edges: entry.edges || [] } : { nodes: [], edges: [] };
  }, [fullCampaign]);

  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [enrollments, setEnrollments] = useState({ enrollments: [], total: 0, totalPages: 1 });
  // The lead whose message timeline is open, if any.
  const [timelineFor, setTimelineFor] = useState(null);
  // Campaign-wide breakdown of why enrollments are stuck, independent of the
  // status filter/pager above (see fetchStuckLeadRollup) — null until the
  // first fetch resolves, so "no rollup yet" and "rollup says nothing is
  // stuck" (total === 0) are never conflated.
  const [stuckRollup, setStuckRollup] = useState(null);
  const [stuckRollupError, setStuckRollupError] = useState(null);

  // nodeId -> label for each published version, so an enrollment row can name
  // the node it is parked on. Keyed by version as well as by id because an
  // enrollment walks the version it entered on: the same node id can carry a
  // different label in a later version, and showing today's label for a lead
  // walking last week's graph would be a lie. Built from the campaign payload
  // already fetched for the canvas above — a flat id->label lookup, not a walk
  // of the graph, and no extra request.
  const labelByVersion = useMemo(() => {
    const out = new Map();
    for (const v of (fullCampaign && fullCampaign.versions) || []) {
      out.set(v.version, new Map((v.nodes || []).map((n) => [n.id, n.label || n.id])));
    }
    return out;
  }, [fullCampaign]);

  function currentNodeLabel(enrollment) {
    if (!enrollment.currentNodeId) return "";
    const byId = labelByVersion.get(enrollment.graphVersion);
    // Falls back to the raw id for a node deleted since, or for a version that
    // hasn't loaded yet — never to a number, which a graph has none of.
    return (byId && byId.get(enrollment.currentNodeId)) || enrollment.currentNodeId;
  }

  useEffect(() => {
    fetchEnrollments(campaign._id, statusFilter, page)
      .then(setEnrollments)
      .catch(() => {});
  }, [campaign._id, statusFilter, page, enrollResult]);

  // Refetched whenever the campaign changes or a new send lands (enrollResult)
  // — not on statusFilter/page, since this rollup describes the whole
  // campaign regardless of which slice of the table is showing.
  useEffect(() => {
    let cancelled = false;
    setStuckRollupError(null);
    fetchStuckLeadRollup(campaign._id)
      .then((r) => !cancelled && setStuckRollup(r))
      .catch((err) => !cancelled && setStuckRollupError(err.message));
    return () => {
      cancelled = true;
    };
  }, [campaign._id, enrollResult]);

  // Bug fix (task 5, #22): this used to fire-and-forget with no try/catch and
  // no in-flight state, so pausing a live campaign could fail silently — the
  // button just sat there looking clickable while nothing happened. Given the
  // same treatment: error surfaced, button disabled while the request is in
  // flight. A dedicated busy/error pair because this action lives in the
  // pinned header and has to report next to itself regardless of which sub-tab
  // is showing — an error paragraph inside Audience & Send would be invisible
  // from Results.
  const [toggleBusy, setToggleBusy] = useState(false);
  const [toggleError, setToggleError] = useState(null);

  async function toggleActive() {
    setToggleError(null);
    setToggleBusy(true);
    try {
      await updateCampaign(campaign._id, { active: !campaign.active });
      onChanged();
    } catch (err) {
      setToggleError(err.message);
    } finally {
      setToggleBusy(false);
    }
  }

  const enrollmentColumns = [
    { key: "phone", header: "Phone", get: (d) => d.phone },
    { key: "status", header: "Drip", get: (d) => d.status },
    // Why the engine parked this lead (statusReason) — blank for a lead that
    // is progressing normally. See fetchStuckLeadRollup above for where the
    // campaign-wide version of this same field is rolled up.
    { key: "statusReason", header: "Reason", get: (d) => d.statusReason || "" },
    // What WhatsApp reported back, as opposed to how far the drip got.
    { key: "delivery", header: "Delivery", get: (d) => <DeliveryCell delivery={d.delivery} /> },
    { key: "replied", header: "Replied", get: (d) => (d.delivery?.replied || d.delivery?.received ? "yes" : "") },
    // Where the lead is in the flow. A graph has no step numbers, so this
    // names the node instead of counting one off.
    { key: "currentNodeId", header: "Step", get: (d) => currentNodeLabel(d) },
    { key: "nextSendAt", header: "Next Send", get: (d) => (d.nextSendAt ? new Date(d.nextSendAt).toLocaleString() : "") },
    { key: "createdAt", header: "Enrolled", get: (d) => (d.createdAt ? new Date(d.createdAt).toLocaleString() : "") },
  ];

  // CampaignStatus (task 3) needs the full detail shape — active, autoEnroll,
  // liveVersion and every published version — to tell draft from published.
  // `fullCampaign` carries that once it loads; until then this falls back to
  // the list row, which has everything except `versions` (see GET
  // /api/campaigns), so the strip still renders sensibly on first paint
  // instead of waiting on a second fetch.
  const statusCampaign = fullCampaign || campaign;

  return (
    <div className="panel">
      {/* Pinned header: name, source/channel, the task-3 status strip, and the
          Pause/Duplicate/Close actions. Rendered unconditionally above the
          sub-tabs below, so it never moves when the active tab changes. */}
      <div className="step-card-head">
        <h3>
          {campaign.name}{" "}
          <span className="muted">
            {/* Every source the graph feeds from, not just the first: the
                header used to name a single one picked off the draft, which
                quietly under-reported a campaign fed by two lead magnets. */}
            — {campaignSourceLabel(campaign, sourceLabels)} · sends from{" "}
            {campaign.channelId ? campaign.channelId : "Default channel"}
          </span>
        </h3>
        <div>
          <button type="button" className="secondary-btn" onClick={toggleActive} disabled={toggleBusy}>
            {toggleBusy ? "Working…" : campaign.active ? "Pause" : "Resume"}
          </button>{" "}
          {/* Clones this flow into a new, unpublished campaign with no
              enrollments and auto-enroll off, then opens it — the "same
              nurture sequence, new lead magnet" path: duplicate, swap the
              source node, publish. */}
          <button type="button" className="secondary-btn" onClick={() => onDuplicate(campaign)} disabled={duplicating}>
            {duplicating ? "Duplicating…" : "Duplicate flow"}
          </button>{" "}
          <button type="button" className="secondary-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {campaign.description && <p className="muted">{campaign.description}</p>}
      {toggleError && <p className="error">{toggleError}</p>}

      {/* Replaces the old standalone paused notice and auto-enroll notice —
          both are now covered by this strip's badges and sentence, so they
          are not repeated below. */}
      <CampaignStatus
        campaign={statusCampaign}
        sourceLabels={sourceLabels}
        sendingEnabled={sendingEnabled}
        sendingQueued={sendingQueued}
        sendingBusy={sendingBusy}
        onToggleSending={onToggleSending}
      />

      <div className="chip-row">
        {DETAIL_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`chip ${activeTab === t.id ? "active" : ""}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
            {t.id === "flow" && flowDirty && (
              // FlowCanvas computes this as "differs from the last *published*
              // version", not "differs from the last save" — so a saved-but-
              // unpublished draft keeps the dot lit. Labelled for what it
              // actually tracks rather than for what it is not.
              <span
                className="campaign-subtab-dirty"
                title="The canvas differs from the live published version"
                aria-label="unpublished changes"
              />
            )}
          </button>
        ))}
      </div>

      {/* Flow sub-tab. Hidden with CSS instead of unmounted: the canvas holds
          the graph in its own local node/edge state, and unmounting it on a
          tab switch would silently throw away any unsaved edit — the exact
          data-loss bug this restructure has to avoid. */}
      <div className={activeTab === "flow" ? "campaign-subtab-panel" : "campaign-subtab-panel campaign-subtab-hidden"}>
        {graphError && <p className="error">{graphError}</p>}
        {fullCampaign ? (
          <FlowCanvas
            key={campaign._id}
            campaignId={campaign._id}
            initialNodes={(fullCampaign.draft && fullCampaign.draft.nodes) || []}
            initialEdges={(fullCampaign.draft && fullCampaign.draft.edges) || []}
            liveVersion={fullCampaign.liveVersion === undefined ? null : fullCampaign.liveVersion}
            publishedNodes={livePublished.nodes}
            publishedEdges={livePublished.edges}
            sources={sources}
            visible={activeTab === "flow"}
            onDirtyChange={setFlowDirty}
            onSaved={(updated) => {
              setFullCampaign(updated);
              onChanged();
            }}
            onPublished={(published) => {
              setFullCampaign((prev) =>
                prev && {
                  ...prev,
                  liveVersion: published.liveVersion,
                  versions: [
                    ...(prev.versions || []),
                    { version: published.version, nodes: published.nodes, edges: published.edges, publishedAt: published.publishedAt },
                  ],
                }
              );
              onChanged();
            }}
          />
        ) : (
          !graphError && <p className="muted">Loading flow…</p>
        )}
      </div>

      {activeTab === "audience" && (
        <div className="campaign-subtab-panel">
          <AudienceSendPanel
            campaign={campaign}
            fullCampaign={fullCampaign}
            sourceLabels={sourceLabels}
            onChanged={onChanged}
            onGoToTab={setActiveTab}
            onEnrolled={setEnrollResult}
            onPublished={(published) => {
              setFullCampaign((prev) =>
                prev && {
                  ...prev,
                  liveVersion: published.liveVersion,
                  versions: [
                    ...(prev.versions || []),
                    {
                      version: published.version,
                      nodes: published.nodes,
                      edges: published.edges,
                      publishedAt: published.publishedAt,
                    },
                  ],
                }
              );
              onChanged();
            }}
            sendingEnabled={sendingEnabled}
            sendingBusy={sendingBusy}
            onToggleSending={onToggleSending}
          />
        </div>
      )}

      {activeTab === "results" && (
        <div className="campaign-subtab-panel">
          <h4>Delivery</h4>
          <DeliveryFunnel campaignId={campaign._id} refreshKey={enrollResult} />

          {/* Delivery stops at the handset. This is the question after it:
              once the message landed, did the lead actually go and use the
              product. */}
          <h4>Activity after this campaign</h4>
          <CampaignActivity campaignId={campaign._id} refreshKey={enrollResult} />

          {/* Campaign-wide, not page-scoped -- see fetchStuckLeadRollup above for
              how that is achieved without a backend change. Renders nothing
              at all (not an empty box) once loaded if nothing is stuck. */}
          {stuckRollupError && (
            <p className="error">Could not load the stuck-leads breakdown: {stuckRollupError}</p>
          )}
          {stuckRollup && stuckRollup.total > 0 && (
            <div className="stuck-rollup">
              <h4>Why leads are stuck ({stuckRollup.total} paused or failed, campaign-wide)</h4>
              <ul className="stuck-rollup-list">
                {stuckRollup.reasons.map((r) => (
                  <li key={`${r.status} ${r.reason}`} className="stuck-rollup-row">
                    <span className={`badge ${r.status === "failed" ? "badge-danger" : "badge-warning"}`}>{r.count}</span>
                    <span className="stuck-rollup-reason">{r.reason}</span>
                    <span className="muted">({r.status})</span>
                  </li>
                ))}
              </ul>
              {!stuckRollup.complete && (
                <p className="muted">
                  This campaign has more paused/failed leads than the breakdown scanned ({ROLLUP_MAX_PAGES * ROLLUP_PAGE_SIZE} per
                  status) -- the {stuckRollup.total} total above is exact, but the reason counts below only cover what was
                  scanned, not every one of them.
                </p>
              )}
            </div>
          )}

          <h4>Enrollments</h4>
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option value="paused">Paused</option>
            <option value="cancelled">Cancelled</option>
            <option value="failed">Failed</option>
          </select>
          <Pager page={enrollments.page || page} totalPages={enrollments.totalPages} total={enrollments.total} onChange={setPage} />
          <p className="muted">Click a lead to see every message event recorded for them.</p>
          <LeadsTable
            columns={enrollmentColumns}
            rows={enrollments.enrollments}
            loading={false}
            error={null}
            onRowClick={setTimelineFor}
            activeRowId={timelineFor?._id}
          />
          {timelineFor && <EnrollmentTimeline enrollment={timelineFor} onClose={() => setTimelineFor(null)} />}
        </div>
      )}
    </div>
  );
}

// --- Top-level tab --------------------------------------------------------

export default function CampaignsTab({
  focusCampaignId = null,
  // Global sending kill switch, lifted to the app root (see App.jsx) so it is
  // fetched exactly once and shared with the header toggle. Threaded straight
  // through to CampaignDetail below, which feeds it to the CampaignStatus
  // strip in its pinned header.
  sendingEnabled = null,
  sendingQueued = 0,
  sendingBusy = false,
  onToggleSending,
}) {
  const [campaigns, setCampaigns] = useState([]);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  // Opens straight on one campaign when the tab was entered from a leads
  // tab's "Move to campaign", rather than on the campaign list.
  const [selectedId, setSelectedId] = useState(focusCampaignId);
  const [sources, setSources] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  // The campaign the delete-confirm dialog is up for, if any. Holding the
  // whole campaign (not just an id) means the dialog can render its
  // enrollment breakdown straight from the list row already in hand, with no
  // extra fetch.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [duplicatingId, setDuplicatingId] = useState(null);
  // Per-campaign activation rollup, read from the lead magnet's own database.
  // Its own request rather than part of /api/campaigns: it crosses to a
  // separate database, so a slow or unreachable lead magnet shouldn't hold up
  // the campaign list itself.
  const [activity, setActivity] = useState(null);

  // Returns the campaign list request so a caller that needs the refreshed list
  // before doing something else (duplicating, which then opens the clone) can
  // wait for it.
  function reload() {
    const campaignsLoaded = fetchCampaigns()
      .then((rows) => {
        setCampaigns(rows);
        return rows;
      })
      .catch((err) => {
        setError(err.message);
        return null;
      });
    fetchActivitySummary()
      .then(setActivity)
      .catch(() => setActivity(null));
    return campaignsLoaded;
  }

  // Clone a proven flow for a new lead magnet. The clone starts unpublished,
  // with no enrollments and auto-enroll off however the source was set up (see
  // POST /api/campaigns/:id/duplicate) — so opening it straight away, to swap
  // its source node before anything is published, is safe.
  async function handleDuplicate(campaign) {
    setError(null);
    setDuplicatingId(campaign._id);
    try {
      const clone = await duplicateCampaign(campaign._id);
      await reload();
      setSelectedId(clone._id);
    } catch (err) {
      setError(err.message);
    } finally {
      setDuplicatingId(null);
    }
  }

  // The count is the whole reason to hesitate over deleting — deleting a
  // campaign mid-drip stops every lead in it. Kept as a plain helper (rather
  // than inline in the dialog's JSX) so both the dialog body and the "no
  // enrollments" fallback below read off the same numbers.
  function deleteEnrollmentBreakdown(campaign) {
    const counts = (campaign && campaign.enrollments) || {};
    const total = Object.values(counts).reduce((n, v) => n + v, 0);
    const breakdown = Object.entries(counts).filter(([, n]) => n);
    return { total, breakdown };
  }

  async function confirmDelete() {
    const campaign = deleteTarget;
    if (!campaign) return;
    setError(null);
    setDeletingId(campaign._id);
    try {
      await deleteCampaign(campaign._id);
      // The detail view would be showing a campaign that no longer exists.
      if (selectedId === campaign._id) setSelectedId(null);
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
      setDeleteTarget(null);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  // The selectable sources come from the backend, which is the only thing that
  // knows what it can actually read: the built-in sources plus every connected,
  // active Data Source, each labeled with whatever the admin named it on the
  // Data Sources tab. Nothing here enumerates sources itself — a source the
  // backend stops reporting stops being offered, and a newly connected one
  // appears without a code change.
  useEffect(() => {
    fetchCampaignSources()
      .then((d) => setSources(d.sources || []))
      .catch(() => setSources([]));
  }, []);
  const sourceLabels = useMemo(() => Object.fromEntries(sources.map((s) => [s.value, s.label])), [sources]);

  const selected = campaigns.find((c) => c._id === selectedId);
  const { total: deleteEnrolledTotal, breakdown: deleteBreakdown } = deleteEnrollmentBreakdown(deleteTarget);

  return (
    <div>
      {error && <p className="error">{error}</p>}

      {!selected && (
        <>
          <button type="button" className="secondary-btn" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "Cancel" : "+ New campaign"}
          </button>

          {showCreate && (
            <CreateCampaignForm
              sources={sources}
              onCreated={(created) => {
                setShowCreate(false);
                // Land the admin on the new campaign's Flow tab (its default
                // sub-tab) with the seeded source node already on the canvas,
                // rather than back on the list - reload() first so `selected`
                // below can actually find the freshly created campaign.
                reload().then(() => setSelectedId(created._id));
              }}
              onCancel={() => setShowCreate(false)}
            />
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Source</th>
                  <th>Nodes</th>
                  <th>Status</th>
                  <th>Active</th>
                  <th>Completed</th>
                  <th>Failed</th>
                  {/* Reported by WhatsApp, not by the drip — a lead can be
                      "completed" and still never have received anything. */}
                  <th>Delivered</th>
                  <th>Read</th>
                  <th>Replied</th>
                  <th>Undelivered</th>
                  {/* Past delivery entirely: what leads did in the product
                      after being messaged. Each activated lead is credited to
                      one campaign only, so these columns don't double-count. */}
                  {activity?.configured && <th>Activated</th>}
                  {activity?.configured && <th>{activity.source?.noun || "Activity"} solved</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c._id} className="clickable-row" onClick={() => setSelectedId(c._id)}>
                    <td>{c.name}</td>
                    {/* Read off the graph's source node(s) by the backend —
                        a campaign has no single targetModel field any more. */}
                    <td>{campaignSourceLabel(c, sourceLabels)}</td>
                    {/* The draft graph's size, as counted by the backend
                        (GET /api/campaigns). There is no steps[] to measure
                        any more, and counting nodes here would mean shipping
                        every campaign's whole graph to render one cell. */}
                    <td>{c.nodeCount ?? 0}</td>
                    <td>
                      {c.active ? (
                        <span className="badge badge-success">Active</span>
                      ) : (
                        <span className="badge badge-neutral">Paused</span>
                      )}{" "}
                      {/* Whether the campaign keeps picking up new arrivals is
                          as much a part of its status as whether it's sending. */}
                      {c.autoEnroll && (
                        <span className="badge badge-info" title="New matches in the source are enrolled automatically">
                          Auto
                        </span>
                      )}
                    </td>
                    <td>{c.enrollments.active || 0}</td>
                    <td>{c.enrollments.completed || 0}</td>
                    <td>{c.enrollments.failed || 0}</td>
                    <td>{c.delivery?.delivered || 0}</td>
                    <td>{c.delivery?.read || 0}</td>
                    <td>{c.delivery?.replied || 0}</td>
                    <td>
                      {c.delivery?.failed ? (
                        <span className="badge badge-danger">{c.delivery.failed}</span>
                      ) : (
                        0
                      )}
                    </td>
                    {activity?.configured && (
                      <td>
                        {activity.campaigns[c._id]?.activated ? (
                          <span className="badge badge-success">{activity.campaigns[c._id].activated}</span>
                        ) : (
                          0
                        )}
                      </td>
                    )}
                    {activity?.configured && <td>{activity.campaigns[c._id]?.count || 0}</td>}
                    <td>
                      {/* The row opens the campaign, so the click must stop
                          here or these would also navigate into it. */}
                      <button
                        type="button"
                        className="link-btn"
                        disabled={duplicatingId === c._id}
                        title="Copy this flow into a new, unpublished campaign with no enrollments"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDuplicate(c);
                        }}
                      >
                        {duplicatingId === c._id ? "Duplicating…" : "Duplicate"}
                      </button>{" "}
                      <button
                        type="button"
                        className="link-btn danger"
                        disabled={deletingId === c._id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(c);
                        }}
                      >
                        {deletingId === c._id ? "Deleting…" : "Delete"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!campaigns.length && <p className="muted">No campaigns yet.</p>}
          </div>
        </>
      )}

      {selected && (
        <CampaignDetail
          campaign={selected}
          sourceLabels={sourceLabels}
          sources={sources}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
          onDuplicate={handleDuplicate}
          duplicating={duplicatingId === selected._id}
          sendingEnabled={sendingEnabled}
          sendingQueued={sendingQueued}
          sendingBusy={sendingBusy}
          onToggleSending={onToggleSending}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={`Delete "${deleteTarget.name}"?`}
          confirmLabel="Delete campaign"
          destructive
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        >
          {deleteEnrolledTotal ? (
            <>
              <p>
                This also deletes its {deleteEnrolledTotal} enrollment{deleteEnrolledTotal === 1 ? "" : "s"} — any
                lead still mid-drip stops receiving messages. Delivery history already recorded is kept. This
                cannot be undone.
              </p>
              <dl className="detail-grid">
                {deleteBreakdown.map(([status, n]) => (
                  <div className="detail-row" key={status}>
                    <dt>{status}</dt>
                    <dd>{n}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p>This cannot be undone.</p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
