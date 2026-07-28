import { useEffect, useState } from "react";
import { fetchSendingEnabled, setSendingEnabled } from "./api";

// Global kill switch, in the header so its state is visible from every tab.
// Off is the safe state and is styled as the loud one: while testing, the
// thing worth noticing is sending being live, not it being off.
export default function SendingToggle() {
  const [enabled, setEnabled] = useState(null);
  const [queued, setQueued] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchSendingEnabled()
      .then((d) => {
        setEnabled(d.enabled);
        setQueued(d.queued);
      })
      .catch((err) => setError(err.message));
  }, []);

  async function toggle() {
    const next = !enabled;
    // Turning it on releases everything already queued — say how much before
    // it happens, not after.
    if (next) {
      const warning = queued
        ? `Turn sending ON?\n\n${queued} lead(s) are already queued in active campaigns and will start receiving real WhatsApp messages within a few minutes.`
        : "Turn sending ON?\n\nCampaign messages will be sent for real from now on.";
      if (!window.confirm(warning)) return;
    }

    setError(null);
    setBusy(true);
    try {
      const d = await setSendingEnabled(next);
      setEnabled(d.enabled);
      setQueued(d.queued);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (enabled === null) {
    return <span className="muted">{error || "Checking sending…"}</span>;
  }

  return (
    <div className="sending-toggle">
      <button
        type="button"
        className={`switch ${enabled ? "on" : "off"}`}
        onClick={toggle}
        disabled={busy}
        role="switch"
        aria-checked={enabled}
        aria-label="Sending"
        title={
          enabled
            ? "Sending is live — campaign messages go out for real. Click to turn off."
            : "Sending is off — nothing leaves this system. Click to go live."
        }
      >
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
        <span className="switch-label">{enabled ? "Sending ON" : "Sending OFF · test mode"}</span>
      </button>
      {enabled && queued > 0 && <span className="muted">{queued} queued</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}
