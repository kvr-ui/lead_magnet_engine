import { useEffect, useMemo, useState } from "react";
import {
  fetchCampaigns,
  fetchCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  duplicateCampaign,
  fetchSegmentMembers,
  fetchTemplates,
  fetchChannels,
  previewCampaignSend,
  enrollCampaign,
  fetchEnrollments,
  fetchCampaignSources,
  fetchFilterFields,
  fetchActivitySummary,
} from "./api";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";
import FilterCondition, { buildMongoFilter, describeFilter } from "./FilterBuilder";
import { DeliveryFunnel, DeliveryCell, EnrollmentTimeline } from "./MessageDelivery";
import CampaignActivity from "./LeadActivity";
import FlowCanvas from "./FlowCanvas";

function humanizeKey(key) {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

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

/**
 * Preview/segment table columns for *any* source, built from what the backend
 * reports about that source rather than from a per-source list written here.
 *
 * Two inputs, in this order:
 *
 *   1. The canonical keys the campaign's source node maps (`phone`, `name`,
 *      whatever else it declared). These come first because they are the keys
 *      every downstream node addresses a lead by, so they are the ones an
 *      admin is actually reasoning about. Each reads the raw field the map
 *      points at, so the column header says "Phone" while the value comes off
 *      whatever the source calls it (`phoneNumber`, `mobile`, …).
 *   2. Every remaining field the source actually has, per
 *      /api/campaigns/meta/fields, minus the ones already shown as a canonical
 *      key so a column never appears twice under two names.
 *
 * There is no per-source special case and no hardcoded column list anywhere in
 * this file any more. Connecting a new lead-magnet database now renders its
 * columns with no code change, which is the failure this whole plan exists to
 * fix: previously a source with no hand-written entry rendered zero columns.
 */
function useSourceColumns(source, canonicalMap) {
  const [fields, setFields] = useState(null);

  useEffect(() => {
    if (!source) {
      setFields(null);
      return undefined;
    }
    let cancelled = false;
    setFields(null);
    fetchFilterFields(source)
      .then((d) => !cancelled && setFields(d.fields || []))
      // A source whose fields can't be read (disconnected, bad credentials)
      // still has to render its canonical columns rather than an empty table.
      .catch(() => !cancelled && setFields([]));
    return () => {
      cancelled = true;
    };
  }, [source]);

  // Keyed on the map's content, not its identity — it is rebuilt from the
  // campaign payload on every render and would otherwise recompute forever.
  const mapKey = JSON.stringify(canonicalMap || {});

  return useMemo(() => {
    if (!fields) return [];
    const canonical = Object.entries(JSON.parse(mapKey)).filter(([, field]) => field);
    const mapped = new Set(canonical.map(([, field]) => field));
    return [
      ...canonical.map(([key, field]) => ({
        key: `canonical:${key}`,
        header: humanizeKey(key),
        get: (doc) => doc[field],
      })),
      ...fields
        .filter((f) => !mapped.has(f.key))
        .map((f) => ({ key: f.key, header: f.label || f.key, get: (doc) => doc[f.key] })),
    ];
  }, [fields, mapKey]);
}

// --- Create campaign form ---------------------------------------------

function CreateCampaignForm({ sources, onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // Seeded from whatever the backend offers first rather than from a source
  // name written here, so this form has no opinion about which sources exist.
  const [targetModel, setTargetModel] = useState("");
  useEffect(() => {
    setTargetModel((current) => current || (sources[0] && sources[0].value) || "");
  }, [sources]);
  const [channelId, setChannelId] = useState("");
  // The flow being drawn on the canvas below, serialized straight into the
  // shape campaign.draft expects (see FlowCanvas.jsx) and posted as the new
  // campaign's initial draft on submit.
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [graphValid, setGraphValid] = useState(true);
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

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await createCampaign({
        name,
        description,
        targetModel,
        channelId,
        draft: graph,
      });
      onCreated();
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
        Target source
        <select value={targetModel} onChange={(e) => setTargetModel(e.target.value)}>
          {sources.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
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

      <h4>Flow</h4>
      <FlowCanvas sources={sources} onGraphChange={setGraph} onValidityChange={setGraphValid} />

      <div className="form-actions">
        <button type="submit" disabled={saving || !graphValid}>
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

function CampaignDetail({
  campaign,
  sourceLabels,
  sources,
  onClose,
  onChanged,
  onDuplicate,
  duplicating,
  // Global sending state, lifted to the app root (see App.jsx) and threaded
  // down through here. Not consumed by this component yet — a later task in
  // this plan places CampaignStatus (which does consume it) into this panel.
  // Aliased to an underscore-prefixed name because they're accepted, not
  // used, here.
  sendingEnabled: _sendingEnabled,
  sendingQueued: _sendingQueued,
  sendingBusy: _sendingBusy,
  onToggleSending: _onToggleSending,
}) {
  const [conditions, setConditions] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewedKey, setPreviewedKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [enrollResult, setEnrollResult] = useState(null);
  // Whether the send being set up should also arm auto-enroll. Seeded from the
  // campaign so re-sending an already-armed campaign doesn't silently disarm
  // it, and re-synced because the panel stays mounted across reloads.
  const [armAuto, setArmAuto] = useState(Boolean(campaign.autoEnroll));
  useEffect(() => setArmAuto(Boolean(campaign.autoEnroll)), [campaign._id, campaign.autoEnroll]);

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

  const [membersPage, setMembersPage] = useState(1);
  const [members, setMembers] = useState({ members: [], total: 0, totalPages: 1 });
  const [membersError, setMembersError] = useState(null);

  // The canonical field map feeding this campaign's preview table: the map on
  // The source node this panel reads through, and with it both the source id
  // and the canonical field map.
  //
  // The graph is the source of truth. A campaign has no `targetModel` field of
  // its own any more — the source moved onto the source node when campaigns
  // became graphs — so it is consulted only as a fallback, for rows written
  // before that change. A graph may hold several source nodes (one per lead
  // magnet); this panel shows the first, matching the legacy field when one is
  // there to match.
  const owningSourceNode = useMemo(() => {
    const sourceNodes = ((fullCampaign && fullCampaign.draft && fullCampaign.draft.nodes) || []).filter(
      (n) => n.kind === "source"
    );
    return sourceNodes.find((n) => n.config && n.config.sourceId === campaign.targetModel) || sourceNodes[0] || null;
  }, [fullCampaign, campaign.targetModel]);

  const sourceId =
    (owningSourceNode && owningSourceNode.config && owningSourceNode.config.sourceId) ||
    (campaign.sourceIds && campaign.sourceIds[0]) ||
    campaign.targetModel ||
    "";
  const canonicalMap = (owningSourceNode && owningSourceNode.config && owningSourceNode.config.map) || {};

  const columns = useSourceColumns(sourceId, canonicalMap);

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

  const filter = buildMongoFilter(conditions);
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    fetchEnrollments(campaign._id, statusFilter, page)
      .then(setEnrollments)
      .catch(() => {});
  }, [campaign._id, statusFilter, page, enrollResult]);

  useEffect(() => setMembersPage(1), [filterKey]);

  useEffect(() => {
    setMembersError(null);
    if (!sourceId) return;
    fetchSegmentMembers(sourceId, filter, membersPage)
      .then(setMembers)
      .catch((err) => setMembersError(err.message));
  }, [sourceId, filterKey, membersPage]);

  async function handlePreview() {
    setError(null);
    setBusy(true);
    try {
      const result = await previewCampaignSend(campaign._id, filter);
      setPreview(result);
      setPreviewedKey(filterKey);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleSend() {
    if (!preview) return;
    const confirmed = window.confirm(
      `Send "${campaign.name}" to ${preview.willEnroll} ${sourceLabels[sourceId] || sourceId || "leads"}?\n\n` +
        `${preview.matched} matched, ${preview.alreadyEnrolled} already enrolled, ` +
        `${preview.skippedNoPhone + preview.skippedBadPhone} skipped (no/invalid phone).` +
        (armAuto
          ? `\n\nAuto-enroll ON — this segment keeps running, so anyone matching it later joins automatically.`
          : "")
    );
    if (!confirmed) return;

    setError(null);
    setBusy(true);
    try {
      const result = await enrollCampaign(campaign._id, filter, armAuto);
      setEnrollResult(result);
      setPreview(null);
      setPreviewedKey(null);
      setConditions([]);
      // The stored segment shown below comes off the campaign document, so it
      // has to be refetched for arming to be visible without a page reload.
      if (armAuto) onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive() {
    await updateCampaign(campaign._id, { active: !campaign.active });
    onChanged();
  }

  async function disarmAuto() {
    setError(null);
    try {
      await updateCampaign(campaign._id, { autoEnroll: false });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  const enrollmentColumns = [
    { key: "phone", header: "Phone", get: (d) => d.phone },
    { key: "status", header: "Drip", get: (d) => d.status },
    // What WhatsApp reported back, as opposed to how far the drip got.
    { key: "delivery", header: "Delivery", get: (d) => <DeliveryCell delivery={d.delivery} /> },
    { key: "replied", header: "Replied", get: (d) => (d.delivery?.replied || d.delivery?.received ? "yes" : "") },
    // Where the lead is in the flow. A graph has no step numbers, so this
    // names the node instead of counting one off.
    { key: "currentNodeId", header: "Step", get: (d) => currentNodeLabel(d) },
    { key: "nextSendAt", header: "Next Send", get: (d) => (d.nextSendAt ? new Date(d.nextSendAt).toLocaleString() : "") },
    { key: "createdAt", header: "Enrolled", get: (d) => (d.createdAt ? new Date(d.createdAt).toLocaleString() : "") },
  ];

  return (
    <div className="panel">
      <div className="step-card-head">
        <h3>
          {campaign.name}{" "}
          <span className="muted">
            — {sourceLabels[sourceId] || sourceId || "no source yet"} · sends from{" "}
            {campaign.channelId ? campaign.channelId : "Default channel"}
          </span>
        </h3>
        <div>
          <button type="button" className="secondary-btn" onClick={toggleActive}>
            {campaign.active ? "Pause" : "Resume"}
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
      {!campaign.active && <p className="notice">Paused — enrolled contacts won't receive further messages until resumed.</p>}

      {campaign.autoEnroll && (
        <div className="notice">
          <strong>Auto-enroll is on.</strong> The source is rescanned every few minutes for{" "}
          <em>{describeFilter(campaign.autoEnrollFilter)}</em>, and anyone new who matches is enrolled and starts the
          flow.{" "}
          <button type="button" className="link-btn" onClick={disarmAuto}>
            turn off
          </button>
          <br />
          <span className="muted">
            {campaign.lastAutoEnrollError
              ? `Last check failed: ${campaign.lastAutoEnrollError}`
              : campaign.lastAutoEnrollAt
                ? `Last checked ${new Date(campaign.lastAutoEnrollAt).toLocaleString()} — added ${campaign.lastAutoEnrollCount || 0}.`
                : "Not checked yet."}
            {!campaign.active && " Paused, so rescanning is stopped too."}
          </span>
        </div>
      )}

      <h4>Flow</h4>
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

      <h4>Build a segment</h4>
      {conditions.map((c, i) => (
        <FilterCondition
          key={i}
          source={sourceId}
          condition={c}
          onChange={(next) => setConditions(conditions.map((cc, idx) => (idx === i ? next : cc)))}
          onRemove={() => setConditions(conditions.filter((_, idx) => idx !== i))}
        />
      ))}
      <button type="button" className="link-btn" onClick={() => setConditions([...conditions, { field: "", values: [] }])}>
        + add condition
      </button>
      {!conditions.length && <p className="muted">No conditions — sending will target everyone in this source.</p>}

      <h4>Matching members</h4>
      <Pager page={members.page || membersPage} totalPages={members.totalPages} total={members.total} onChange={setMembersPage} />
      <LeadsTable
        columns={columns}
        rows={members.members}
        loading={false}
        error={membersError}
      />

      {error && <p className="error">{error}</p>}

      <div className="form-actions">
        <button type="button" className="secondary-btn" onClick={handlePreview} disabled={busy}>
          Preview
        </button>
        <button type="button" onClick={handleSend} disabled={busy || previewedKey !== filterKey}>
          Send campaign
        </button>
        <label className="inline-check">
          <input type="checkbox" checked={armAuto} onChange={(e) => setArmAuto(e.target.checked)} />{" "}
          Keep this segment running
        </label>
      </div>
      <p className="muted">
        {armAuto
          ? "New matches in the source will join this campaign automatically — no need to send again."
          : "One-off send: only who matches right now is enrolled. Anyone added to the source later is not."}
      </p>

      {preview && previewedKey === filterKey && (
        <p className="muted">
          {preview.matched} matched · {preview.willEnroll} will be enrolled · {preview.alreadyEnrolled} already enrolled ·{" "}
          {preview.skippedNoPhone} skipped (no phone) · {preview.skippedBadPhone} skipped (invalid phone)
        </p>
      )}
      {previewedKey !== null && previewedKey !== filterKey && (
        <p className="muted">Segment changed — preview again before sending.</p>
      )}
      {enrollResult && (
        <p className="notice">
          Enrolled {enrollResult.enrolled} contacts. They'll start the flow on the next send cycle.
        </p>
      )}

      <h4>Delivery</h4>
      <DeliveryFunnel campaignId={campaign._id} refreshKey={enrollResult} />

      {/* Delivery stops at the handset. This is the question after it: once
          the message landed, did the lead actually go and use the product. */}
      <h4>Activity after this campaign</h4>
      <CampaignActivity campaignId={campaign._id} refreshKey={enrollResult} />

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
  );
}

// --- Top-level tab --------------------------------------------------------

export default function CampaignsTab({
  focusCampaignId = null,
  // Global sending kill switch, lifted to the app root (see App.jsx) so it is
  // fetched exactly once and shared with the header toggle. Threaded straight
  // through to CampaignDetail below, which does not consume it yet — a later
  // task in this plan places CampaignStatus (which does) into that panel.
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

  async function handleDelete(campaign) {
    // Spell out the enrollments going with it. The count is the whole reason
    // to hesitate — deleting a campaign mid-drip stops every lead in it.
    const counts = campaign.enrollments || {};
    const enrolled = Object.values(counts).reduce((n, v) => n + v, 0);
    const breakdown = Object.entries(counts)
      .filter(([, n]) => n)
      .map(([status, n]) => `${n} ${status}`)
      .join(", ");

    const warning = enrolled
      ? `Delete "${campaign.name}"? This also deletes its ${enrolled} enrollments (${breakdown}) — any lead still mid-drip stops receiving messages. Delivery history already recorded is kept. This cannot be undone.`
      : `Delete "${campaign.name}"? This cannot be undone.`;
    if (!window.confirm(warning)) return;

    setError(null);
    setDeletingId(campaign._id);
    try {
      await deleteCampaign(campaign._id);
      // The detail view would be showing a campaign that no longer exists.
      if (selectedId === campaign._id) setSelectedId(null);
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
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
              onCreated={() => {
                setShowCreate(false);
                reload();
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
                          handleDelete(c);
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
    </div>
  );
}
