import { useEffect, useRef, useState } from "react";
import { fetchCampaignActivity, fetchCampaignLeadActivity } from "./api";

// What the leads actually did after we messaged them.
//
// Deliberately separate from DeliveryFunnel: that measures the message (sent,
// delivered, read), and stops at the handset. This measures the lead — did
// they go and use the product afterwards. A campaign can be delivered and read
// by everyone and still activate nobody, and that gap is the point of this
// panel.

// Windows offered in the picker. A finite default matters: a lead who comes
// back eight days later probably didn't do it because of our message, and
// counting them would flatter every campaign.
const WINDOWS = [
  { value: 24, label: "24 hours" },
  { value: 72, label: "3 days" },
  { value: 168, label: "7 days" },
  { value: 720, label: "30 days" },
  { value: 0, label: "Any time after" },
];

function pct(n, base) {
  return base ? Math.round((n / base) * 1000) / 10 : 0;
}

function relTime(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 24) return `${Math.round((minutes / 60) * 10) / 10} hr`;
  return `${Math.round((minutes / (60 * 24)) * 10) / 10} days`;
}

// The questions behind one lead's number: what was asked, what they picked,
// what was right. Without this the row is just a count — this is the evidence
// that the campaign actually put someone to work.
function LeadAnswers({ campaignId, lead, windowHours, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    setData(null);
    setError(null);
    fetchCampaignLeadActivity(campaignId, lead.key, windowHours)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [campaignId, lead.key, windowHours]);

  // Scroll on selection rather than on load, so the panel is already in view
  // showing "Loading…" instead of the page jumping once the data lands.
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [lead.key]);

  return (
    <div className="panel timeline-panel" ref={ref}>
      <div className="step-card-head">
        <h4>
          {lead.name || lead.phone}{" "}
          <span className="muted">
            — answers after {data?.campaign?.name ? `"${data.campaign.name}"` : "this campaign"}
          </span>
        </h4>
        <button type="button" className="secondary-btn" onClick={onClose}>
          Close
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading answers…</p>}

      {data?.found && (
        <>
          <p className="muted">
            Messaged {new Date(data.lead.sentAt).toLocaleString()}
            {data.lead.templateId ? ` with template "${data.lead.templateId}"` : ""} · answered {data.summary.count}{" "}
            {data.source.noun} since — <span className="badge badge-success">{data.summary.correct} correct</span>{" "}
            <span className="badge badge-danger">{data.summary.wrong} wrong</span>
          </p>

          <ol className="answer-list">
            {data.answers.map((a, i) => (
              <li key={i} className={a.isCorrect ? "answer-correct" : "answer-wrong"}>
                <div className="answer-head">
                  <span className={`badge badge-${a.isCorrect ? "success" : "danger"}`}>
                    {a.isCorrect ? "Correct" : "Wrong"}
                  </span>
                  <span className="muted">{new Date(a.at).toLocaleString()}</span>
                  {a.label && <span className="muted"> · {a.label}</span>}
                </div>

                {/* An answer whose question the lead magnet no longer has is
                    still a real answer — say so rather than render a blank. */}
                <div className="answer-question">
                  {a.question || <span className="muted">Question text no longer available in the lead magnet</span>}
                </div>

                {a.options && (
                  <ul className="answer-options">
                    {a.options.map((opt, oi) => {
                      // Options come through as "A: …", so the letter prefix
                      // is what marks which one they picked.
                      const letter = String(opt).trim().charAt(0);
                      const picked = a.given && letter === a.given;
                      const right = a.correctAnswer && letter === a.correctAnswer;
                      return (
                        <li
                          key={oi}
                          className={`${picked ? "option-picked" : ""} ${right ? "option-right" : ""}`.trim()}
                        >
                          {opt}
                          {picked && <span className="option-tag"> ← they chose this</span>}
                          {right && !picked && <span className="option-tag"> ← correct answer</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="muted answer-verdict">
                  Answered <strong>{a.given || "—"}</strong> · correct answer <strong>{a.correctAnswer || "—"}</strong>
                </div>

                {a.explanation && <details className="answer-explanation"><summary>Why</summary>{a.explanation}</details>}
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export default function CampaignActivity({ campaignId, refreshKey }) {
  const [windowHours, setWindowHours] = useState(168);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  // The lead whose individual answers are open, if any.
  const [openLead, setOpenLead] = useState(null);

  useEffect(() => {
    setData(null);
    setError(null);
    // The open panel belongs to the previous window's numbers; keeping it
    // would show answers that no longer match the row above them.
    setOpenLead(null);
    fetchCampaignActivity(campaignId, windowHours)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [campaignId, windowHours, refreshKey]);

  if (error) return <p className="error">{error}</p>;

  const picker = (
    <label className="activity-window">
      Counted within{" "}
      <select value={windowHours} onChange={(e) => setWindowHours(Number(e.target.value))}>
        {WINDOWS.map((w) => (
          <option key={w.value} value={w.value}>
            {w.label}
          </option>
        ))}
      </select>{" "}
      of the message
    </label>
  );

  if (!data) return <p className="muted">Loading activity…</p>;

  if (!data.configured) {
    return (
      <p className="muted">
        No activity source configured. Connect the lead magnet's database on the Data Sources tab and set its activity
        collection — the one with a timestamp per action (e.g. one row per MCQ answered) — and this fills in, including
        for campaigns already sent.
      </p>
    );
  }

  const { summary, leads, source } = data;
  const noun = source.noun || "activity";

  return (
    <div className="activity-panel">
      {picker}

      {!summary.messaged && (
        <p className="muted">Nothing sent yet — activity is measured from the moment the first message goes out.</p>
      )}

      {Boolean(summary.messaged) && (
        <>
          <div className="activity-stats">
            <div className="activity-stat">
              <span className="activity-stat-value">{summary.messaged}</span>
              <span className="activity-stat-label">Messaged</span>
            </div>
            <div className="activity-stat">
              <span className="activity-stat-value">{summary.activated}</span>
              <span className="activity-stat-label">Started solving</span>
              <span className="muted activity-stat-sub">{pct(summary.activated, summary.messaged)}%</span>
            </div>
            <div className="activity-stat">
              <span className="activity-stat-value">{summary.count}</span>
              <span className="activity-stat-label">{noun} solved after send</span>
            </div>
            <div className="activity-stat">
              <span className="activity-stat-value">{summary.correct}</span>
              <span className="activity-stat-label">Correct</span>
              <span className="muted activity-stat-sub">{pct(summary.correct, summary.graded)}% of answered</span>
            </div>
          </div>

          {summary.matched < summary.messaged && (
            <p className="muted">
              {summary.messaged - summary.matched} of {summary.messaged} messaged leads couldn't be matched to a{" "}
              {source.label} account, so their activity isn't counted here.
            </p>
          )}

          {/* Credit goes to the most recent message before the lead acted. When
              another campaign or a manual send reached the same lead later,
              that one earns it — saying so keeps this campaign's number from
              quietly absorbing someone else's result. */}
          {summary.creditedActivated !== summary.activated && (
            <p className="muted">
              {summary.creditedActivated} of these {summary.activated} are credited to this campaign; the rest were
              messaged again more recently by something else.
            </p>
          )}

          {!leads.length && (
            <p className="muted">
              Nobody messaged by this campaign has solved a {noun} since — within the window above. Widen the window or
              check the Delivery section: if the messages never landed, there was nothing to act on.
            </p>
          )}

          {Boolean(leads.length) && (
            <>
            <p className="muted">Click a lead to see every question they answered, with their answer and the right one.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Lead</th>
                    <th>Phone</th>
                    <th>Messaged</th>
                    <th>{noun} after</th>
                    <th>Correct</th>
                    <th>Time to first</th>
                    <th>What they studied</th>
                    <th>Credited to</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr
                      key={l.key}
                      className={`clickable-row${openLead?.key === l.key ? " row-active" : ""}`}
                      onClick={() => setOpenLead(openLead?.key === l.key ? null : l)}
                    >
                      <td>{l.name || <span className="muted">—</span>}</td>
                      <td>{l.phone}</td>
                      <td>{new Date(l.sentAt).toLocaleString()}</td>
                      <td>
                        <strong>{l.count}</strong>
                      </td>
                      <td>{l.correct}</td>
                      <td>{relTime(l.minutesToFirst)}</td>
                      <td>{l.labels.join("; ") || <span className="muted">—</span>}</td>
                      <td>
                        {l.attributedTo ? (
                          <span className="badge badge-neutral">{l.attributedTo.name}</span>
                        ) : (
                          <span className="badge badge-success">This campaign</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {openLead && (
              <LeadAnswers
                campaignId={campaignId}
                lead={openLead}
                windowHours={windowHours}
                onClose={() => setOpenLead(null)}
              />
            )}
            </>
          )}
        </>
      )}
    </div>
  );
}
