import { isValidElement, useEffect, useRef, useState } from "react";
import {
  fetchTemplates,
  fetchChannels,
  sendSingleMessage,
  fetchSends,
  fetchEnrollmentDetail,
  fetchDirectMessageDetail,
} from "./api";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";
import { formatDisplayValue } from "./formatValue";
import { DeliveryCell, EventList, StatusBadge } from "./MessageDelivery";

// Every message we have sent and what WhatsApp reported back about it —
// campaign drips and hand-sent messages in one feed.
//
// The campaign tab answers "how is this campaign doing". This answers "what
// happened to the message we sent that number", which cuts across campaigns
// and includes the sends that belong to none.

// Renders whatever fields a record happens to have. The lead comes from a
// user-connected collection, so its shape isn't known ahead of time — listing
// what's there beats hardcoding a guess at which fields matter.
function DetailGrid({ fields }) {
  const entries = Object.entries(fields || {}).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!entries.length) return <p className="muted">Nothing recorded.</p>;

  return (
    <dl className="detail-grid">
      {entries.map(([key, value]) => (
        <div className="detail-row" key={key}>
          <dt>{key}</dt>
          <dd>{detailValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

// A field may be markup (a muted "not reported yet") rather than a scalar.
// Without the element check it falls through to the object branch and renders
// as its own JSON — element internals and all.
function detailValue(value) {
  if (isValidElement(value)) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(formatDisplayValue(value));
}

// Everything known about one send: who it went to, which campaign and step it
// came from, what the provider called it, and the whole event trail.
//
// One panel for both kinds. A campaign send has a lead record behind it and a
// manual send doesn't, so that section simply doesn't render for manual — the
// rest is identical, and splitting it into two components would duplicate all
// of it for one difference.
// What to call a send in a one-line cell. A template names itself; a free-text
// send has no name, so its body stands in — which is also the only place the
// exact words that went to that lead are recoverable, since the body is
// rendered per lead at send time.
function sendLabel(row) {
  if (row.messageType !== "text") return row.templateId;
  const body = String(row.text || "").replace(/\s+/g, " ").trim();
  if (!body) return <span className="muted">free text</span>;
  return `“${body.length > 60 ? `${body.slice(0, 60)}…` : body}”`;
}

function SendDetail({ row, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const panel = useRef(null);

  useEffect(() => {
    setData(null);
    setError(null);
    const load = row.kind === "campaign" ? fetchEnrollmentDetail(row.enrollmentId) : fetchDirectMessageDetail(row.directMessageId);
    load.then(setData).catch((err) => setError(err.message));
  }, [row.kind, row.enrollmentId, row.directMessageId]);

  // The panel renders after the table, which is a full page of rows — without
  // this, clicking a row near the top opens the details far below the fold and
  // the click looks like it did nothing. Scrolled on row change rather than on
  // load so the panel is reached while it still says "Loading…".
  useEffect(() => {
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [row.kind, row.enrollmentId, row.directMessageId, row.nodeId]);

  // The send is the row the user clicked; for a campaign that's one entry out
  // of the enrollment's history, matched by the node it was sent from. History
  // entries are keyed by nodeId now — there is no step index to match on, and
  // a graph can revisit a node, so this is the only stable handle.
  const step = data?.enrollment?.history?.find((h) => h.nodeId === row.nodeId);
  const send = row.kind === "campaign" ? step : data?.message;

  // What to call the node this send came from: the label the sends feed
  // already resolved, or the one the enrollment detail resolved against the
  // pinned graph version. Both come from the backend; neither is derived here.
  const sendNodeLabel = row.label || step?.label || null;

  // How many nodes the graph this lead is walking actually has. The enrollment
  // is pinned to the version it entered on, so the count comes from that
  // snapshot rather than from the draft an admin may have edited since.
  const pinnedVersion = (data?.campaign?.versions || []).find((v) => v.version === data?.enrollment?.graphVersion);
  const nodeCount = (pinnedVersion?.nodes || data?.campaign?.draft?.nodes || []).length;

  return (
    <div className="panel timeline-panel" ref={panel}>
      <div className="step-card-head">
        <h4>
          {row.phone} <span className="muted">— {sendLabel(row)}</span>
        </h4>
        <button type="button" className="secondary-btn" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}

      {data && (
        <>
          {row.kind === "campaign" && (
            <>
              <h5>Lead</h5>
              {data.leadError && <p className="muted">{data.leadError}</p>}
              {data.lead && <DetailGrid fields={data.lead} />}
            </>
          )}

          <h5>Send</h5>
          <DetailGrid
            fields={{
              Source:
                row.kind === "campaign"
                  ? [data.campaign?.name || "Campaign", sendNodeLabel].filter(Boolean).join(" · ")
                  : "Manual",
              Template: row.messageType === "text" ? null : row.templateId,
              // Shown only for a free-text send, where it is the message
              // itself rather than a detail about it.
              "Message text": row.messageType === "text" ? row.text || send?.detail : null,
              "Sent at": row.sentAt ? new Date(row.sentAt).toLocaleString() : null,
              Status: send?.status || row.status,
              Error: send?.error,
              "Broadcast name": data.message?.broadcastName,
              Channel: data.message?.channelId || data.campaign?.channelId,
              // Blank until the *MessageSent webhook backfills them, which is
              // also the difference between a send that can be tracked by id
              // and one that can only be matched by number.
              "WhatsApp message id": send?.providerMessageId || <span className="muted">not reported yet</span>,
              "Provider message id": send?.providerLocalMessageId,
            }}
          />

          {row.kind === "campaign" && (
            <>
              <h5>Campaign progress</h5>
              <DetailGrid
                fields={{
                  Status: data.enrollment?.status,
                  // Named, not numbered: the walker parks a lead on a node, and
                  // a graph has no ordinal to report. currentNode is resolved
                  // by GET /api/enrollments/:id against the pinned version.
                  "Step reached": data.enrollment?.currentNode?.label
                    ? `${data.enrollment.currentNode.label}${nodeCount ? ` — one of ${nodeCount} nodes` : ""}`
                    : data.enrollment?.status === "completed"
                      ? "Finished the flow"
                      : "Not started",
                  // History records everything that happened to this lead,
                  // which since the action node landed is no longer only
                  // sends — so this counts messages rather than entries.
                  "Messages sent": (data.enrollment?.history || []).filter((h) => (h.kind || "message") === "message")
                    .length,
                  "Next send": data.enrollment?.nextSendAt ? new Date(data.enrollment.nextSendAt).toLocaleString() : null,
                  Enrolled: data.enrollment?.createdAt ? new Date(data.enrollment.createdAt).toLocaleString() : null,
                }}
              />
            </>
          )}

          <h5>Events</h5>
          {!data.events.length && (
            <p className="muted">
              Nothing reported yet. WhatsApp sends delivery receipts within seconds — if this stays empty, the webhook
              isn't reaching the app.
            </p>
          )}
          {Boolean(data.events.length) && <EventList events={data.events} />}
        </>
      )}
    </div>
  );
}

// One send, whichever kind it is. Clicking opens everything known about it.
function SendsFeed({ refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [page, setPage] = useState(1);
  const [kind, setKind] = useState("");
  const [phone, setPhone] = useState("");
  // Applied separately from `phone` so the feed reloads on submit rather than
  // on every keystroke.
  const [search, setSearch] = useState("");
  const [openRow, setOpenRow] = useState(null);

  useEffect(() => {
    setError(null);
    // Whatever was open belonged to the previous result set — a detail panel
    // for a row that has just scrolled off the page reads as if it were still
    // selected.
    setOpenRow(null);
    fetchSends({ page, kind, phone: search })
      .then(setData)
      .catch((err) => setError(err.message));
  }, [page, kind, search, refreshKey]);

  const columns = [
    { key: "phone", header: "Phone", get: (d) => d.phone },
    { key: "templateId", header: "Message", get: (d) => sendLabel(d) },
    {
      key: "source",
      header: "Source",
      // A campaign send names its campaign and the node it was sent from; a
      // manual one says so plainly rather than showing an empty cell. The
      // label is resolved by GET /api/sends against the graph version the
      // enrollment is pinned to, and is absent only when that node has since
      // been deleted from the graph.
      get: (d) =>
        d.kind === "campaign" ? (
          <>
            {d.campaignName || "Campaign"}
            {d.label && <span className="muted"> · {d.label}</span>}
          </>
        ) : (
          <span className="muted">Manual</span>
        ),
    },
    {
      key: "delivery",
      header: "Delivery",
      // A send the provider rejected never reached WhatsApp, so it has no
      // delivery state to report — say so instead of showing an empty funnel.
      get: (d) =>
        d.status === "error" ? <StatusBadge status="failed">Send failed</StatusBadge> : <DeliveryCell delivery={d.delivery} />,
    },
    { key: "replied", header: "Replied", get: (d) => (d.delivery?.replied || d.delivery?.received ? "yes" : "") },
    { key: "sentAt", header: "Sent", get: (d) => (d.sentAt ? new Date(d.sentAt).toLocaleString() : "") },
  ];

  return (
    <div className="panel">
      <h3>All sends</h3>

      <form
        className="condition-row"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setSearch(phone.trim());
        }}
      >
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setPage(1);
          }}
        >
          <option value="">Campaign &amp; manual</option>
          <option value="campaign">Campaign only</option>
          <option value="manual">Manual only</option>
        </select>
        <input placeholder="Search by number" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button type="submit" className="secondary-btn">
          Search
        </button>
        {Boolean(search) && (
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setPhone("");
              setSearch("");
              setPage(1);
            }}
          >
            clear
          </button>
        )}
      </form>

      {error && <p className="error">{error}</p>}
      {data && !data.total && <p className="muted">No sends recorded yet.</p>}

      {Boolean(data?.total) && (
        <>
          <Pager
            page={data.page || page}
            totalPages={Math.ceil(data.total / data.pageSize)}
            total={data.total}
            onChange={setPage}
          />
          <p className="muted">Click a send to see every event recorded for it.</p>
          <LeadsTable
            columns={columns}
            rows={data.sends}
            loading={false}
            error={null}
            onRowClick={setOpenRow}
            activeRowId={openRow?._id}
          />
          {openRow && <SendDetail row={openRow} onClose={() => setOpenRow(null)} />}
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

export default function MessageTrackingTab() {
  // Bumped on every send so the feed below reloads and shows the new row.
  // Held here rather than in the form so the form stays unaware of what reads
  // its output.
  const [sends, setSends] = useState(0);

  return (
    <div>
      <SendToNumberForm onSent={() => setSends((n) => n + 1)} />
      <SendsFeed refreshKey={sends} />
    </div>
  );
}
