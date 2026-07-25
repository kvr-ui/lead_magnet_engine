import { useEffect, useState } from "react";
import { fetchIntegrationStatus, connectWhatsApp, disconnectWhatsApp } from "./api";

function emptyChannel() {
  return { id: "", label: "" };
}

export default function IntegrationsTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [channels, setChannels] = useState([emptyChannel()]);
  const [connecting, setConnecting] = useState(false);

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
            <button type="button" className="secondary-btn" onClick={handleDisconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <p className="muted">Not connected — campaign sending is paused until a provider is connected below.</p>
        )}
      </div>

      {!status?.connected && (
        <form className="panel" onSubmit={handleConnect}>
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
