import { useCallback, useEffect, useState } from "react";
import { fetchSessionWindows } from "./api";
import LeadsTable from "./LeadsTable";

/**
 * Everyone who can be sent a free-typed WhatsApp message right now.
 *
 * WhatsApp only allows a free-typed ("session") message within 24 hours of the
 * customer's last inbound message; outside that, the only thing that can be
 * sent is an approved template. So this is the list of people you can talk to
 * normally — and it is a list that empties itself, since every row expires on
 * its own clock.
 *
 * It is deliberately a list of PHONE NUMBERS with leads attached, not a list of
 * leads with a status column. A window belongs to the number, opened by that
 * person messaging us and by nothing else — not by a signup, not by a row
 * appearing in a lead database, both of which are invisible to WhatsApp.
 */

function formatRemaining(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return today ? `today ${time}` : `${d.toLocaleDateString()} ${time}`;
}

const COLUMNS = [
  { key: "name", header: "Name", get: (r) => r.name || <span className="muted">unknown</span> },
  { key: "phone", header: "Phone", get: (r) => r.phone },
  {
    key: "lastMessage",
    header: "What they said",
    get: (r) => (r.lastMessage ? r.lastMessage : <span className="muted">(no text)</span>),
  },
  { key: "lastInboundAt", header: "Last messaged", get: (r) => formatWhen(r.lastInboundAt) },
  {
    key: "msRemaining",
    header: "Closes in",
    // The one number that decides whether to act now or not, so it carries the
    // same green badge the audience table uses for an open window.
    get: (r) => <span className="badge badge-success">{formatRemaining(r.msRemaining)}</span>,
  },
  { key: "campaign", header: "Campaign", get: (r) => r.campaign || <span className="muted">—</span> },
];

export default function OpenWindowsTab() {
  const [data, setData] = useState({ windows: [], total: 0, windowHours: 24, truncated: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchSessionWindows()
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="panel">
      <div className="step-card-head">
        <h3>Open windows</h3>
        <button type="button" className="secondary-btn" onClick={load} disabled={loading}>
          Refresh
        </button>
      </div>

      <p className="muted open-windows-intro">
        People who messaged you in the last {data.windowHours} hours. These are the only contacts you can send a
        free-typed message to — everyone else can only receive an approved template. A window opens when someone
        messages you, and nothing else opens one: a signup or a new row in a lead database is invisible to WhatsApp.
      </p>

      {!loading && !error && (
        <p className="audience-window-note">
          <strong>{data.total}</strong> {data.total === 1 ? "person is" : "people are"} reachable right now.
          {data.truncated ? " Showing the most recent 500." : ""}
        </p>
      )}

      {!loading && !error && data.total === 0 ? (
        <p className="muted">
          Nobody has messaged you in the last {data.windowHours} hours, so every contact is template-only at the
          moment. This fills up as leads reply to your campaigns.
        </p>
      ) : (
        // LeadsTable keys rows by _id; these rows are keyed by the phone
        // number, which is what identifies a window in the first place.
        <LeadsTable
          columns={COLUMNS}
          rows={data.windows.map((w) => ({ ...w, _id: w.phone }))}
          loading={loading}
          error={error}
        />
      )}
    </div>
  );
}
