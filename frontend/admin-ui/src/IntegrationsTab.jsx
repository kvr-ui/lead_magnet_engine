import { useEffect, useState } from "react";
import { fetchIntegrationStatus, connectWhatsApp, disconnectWhatsApp, rotateWebhookSecret } from "./api";

function emptyChannel() {
  return { id: "", label: "" };
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
    </div>
  );
}
