import { useEffect, useMemo, useState } from "react";
import {
  fetchCampaigns,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  fetchSegmentMembers,
  fetchTemplates,
  fetchChannels,
  previewCampaignSend,
  enrollCampaign,
  fetchEnrollments,
  fetchDataSources,
  fetchDataSourceFields,
  fetchActivitySummary,
} from "./api";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";
import FilterCondition, { buildMongoFilter } from "./FilterBuilder";
import { DeliveryFunnel, DeliveryCell, EnrollmentTimeline } from "./MessageDelivery";
import CampaignActivity from "./LeadActivity";

const DYNAMIC_PREFIX = "datasource:";

const STATIC_SOURCES = ["Contact", "Lead"];
const STATIC_SOURCE_LABELS = { Contact: "Zoho Contacts", Lead: "Lead Magnet Leads" };

const STATIC_SOURCE_COLUMNS = {
  Contact: [
    { key: "name", header: "Name", get: (d) => d.name },
    { key: "phone", header: "Phone", get: (d) => d.phone },
    { key: "caStatus", header: "CA Level", get: (d) => d.caStatus },
    { key: "city", header: "City", get: (d) => d.city },
    { key: "status", header: "Status", get: (d) => d.status },
  ],
  Lead: [
    { key: "name", header: "Name", get: (d) => d.name },
    { key: "phone", header: "Phone", get: (d) => d.phone },
    { key: "email", header: "Email", get: (d) => d.email },
    { key: "leadMagnet", header: "Lead Magnet", get: (d) => d.leadMagnet },
  ],
};

function emptyStep() {
  return { templateId: "", broadcastName: "" };
}

function toApiStep(step) {
  return { templateId: step.templateId, providerMeta: { broadcastName: step.broadcastName } };
}

// --- Create campaign form ---------------------------------------------

function CreateCampaignForm({ sources, onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetModel, setTargetModel] = useState("Contact");
  const [channelId, setChannelId] = useState("");
  const [steps, setSteps] = useState([emptyStep()]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templatesError, setTemplatesError] = useState(null);
  const [channels, setChannels] = useState([]);
  const [channelsError, setChannelsError] = useState(null);
  const [providerConnected, setProviderConnected] = useState(true);

  useEffect(() => {
    fetchTemplates()
      .then((d) => {
        setTemplates(d.templates);
        if (d.connected === false) setProviderConnected(false);
      })
      .catch((err) => setTemplatesError(err.message));
    fetchChannels()
      .then((d) => {
        setChannels(d.channels);
        if (d.connected === false) setProviderConnected(false);
      })
      .catch((err) => setChannelsError(err.message));
  }, []);

  function updateStep(i, patch) {
    setSteps(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

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
        steps: steps.map(toApiStep),
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

      <h4>Steps</h4>
      {steps.map((step, i) => (
        <div className="step-card" key={i}>
          <div className="step-card-head">
            <strong>Step {i + 1}</strong>
            {steps.length > 1 && (
              <button type="button" className="link-btn" onClick={() => setSteps(steps.filter((_, idx) => idx !== i))}>
                remove
              </button>
            )}
          </div>

          <label className="form-row">
            Template name
            {templatesError && <p className="error">{templatesError}</p>}
            <select
              value={step.templateId}
              onChange={(e) => updateStep(i, { templateId: e.target.value })}
              required
            >
              <option value="">Pick a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id}
                </option>
              ))}
            </select>
          </label>

          <label className="form-row">
            Broadcast name
            <input value={step.broadcastName} onChange={(e) => updateStep(i, { broadcastName: e.target.value })} required />
          </label>
        </div>
      ))}
      <button type="button" className="secondary-btn" onClick={() => setSteps([...steps, emptyStep()])}>
        + add step
      </button>

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

function CampaignDetail({ campaign, sourceLabels, onClose, onChanged }) {
  const [conditions, setConditions] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewedKey, setPreviewedKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [enrollResult, setEnrollResult] = useState(null);

  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [enrollments, setEnrollments] = useState({ enrollments: [], total: 0, totalPages: 1 });
  // The lead whose message timeline is open, if any.
  const [timelineFor, setTimelineFor] = useState(null);

  const [membersPage, setMembersPage] = useState(1);
  const [members, setMembers] = useState({ members: [], total: 0, totalPages: 1 });
  const [membersError, setMembersError] = useState(null);

  const [dynamicColumns, setDynamicColumns] = useState(null);
  useEffect(() => {
    if (!campaign.targetModel.startsWith(DYNAMIC_PREFIX)) {
      setDynamicColumns(null);
      return;
    }
    const id = campaign.targetModel.slice(DYNAMIC_PREFIX.length);
    fetchDataSourceFields(id)
      .then((d) =>
        setDynamicColumns(d.fields.map((f) => ({ key: f.key, header: f.label || f.key, get: (doc) => doc[f.key] })))
      )
      .catch(() => setDynamicColumns([]));
  }, [campaign.targetModel]);
  const columns = campaign.targetModel.startsWith(DYNAMIC_PREFIX) ? dynamicColumns || [] : STATIC_SOURCE_COLUMNS[campaign.targetModel];

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
    fetchSegmentMembers(campaign.targetModel, filter, membersPage)
      .then(setMembers)
      .catch((err) => setMembersError(err.message));
  }, [campaign.targetModel, filterKey, membersPage]);

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
      `Send "${campaign.name}" to ${preview.willEnroll} ${sourceLabels[campaign.targetModel] || campaign.targetModel}?\n\n` +
        `${preview.matched} matched, ${preview.alreadyEnrolled} already enrolled, ` +
        `${preview.skippedNoPhone + preview.skippedBadPhone} skipped (no/invalid phone).`
    );
    if (!confirmed) return;

    setError(null);
    setBusy(true);
    try {
      const result = await enrollCampaign(campaign._id, filter);
      setEnrollResult(result);
      setPreview(null);
      setPreviewedKey(null);
      setConditions([]);
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

  const enrollmentColumns = [
    { key: "phone", header: "Phone", get: (d) => d.phone },
    { key: "status", header: "Drip", get: (d) => d.status },
    // What WhatsApp reported back, as opposed to how far the drip got.
    { key: "delivery", header: "Delivery", get: (d) => <DeliveryCell delivery={d.delivery} /> },
    { key: "replied", header: "Replied", get: (d) => (d.delivery?.replied || d.delivery?.received ? "yes" : "") },
    { key: "currentStepIndex", header: "Step", get: (d) => d.currentStepIndex + 1 },
    { key: "nextSendAt", header: "Next Send", get: (d) => (d.nextSendAt ? new Date(d.nextSendAt).toLocaleString() : "") },
    { key: "createdAt", header: "Enrolled", get: (d) => (d.createdAt ? new Date(d.createdAt).toLocaleString() : "") },
  ];

  return (
    <div className="panel">
      <div className="step-card-head">
        <h3>
          {campaign.name}{" "}
          <span className="muted">
            — {sourceLabels[campaign.targetModel] || campaign.targetModel} · sends from{" "}
            {campaign.channelId ? campaign.channelId : "Default channel"}
          </span>
        </h3>
        <div>
          <button type="button" className="secondary-btn" onClick={toggleActive}>
            {campaign.active ? "Pause" : "Resume"}
          </button>{" "}
          <button type="button" className="secondary-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {campaign.description && <p className="muted">{campaign.description}</p>}
      {!campaign.active && <p className="notice">Paused — enrolled contacts won't receive further messages until resumed.</p>}

      <h4>Build a segment</h4>
      {conditions.map((c, i) => (
        <FilterCondition
          key={i}
          source={campaign.targetModel}
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
      </div>

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
          Enrolled {enrollResult.enrolled} contacts. They'll be sent step 1 on the next send cycle.
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

export default function CampaignsTab({ focusCampaignId = null }) {
  const [campaigns, setCampaigns] = useState([]);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  // Opens straight on one campaign when the tab was entered from a leads
  // tab's "Move to campaign", rather than on the campaign list.
  const [selectedId, setSelectedId] = useState(focusCampaignId);
  const [dataSources, setDataSources] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  // Per-campaign activation rollup, read from the lead magnet's own database.
  // Its own request rather than part of /api/campaigns: it crosses to a
  // separate database, so a slow or unreachable lead magnet shouldn't hold up
  // the campaign list itself.
  const [activity, setActivity] = useState(null);

  function reload() {
    fetchCampaigns()
      .then(setCampaigns)
      .catch((err) => setError(err.message));
    fetchActivitySummary()
      .then(setActivity)
      .catch(() => setActivity(null));
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

  useEffect(reload, []);
  useEffect(() => {
    fetchDataSources()
      .then(setDataSources)
      .catch(() => setDataSources([]));
  }, []);

  // Every connected, active Data Source is a valid campaign target alongside
  // the two built-in sources — labeled with whatever the admin named it on
  // the Data Sources tab, so it's identifiable here instead of a generic
  // bucket name.
  const sources = useMemo(
    () => [
      ...STATIC_SOURCES.map((s) => ({ value: s, label: STATIC_SOURCE_LABELS[s] })),
      ...dataSources.filter((ds) => ds.active).map((ds) => ({ value: `${DYNAMIC_PREFIX}${ds._id}`, label: ds.label })),
    ],
    [dataSources]
  );
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
                  <th>Steps</th>
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
                    <td>{sourceLabels[c.targetModel] || c.targetModel}</td>
                    <td>{c.steps.length}</td>
                    <td>
                      {c.active ? (
                        <span className="badge badge-success">Active</span>
                      ) : (
                        <span className="badge badge-neutral">Paused</span>
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
                          here or deleting would also navigate into it. */}
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
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}
