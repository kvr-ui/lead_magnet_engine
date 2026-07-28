import { useEffect, useState } from "react";
import { fetchTemplates, fetchChannels, sendSingleMessage, fetchDirectMessages } from "./api";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";
import { DeliveryCell, DirectMessageTimeline, StatusBadge } from "./MessageDelivery";

// Messages sent by hand to one number, and what WhatsApp reported back for each.
//
// A tab of its own rather than a corner of Campaigns: these belong to no
// campaign, so none of the campaign views can show them, and mixing the two
// invited reading a one-off send as campaign activity.

// Every hand-sent message, newest first. Click one for its full event trail.
function SingleSendHistory({ refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [timelineFor, setTimelineFor] = useState(null);

  useEffect(() => {
    fetchDirectMessages({ page })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [page, refreshKey]);

  const columns = [
    { key: "phone", header: "Phone", get: (d) => d.phone },
    { key: "templateId", header: "Template", get: (d) => d.templateId },
    {
      key: "delivery",
      header: "Delivery",
      // A send the provider rejected outright never reached WhatsApp, so it has
      // no delivery state to report — say so instead of showing an empty funnel.
      get: (d) =>
        d.status === "error" ? <StatusBadge status="failed">Send failed</StatusBadge> : <DeliveryCell delivery={d.delivery} />,
    },
    { key: "replied", header: "Replied", get: (d) => (d.delivery?.replied || d.delivery?.received ? "yes" : "") },
    { key: "sentAt", header: "Sent", get: (d) => (d.sentAt ? new Date(d.sentAt).toLocaleString() : "") },
  ];

  return (
    <div className="panel">
      <h3>Sent messages</h3>
      {error && <p className="error">{error}</p>}
      {data && !data.total && <p className="muted">Nothing sent to a single number yet.</p>}
      {Boolean(data?.total) && (
        <>
          <Pager
            page={data.page || page}
            totalPages={Math.ceil(data.total / data.pageSize)}
            total={data.total}
            onChange={setPage}
          />
          <p className="muted">Click a message to see every event recorded for it.</p>
          <LeadsTable
            columns={columns}
            rows={data.messages}
            loading={false}
            error={null}
            onRowClick={setTimelineFor}
            activeRowId={timelineFor?._id}
          />
          {timelineFor && <DirectMessageTimeline message={timelineFor} onClose={() => setTimelineFor(null)} />}
        </>
      )}
    </div>
  );
}

function SendToNumberForm({ onSent }) {
  const [phone, setPhone] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [broadcastName, setBroadcastName] = useState("");
  const [channelId, setChannelId] = useState("");
  const [templates, setTemplates] = useState([]);
  const [channels, setChannels] = useState([]);
  const [connected, setConnected] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchTemplates()
      .then((d) => {
        setTemplates(d.templates);
        if (d.connected === false) setConnected(false);
      })
      .catch(() => {});
    fetchChannels()
      .then((d) => {
        setChannels(d.channels);
        if (d.connected === false) setConnected(false);
      })
      .catch(() => {});
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      await sendSingleMessage({ phone, templateId, providerMeta: { broadcastName }, channelId });
      setResult(`Sent to ${phone}. Delivery is reported by WhatsApp a few seconds later — reload to see it below.`);
      setPhone("");
      onSent();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!connected) {
    return (
      <div className="panel">
        <h3>Send to a single number</h3>
        <p className="error">No WhatsApp provider connected — connect one from the Integrations tab first.</p>
      </div>
    );
  }

  return (
    <form className="panel" onSubmit={handleSubmit}>
      <h3>Send to a single number</h3>
      <div className="condition-row">
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
          <option value="">Pick a template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.id}
            </option>
          ))}
        </select>
        <input
          placeholder="Broadcast name"
          value={broadcastName}
          onChange={(e) => setBroadcastName(e.target.value)}
          required
        />
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          <option value="">Pick a channel…</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <input placeholder="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <button type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {result && <p className="notice">{result}</p>}
    </form>
  );
}

export default function SingleSendsTab() {
  // Bumped on every send so the history below reloads and shows the new row.
  // Held here rather than in the form so the form stays unaware of what reads
  // its output.
  const [sends, setSends] = useState(0);

  return (
    <div>
      <SendToNumberForm onSent={() => setSends((n) => n + 1)} />
      <SingleSendHistory refreshKey={sends} />
    </div>
  );
}
