// Global kill switch, in the header so its state is visible from every tab.
// Off is the safe state and is styled as the loud one: while testing, the
// thing worth noticing is sending being live, not it being off.
//
// State (enabled/queued/busy/error) and the toggle action live in App, the
// app root — see App.jsx — rather than here, so the campaign status strip
// (CampaignStatus.jsx) can read and drive the very same state instead of
// polling a second copy of it. This component is now a plain controlled
// view: same markup and behaviour as before, driven by props.
export default function SendingToggle({ enabled, queued, busy, error, onToggle }) {
  if (enabled === null) {
    return <span className="muted">{error || "Checking sending…"}</span>;
  }

  return (
    <div className="sending-toggle">
      <button
        type="button"
        className={`switch ${enabled ? "on" : "off"}`}
        onClick={onToggle}
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
