import { useEffect, useState } from "react";
import {
  fetchDataSources,
  createDataSource,
  updateDataSource,
  testDataSource,
  deleteDataSource,
  discoverDataSourceDatabases,
} from "./api";

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

  // Once "Browse databases" succeeds, this holds the real database names on
  // the cluster so the admin picks from a dropdown instead of typing blind.
  // Null = not browsed yet (free-text entry).
  const [databaseOptions, setDatabaseOptions] = useState(null);
  const [browsingDatabases, setBrowsingDatabases] = useState(false);
  const [databaseBrowseError, setDatabaseBrowseError] = useState(null);

  // Which collection to read from is picked automatically on the backend
  // when a database has exactly one. This only gets populated — and the
  // picker only appears — when the backend reports the database has more
  // than one collection and genuinely needs the admin to choose.
  const [ambiguousCollections, setAmbiguousCollections] = useState(null);

  function reload() {
    setLoading(true);
    fetchDataSources()
      .then(setSources)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  function updateForm(patch) {
    setForm((f) => ({ ...f, ...patch }));
    if ("mongoUri" in patch && databaseOptions !== null) setDatabaseOptions(null);
    // Any change to the connection target invalidates a stale ambiguous-
    // collection prompt from a previous submit attempt.
    if (("mongoUri" in patch || "databaseName" in patch) && ambiguousCollections !== null) {
      setAmbiguousCollections(null);
    }
  }

  async function handleBrowseDatabases() {
    setDatabaseBrowseError(null);
    setBrowsingDatabases(true);
    try {
      const { databases } = await discoverDataSourceDatabases({ mongoUri: form.mongoUri });
      setDatabaseOptions(databases);
      if (databases.length && !databases.includes(form.databaseName)) {
        updateForm({ databaseName: databases[0] });
      }
    } catch (err) {
      // Some scoped DB users can't list databases — fall back to typing the
      // name manually rather than treating this as a hard failure.
      setDatabaseBrowseError(`${err.message} — type the database name manually below instead.`);
      setDatabaseOptions(null);
    } finally {
      setBrowsingDatabases(false);
    }
  }

  async function handleConnect(e) {
    e.preventDefault();
    setFormError(null);
    setConnecting(true);
    try {
      const result = await createDataSource(form);
      if (result.connections && result.failures?.length) {
        setFormError(
          `Connected ${result.connections.length} of ${result.connections.length + result.failures.length} collections. ` +
            `Failed: ${result.failures.map((f) => `${f.collectionName} (${f.error})`).join(", ")}`
        );
      }
      setForm(emptyForm());
      setDatabaseOptions(null);
      setAmbiguousCollections(null);
      reload();
      onChanged?.();
    } catch (err) {
      if (err.status === 409 && err.body?.collections) {
        // The database has more than one collection — this is the only case
        // where we ask the admin to pick; otherwise it's chosen automatically.
        setAmbiguousCollections(err.body.collections);
        updateForm({ collectionName: "*" });
      } else {
        setFormError(err.message);
      }
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
          Paste a lead magnet's own MongoDB connection string and pick its database. Fields are auto-discovered — a new
          tab appears above once connected, no restart or code change needed.
        </p>
        {formError && <p className="error">{formError}</p>}

        <label className="form-row">
          Label
          <input
            placeholder="e.g. Free Ebook Signups"
            value={form.label}
            onChange={(e) => updateForm({ label: e.target.value })}
            required
          />
        </label>

        <label className="form-row">
          Mongo connection string
          <input
            type="password"
            placeholder="mongodb+srv://user:pass@cluster.mongodb.net/dbname"
            value={form.mongoUri}
            onChange={(e) => updateForm({ mongoUri: e.target.value })}
            required
          />
        </label>

        <div className="form-row">
          <button
            type="button"
            className="secondary-btn"
            onClick={handleBrowseDatabases}
            disabled={browsingDatabases || !form.mongoUri}
          >
            {browsingDatabases ? "Browsing…" : "Browse databases"}
          </button>
          {databaseBrowseError && <span className="error"> {databaseBrowseError}</span>}
        </div>

        <label className="form-row">
          Database name (optional if included in the URI)
          {databaseOptions && databaseOptions.length > 0 ? (
            <select value={form.databaseName} onChange={(e) => updateForm({ databaseName: e.target.value })}>
              {databaseOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input value={form.databaseName} onChange={(e) => updateForm({ databaseName: e.target.value })} />
          )}
          {databaseOptions && databaseOptions.length === 0 && (
            <span className="muted">No databases found on that connection.</span>
          )}
        </label>

        {ambiguousCollections && (
          <label className="form-row">
            This database has more than one collection — which one holds the leads?
            <select value={form.collectionName} onChange={(e) => updateForm({ collectionName: e.target.value })} required>
              <option value="*">All collections — connect each as its own data source</option>
              {ambiguousCollections.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {form.collectionName === "*" && (
              <span className="muted">
                Each will be labeled "{form.label || "<label>"} — &lt;collection&gt;".
              </span>
            )}
          </label>
        )}

        <div className="form-actions">
          <button type="submit" disabled={connecting}>
            {connecting ? "Testing & connecting…" : "Test & connect"}
          </button>
        </div>
      </form>
    </div>
  );
}
