import { useEffect, useState } from "react";
import { fetchDataSources, createDataSource, updateDataSource, testDataSource, deleteDataSource } from "./api";

function emptyForm() {
  return { label: "", mongoUri: "", databaseName: "", collectionName: "" };
}

export default function DataSourcesTab({ onChanged }) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [connecting, setConnecting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  function reload() {
    setLoading(true);
    fetchDataSources()
      .then(setSources)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  async function handleConnect(e) {
    e.preventDefault();
    setFormError(null);
    setConnecting(true);
    try {
      await createDataSource(form);
      setForm(emptyForm());
      reload();
      onChanged?.();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleToggleActive(ds) {
    setBusyId(ds._id);
    try {
      await updateDataSource(ds._id, { active: !ds.active });
      reload();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(ds) {
    setBusyId(ds._id);
    try {
      await testDataSource(ds._id);
      reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(ds) {
    if (!window.confirm(`Delete "${ds.label}"? This removes it from the leads tabs — the source database itself is untouched.`)) {
      return;
    }
    setBusyId(ds._id);
    try {
      await deleteDataSource(ds._id);
      reload();
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="panel">
        <h3>Connected data sources</h3>
        {error && <p className="error">{error}</p>}
        {loading && <p className="muted">Loading…</p>}
        {!loading && !sources.length && (
          <p className="muted">No data sources connected yet — connect a lead magnet's database below.</p>
        )}
        {!loading && sources.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Collection</th>
                  <th>Status</th>
                  <th>Fields</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sources.map((ds) => (
                  <tr key={ds._id}>
                    <td>{ds.label}</td>
                    <td>{ds.collectionName}</td>
                    <td>
                      {ds.status === "connected" ? (
                        <span className="notice">connected</span>
                      ) : (
                        <span className="error" title={ds.lastError}>error</span>
                      )}
                    </td>
                    <td>{ds.fieldsCache?.length || 0}</td>
                    <td>{ds.active ? "yes" : "disabled"}</td>
                    <td>
                      <button type="button" className="link-btn" disabled={busyId === ds._id} onClick={() => handleTest(ds)}>
                        Test
                      </button>{" "}
                      <button type="button" className="link-btn" disabled={busyId === ds._id} onClick={() => handleToggleActive(ds)}>
                        {ds.active ? "Disable" : "Enable"}
                      </button>{" "}
                      <button type="button" className="link-btn" disabled={busyId === ds._id} onClick={() => handleDelete(ds)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <form className="panel" onSubmit={handleConnect}>
        <h3>Connect a new data source</h3>
        <p className="muted">
          Paste a lead magnet's own MongoDB connection string and collection name. Fields are auto-discovered — a new tab
          appears above once connected, no restart or code change needed.
        </p>
        {formError && <p className="error">{formError}</p>}

        <label className="form-row">
          Label
          <input
            placeholder="e.g. Free Ebook Signups"
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
            required
          />
        </label>

        <label className="form-row">
          Mongo connection string
          <input
            type="password"
            placeholder="mongodb+srv://user:pass@cluster.mongodb.net/dbname"
            value={form.mongoUri}
            onChange={(e) => setForm({ ...form, mongoUri: e.target.value })}
            required
          />
        </label>

        <label className="form-row">
          Database name (optional if included in the URI)
          <input
            value={form.databaseName}
            onChange={(e) => setForm({ ...form, databaseName: e.target.value })}
          />
        </label>

        <label className="form-row">
          Collection name
          <input
            placeholder="e.g. users"
            value={form.collectionName}
            onChange={(e) => setForm({ ...form, collectionName: e.target.value })}
            required
          />
        </label>

        <div className="form-actions">
          <button type="submit" disabled={connecting}>
            {connecting ? "Testing & connecting…" : "Test & connect"}
          </button>
        </div>
      </form>
    </div>
  );
}
