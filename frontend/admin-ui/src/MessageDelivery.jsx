import { useEffect, useState } from "react";
import { fetchCampaignDelivery, fetchEnrollmentEvents } from "./api";

// Presentation of the delivery state reported back by the WATI webhook.
//
// Deliberately kept apart from a campaign's enrollment counts: those describe
// how far the drip got, these describe what happened to the message after the
// provider accepted it. A campaign can read "100 completed" while every one of
// those messages failed at Meta.

// Stage labels, widest funnel step first. Stages are cumulative, not exclusive
// — a lead who read a message is also counted as delivered.
const FUNNEL = [
  { key: "sent", label: "Sent", hint: "Handed to WhatsApp" },
  { key: "delivered", label: "Delivered", hint: "Reached the handset" },
  { key: "read", label: "Read", hint: "Opened by the lead" },
  { key: "replied", label: "Replied", hint: "Lead answered" },
];

const STATUS_TONE = {
  sent: "neutral",
  delivered: "neutral",
  read: "success",
  replied: "success",
  received: "success",
  failed: "danger",
  unknown: "neutral",
};

export function StatusBadge({ status, children }) {
  return <span className={`badge badge-${STATUS_TONE[status] || "neutral"}`}>{children || status}</span>;
}

// Per-lead delivery state, shown as the stages that lead actually reached.
// Renders in the enrollments table, where a bare "completed" says nothing
// about whether the message landed.
export function DeliveryCell({ delivery }) {
  const reached = FUNNEL.filter((s) => delivery?.[s.key]);
  const failed = delivery?.failed;

  if (failed) return <StatusBadge status="failed">Failed</StatusBadge>;
  if (!reached.length) return <span className="muted">—</span>;

  // Only the furthest stage is worth the row's width; the earlier ones are
  // implied by it.
  const furthest = reached[reached.length - 1];
  return <StatusBadge status={furthest.key}>{furthest.label}</StatusBadge>;
}

// The campaign-level funnel: how many leads reached each stage, against the
// number actually attempted.
export function DeliveryFunnel({ campaignId, refreshKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setError(null);
    fetchCampaignDelivery(campaignId)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [campaignId, refreshKey]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading delivery…</p>;

  // Attempted, not enrolled: leads still queued for their first send haven't
  // failed to be delivered to, they simply haven't been sent to yet.
  const base = data.attempted || 0;
  const pct = (n) => (base ? Math.round((n / base) * 100) : 0);
  const failed = data.counts.failed?.leads || 0;
  const received = data.counts.received?.events || 0;

  return (
    <div className="delivery-funnel">
      {!base && (
        <p className="muted">
          Nothing sent yet — delivery is reported by WhatsApp once the first message goes out.
        </p>
      )}

      {Boolean(base) && (
        <>
          <div className="funnel-stages">
            {FUNNEL.map((stage) => {
              const leads = data.counts[stage.key]?.leads || 0;
              return (
                <div className="funnel-stage" key={stage.key} title={stage.hint}>
                  <div className="funnel-stage-head">
                    <span className="funnel-label">{stage.label}</span>
                    <span className="funnel-count">{leads}</span>
                  </div>
                  <div className="funnel-bar">
                    <div className={`funnel-fill funnel-fill-${stage.key}`} style={{ width: `${pct(leads)}%` }} />
                  </div>
                  <span className="muted funnel-pct">{pct(leads)}%</span>
                </div>
              );
            })}
          </div>

          <p className="muted">
            {data.enrolled} enrolled · {base} attempted
            {failed > 0 && (
              <>
                {" · "}
                <span className="badge badge-danger">{failed} failed</span>
              </>
            )}
            {received > 0 && ` · ${received} inbound message${received === 1 ? "" : "s"} from leads`}
          </p>
        </>
      )}
    </div>
  );
}

// Every event recorded for one message or one lead, oldest first. This is the
// audit trail: what was sent, when it landed, whether it was read, what came
// back. Shared by the campaign and single-send views — the events are the same
// shape whichever produced them, only the thing they hang off differs.
function EventTimeline({ id, fetcher, heading, subheading, onClose }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setEvents(null);
    setError(null);
    fetcher(id)
      .then((d) => setEvents(d.events))
      .catch((err) => setError(err.message));
    // fetcher is a stable module-level import at every call site; keying the
    // refetch on the id alone avoids a re-run on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="panel timeline-panel">
      <div className="step-card-head">
        <h4>
          {heading} <span className="muted">{subheading}</span>
        </h4>
        <button type="button" className="secondary-btn" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!events && !error && <p className="muted">Loading…</p>}

      {events && !events.length && (
        <p className="muted">
          No events yet. WhatsApp reports delivery a few seconds after a send — if this stays empty after a send, the
          webhook isn't reaching the app.
        </p>
      )}

      {events && Boolean(events.length) && <EventList events={events} />}
    </div>
  );
}

// The events themselves, oldest first. Presentational only — used both by the
// self-fetching timeline above and by detail panels that already hold the
// events.
export function EventList({ events }) {
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e._id}>
          <StatusBadge status={e.status} /> <span className="muted">{new Date(e.receivedAt).toLocaleString()}</span>
          <span className="muted"> · {e.eventType}</span>
          {e.text && <div className="timeline-text">{e.text}</div>}
          {e.failedCode && (
            <div className="error">
              Meta error {e.failedCode}
              {e.failedDetail ? `: ${e.failedDetail}` : ""}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

export function EnrollmentTimeline({ enrollment, onClose }) {
  return (
    <EventTimeline
      id={enrollment._id}
      fetcher={fetchEnrollmentEvents}
      heading={enrollment.phone}
      subheading="— message history"
      onClose={onClose}
    />
  );
}

