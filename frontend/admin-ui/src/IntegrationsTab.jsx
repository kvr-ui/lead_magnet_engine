import { useEffect, useState } from "react";
import {
  fetchIntegrationStatus,
  connectWhatsApp,
  disconnectWhatsApp,
  rotateWebhookSecret,
  fetchSendPolicy,
  updateSendPolicy,
} from "./api";
import WindowScheduleFields from "./WindowScheduleFields";

function emptyChannel() {
  return { id: "", label: "" };
}

// Turns a fetched/normalized policy (lib/sendPolicy.js) into editable form
// state. The one deliberate departure from the stored shape: a fresh/unset
// installation reports maxPerContact.count as 0 (that module's internal
// sentinel for "no cap configured" — see its comments), which is not a value
// the cap input should ever show or resubmit, since the route rejects a
// non-positive count outright. 1/60 are just sane starting values for an
// operator turning the cap on for the first time; they change nothing while
// the policy is off.
function draftFromPolicy(policy) {
  return {
    enabled: policy.enabled,
    maxPerContact: {
      count: policy.maxPerContact.count || 1,
      windowMinutes: policy.maxPerContact.windowMinutes || 60,
    },
    quietHours: {
      window: policy.quietHours.window,
      tz: policy.quietHours.tz || "UTC",
      skipDays: policy.quietHours.skipDays || [],
    },
    countManualSends: policy.countManualSends,
  };
}

// Sending policy panel (task 11, #39): read/write UI for the account-wide
// cap + quiet-hours policy from task 7 (lib/sendPolicy.js). Reuses
// WindowScheduleFields — the same from/to/timezone/skip-days sub-form the
// wait node's config uses — for quiet hours, rather than a second copy of
// those inputs. That component's `window` shape carries `tz` alongside
// `from`/`to`; the policy stores `tz` one level up, as a sibling of
// `window`, so it's threaded through here rather than duplicated onto the
// window object in storage.
function SendPolicyPanel() {
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function reload() {
    setLoading(true);
    setError(null);
    fetchSendPolicy()
      .then((policy) => setDraft(draftFromPolicy(policy)))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  function set(patch) {
    setDraft((d) => ({ ...d, ...patch }));
    setSaved(false);
  }
  function setCap(patch) {
    setDraft((d) => ({ ...d, maxPerContact: { ...d.maxPerContact, ...patch } }));
    setSaved(false);
  }
  // WindowScheduleFields calls this with one-key patches: {from}, {to}, or
  // {tz} (see NodeConfigPanel.jsx's WaitPanel, which drives the very same
  // component the same way). tz routes to quietHours.tz directly; from/to
  // merge onto quietHours.window.
  function setQuietWindow(patch) {
    setDraft((d) => {
      if (Object.prototype.hasOwnProperty.call(patch, "tz")) {
        return { ...d, quietHours: { ...d.quietHours, tz: patch.tz } };
      }
      const current = d.quietHours.window || { from: "", to: "" };
      return { ...d, quietHours: { ...d.quietHours, window: { ...current, ...patch } } };
    });
    setSaved(false);
  }
  function toggleSkipDay(day) {
    setDraft((d) => {
      const days = d.quietHours.skipDays || [];
      const next = days.includes(day) ? days.filter((x) => x !== day) : [...days, day].sort((a, b) => a - b);
      return { ...d, quietHours: { ...d.quietHours, skipDays: next } };
    });
    setSaved(false);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    setSaved(false);
    try {
      const win = draft.quietHours.window;
      // Blank from/blank to means "no time-of-day restriction" — the same
      // rule lib/sendPolicy.js's normalizeWindow applies — so an untouched
      // pair of empty inputs is sent as null rather than as an object that
      // would fail the from/to validity check.
      const payload = {
        ...draft,
        quietHours: {
          ...draft.quietHours,
          window: win && (win.from || win.to) ? win : null,
        },
      };
      const next = await updateSendPolicy(payload);
      setDraft(draftFromPolicy(next));
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading || !draft) {
    return (
      <div className="panel">
        <h3>Sending policy</h3>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const win = draft.quietHours.window || {};

  return (
    <form className="panel panel-form" onSubmit={handleSave}>
      <h3>Sending policy</h3>
      <p className="muted">
        Applies across <strong>every</strong> campaign for a contact, not per campaign — one shared cap and one
        shared quiet-hours window per phone number, however many drips are currently running against it. A send this
        policy blocks is deferred to the next allowed slot — never dropped, never marked failed.
      </p>

      <button
        type="button"
        className={`switch ${draft.enabled ? "on" : "off"}`}
        onClick={() => set({ enabled: !draft.enabled })}
        role="switch"
        aria-checked={draft.enabled}
        aria-label="Sending policy"
        title={
          draft.enabled
            ? "The cap and quiet hours below are enforced. Click to turn off."
            : "Off — no capping and no quiet hours, regardless of the values below. Click to turn on."
        }
      >
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
        <span className="switch-label">{draft.enabled ? "Policy ON" : "Policy OFF — no capping, no quiet hours"}</span>
      </button>

      <h4>Max per contact</h4>
      <label className="form-row">
        Messages
        <input
          type="number"
          min="1"
          value={draft.maxPerContact.count}
          onChange={(e) => setCap({ count: Number(e.target.value) || 0 })}
        />
      </label>
      <label className="form-row">
        Per (minutes)
        <input
          type="number"
          min="1"
          value={draft.maxPerContact.windowMinutes}
          onChange={(e) => setCap({ windowMinutes: Number(e.target.value) || 0 })}
        />
      </label>

      <h4>Quiet hours</h4>
      <p className="muted">Leave the window blank for no time-of-day restriction.</p>
      <WindowScheduleFields
        window={{ from: win.from || "", to: win.to || "", tz: draft.quietHours.tz || "" }}
        skipDays={draft.quietHours.skipDays}
        onChangeWindow={setQuietWindow}
        onToggleSkipDay={toggleSkipDay}
      />

      <h4>Manual sends</h4>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.countManualSends}
          onChange={(e) => set({ countManualSends: e.target.checked })}
        />
        Count one-off manual sends ("Send a message") toward the same cap
      </label>

      {error && <p className="error">{error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save sending policy"}
        </button>
        {saved && <span className="notice">Saved</span>}
      </div>
    </form>
  );
}

export default function IntegrationsTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [channels, setChannels] = useState([emptyChannel()]);
  const [connecting, setConnecting] = useState(false);
  const [rotating, setRotating] = useState(false);

  function reload() {
    setLoading(true);
    fetchIntegrationStatus()
      .then(setStatus)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  function updateChannel(i, patch) {
    setChannels(channels.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }

  async function handleConnect(e) {
    e.preventDefault();
    setError(null);
    setConnecting(true);
    try {
      await connectWhatsApp({
        endpoint,
        token,
        channels: channels.filter((c) => c.id.trim()),
      });
      setToken("");
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm("Disconnect WhatsApp? Campaign sending will pause until you reconnect.")) return;
    setError(null);
    try {
      await disconnectWhatsApp();
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRotateSecret() {
    if (
      !window.confirm(
        "Rotate the webhook secret? The current webhook URL will stop working immediately. " +
          "Delivery, read, and reply tracking — and STOP opt-outs — will silently stop arriving until " +
          "you paste the new URL into WATI's webhook configuration."
      )
    ) {
      return;
    }
    setError(null);
    setRotating(true);
    try {
      const next = await rotateWebhookSecret();
      setStatus(next);
      setCopied(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setRotating(false);
    }
  }

  if (loading) return <div className="panel">Loading…</div>;

  return (
    <div>
      <div className="panel">
        <h3>WhatsApp</h3>
        {error && <p className="error">{error}</p>}
        {status?.connected ? (
          <>
            <p className="notice">
              Connected · {status.type} · {status.endpoint}
            </p>
            {status.channels?.length > 0 && (
              <ul>
                {status.channels.map((c) => (
                  <li key={c.id}>
                    {c.label} ({c.id})
                  </li>
                ))}
              </ul>
            )}
            <button type="button" className="secondary-btn danger" onClick={handleDisconnect}>
              Disconnect
            </button>

            {status.webhookSecret && (
              <div className="panel" style={{ marginTop: "1rem" }}>
                <h4>Webhook (delivery, read, reply tracking)</h4>
                <p className="muted">
                  In WATI, go to <strong>Connectors → Webhooks → Add Webhook</strong>, paste this URL, set status to
                  Enabled, and select the events you want (delivered, read, replied) so we can track what happens
                  after a campaign message is sent.
                </p>
                <label className="form-row">
                  Webhook URL
                  <div className="condition-row">
                    <input
                      readOnly
                      value={`${window.location.origin}/api/wati/webhook?secret=${status.webhookSecret}`}
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/api/wati/webhook?secret=${status.webhookSecret}`);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                    >
                      {copied ? "Copied!" : "Copy"}
                    </button>
                    <button
                      type="button"
                      className="secondary-btn danger"
                      onClick={handleRotateSecret}
                      disabled={rotating}
                    >
                      {rotating ? "Rotating…" : "Rotate"}
                    </button>
                  </div>
                </label>
              </div>
            )}
          </>
        ) : (
          <p className="muted">Not connected — campaign sending is paused until a provider is connected below.</p>
        )}
      </div>

      {!status?.connected && (
        <form className="panel panel-form" onSubmit={handleConnect}>
          <h3>Connect WhatsApp (WATI)</h3>

          <label className="form-row">
            API endpoint
            <input
              placeholder="https://live-mt-server.wati.io/12345"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              required
            />
          </label>

          <label className="form-row">
            API token
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} required />
          </label>

          <h4>Channels</h4>
          {channels.map((c, i) => (
            <div className="condition-row" key={i}>
              <input
                placeholder="Phone number, e.g. +916383514285"
                value={c.id}
                onChange={(e) => updateChannel(i, { id: e.target.value })}
              />
              <input
                placeholder="Label (optional)"
                value={c.label}
                onChange={(e) => updateChannel(i, { label: e.target.value })}
              />
              {channels.length > 1 && (
                <button type="button" className="link-btn" onClick={() => setChannels(channels.filter((_, idx) => idx !== i))}>
                  remove
                </button>
              )}
            </div>
          ))}
          <button type="button" className="secondary-btn" onClick={() => setChannels([...channels, emptyChannel()])}>
            + add channel
          </button>

          <div className="form-actions">
            <button type="submit" disabled={connecting}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      )}

      <SendPolicyPanel />
    </div>
  );
}
