import { useEffect, useState } from "react";
import {
  fetchCampaigns,
  createCampaign,
  updateCampaign,
  fetchFilterFields,
  fetchFilterValues,
  fetchSegmentMembers,
  fetchTemplates,
  fetchChannels,
  previewCampaignSend,
  enrollCampaign,
  fetchEnrollments,
  sendSingleMessage,
} from "./api";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";

const SOURCES = ["Contact", "Lead", "AdMagnetStudent"];
const SOURCE_LABELS = { Contact: "Zoho Contacts", Lead: "Lead Magnet Leads", AdMagnetStudent: "CA Guru Students" };

const SOURCE_COLUMNS = {
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
  AdMagnetStudent: [
    { key: "name", header: "Name", get: (d) => d.name },
    { key: "phoneNumber", header: "Phone", get: (d) => d.phoneNumber },
    { key: "email", header: "Email", get: (d) => d.email },
    { key: "city", header: "City", get: (d) => d.city },
    { key: "caLevel", header: "CA Level", get: (d) => d.caLevel },
  ],
};

function emptyStep() {
  return { templateName: "", broadcastName: "" };
}

// --- Create campaign form ---------------------------------------------

function CreateCampaignForm({ onCreated, onCancel }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetModel, setTargetModel] = useState("Contact");
  const [channelNumber, setChannelNumber] = useState("");
  const [steps, setSteps] = useState([emptyStep()]);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templatesError, setTemplatesError] = useState(null);
  const [channels, setChannels] = useState([]);
  const [channelsError, setChannelsError] = useState(null);

  useEffect(() => {
    fetchTemplates()
      .then((d) => setTemplates(d.templates))
      .catch((err) => setTemplatesError(err.message));
    fetchChannels()
      .then((d) => setChannels(d.channels))
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
        channelNumber,
        steps,
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <h3>New campaign</h3>
      {error && <p className="error">{error}</p>}

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
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="form-row">
        Send from (WhatsApp number)
        {channelsError && <p className="error">{channelsError}</p>}
        <select value={channelNumber} onChange={(e) => setChannelNumber(e.target.value)} required>
          <option value="">Pick a number…</option>
          {channels.map((c) => (
            <option key={c.number} value={c.number}>
              {c.name}
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
            WATI template name
            {templatesError && <p className="error">{templatesError}</p>}
            <select
              value={step.templateName}
              onChange={(e) => updateStep(i, { templateName: e.target.value })}
              required
            >
              <option value="">Pick a template…</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <label className="form-row">
            WATI broadcast name
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

// --- Send to a single number --------------------------------------------

function SendToNumberForm() {
  const [phone, setPhone] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [broadcastName, setBroadcastName] = useState("");
  const [channelNumber, setChannelNumber] = useState("");
  const [templates, setTemplates] = useState([]);
  const [channels, setChannels] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchTemplates()
      .then((d) => setTemplates(d.templates))
      .catch(() => {});
    fetchChannels()
      .then((d) => setChannels(d.channels))
      .catch(() => {});
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      await sendSingleMessage({ phone, templateName, broadcastName, channelNumber });
      setResult(`Sent to ${phone}.`);
      setPhone("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <h3>Send to a single number</h3>
      <div className="condition-row">
        <select value={templateName} onChange={(e) => setTemplateName(e.target.value)} required>
          <option value="">Pick a template…</option>
          {templates.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Broadcast name"
          value={broadcastName}
          onChange={(e) => setBroadcastName(e.target.value)}
          required
        />
        <select value={channelNumber} onChange={(e) => setChannelNumber(e.target.value)}>
          <option value="">Pick a number…</option>
          {channels.map((c) => (
            <option key={c.number} value={c.number}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          placeholder="Mobile number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
        <button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {result && <p className="notice">{result}</p>}
    </form>
  );
}

// --- Filter builder -----------------------------------------------------

function FilterCondition({ source, condition, onChange, onRemove }) {
  const [fields, setFields] = useState([]);
  const [values, setValues] = useState([]);
  const [loadingValues, setLoadingValues] = useState(false);

  useEffect(() => {
    fetchFilterFields(source)
      .then((d) => setFields(d.fields))
      .catch(() => setFields([]));
  }, [source]);

  useEffect(() => {
    if (!condition.field) {
      setValues([]);
      return;
    }
    setLoadingValues(true);
    fetchFilterValues(source, condition.field)
      .then((d) => setValues(d.values))
      .catch(() => setValues([]))
      .finally(() => setLoadingValues(false));
  }, [source, condition.field]);

  function toggleValue(v) {
    const selected = condition.values.includes(v)
      ? condition.values.filter((x) => x !== v)
      : [...condition.values, v];
    onChange({ ...condition, values: selected });
  }

  return (
    <div className="condition-row">
      <select
        value={condition.field}
        onChange={(e) => onChange({ field: e.target.value, values: [] })}
      >
        <option value="">Pick a field…</option>
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>

      {condition.field && (
        <div className="value-chip-row">
          {loadingValues && <span className="muted">Loading values…</span>}
          {!loadingValues && !values.length && <span className="muted">No values found for this field.</span>}
          {values.map((v) => (
            <button
              type="button"
              key={String(v.value)}
              className={`chip ${condition.values.includes(v.value) ? "active" : ""}`}
              onClick={() => toggleValue(v.value)}
            >
              {String(v.value) || "(blank)"} ({v.count})
            </button>
          ))}
        </div>
      )}

      <button type="button" className="link-btn" onClick={onRemove}>
        remove condition
      </button>
    </div>
  );
}

function buildMongoFilter(conditions) {
  const filter = {};
  for (const c of conditions) {
    if (c.field && c.values.length) filter[c.field] = { $in: c.values };
  }
  return filter;
}

// --- Campaign detail: filter, preview, send, enrollments -----------------

function CampaignDetail({ campaign, onClose, onChanged }) {
  const [conditions, setConditions] = useState([]);
  const [preview, setPreview] = useState(null);
  const [previewedKey, setPreviewedKey] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [enrollResult, setEnrollResult] = useState(null);

  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [enrollments, setEnrollments] = useState({ enrollments: [], total: 0, totalPages: 1 });

  const [membersPage, setMembersPage] = useState(1);
  const [members, setMembers] = useState({ members: [], total: 0, totalPages: 1 });
  const [membersError, setMembersError] = useState(null);

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
      `Send "${campaign.name}" to ${preview.willEnroll} ${SOURCE_LABELS[campaign.targetModel]}?\n\n` +
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
    { key: "status", header: "Status", get: (d) => d.status },
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
            — {SOURCE_LABELS[campaign.targetModel]} · sends from {campaign.channelNumber ? campaign.channelNumber : "Default number"}
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
        columns={SOURCE_COLUMNS[campaign.targetModel]}
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
      <LeadsTable columns={enrollmentColumns} rows={enrollments.enrollments} loading={false} error={null} />
    </div>
  );
}

// --- Top-level tab --------------------------------------------------------

export default function CampaignsTab() {
  const [campaigns, setCampaigns] = useState([]);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  function reload() {
    fetchCampaigns()
      .then(setCampaigns)
      .catch((err) => setError(err.message));
  }

  useEffect(reload, []);

  const selected = campaigns.find((c) => c._id === selectedId);

  return (
    <div>
      {error && <p className="error">{error}</p>}

      {!selected && (
        <>
          <SendToNumberForm />

          <button type="button" className="secondary-btn" onClick={() => setShowCreate(!showCreate)}>
            {showCreate ? "Cancel" : "+ New campaign"}
          </button>

          {showCreate && (
            <CreateCampaignForm
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
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c._id} className="clickable-row" onClick={() => setSelectedId(c._id)}>
                    <td>{c.name}</td>
                    <td>{SOURCE_LABELS[c.targetModel]}</td>
                    <td>{c.steps.length}</td>
                    <td>{c.active ? "active" : "paused"}</td>
                    <td>{c.enrollments.active || 0}</td>
                    <td>{c.enrollments.completed || 0}</td>
                    <td>{c.enrollments.failed || 0}</td>
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
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}
