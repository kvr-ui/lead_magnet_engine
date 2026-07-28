import { Fragment, useEffect, useState } from "react";
import {
  fetchDataSources,
  createDataSource,
  updateDataSource,
  testDataSource,
  deleteDataSource,
  discoverDataSourceDatabases,
  fetchRelatedCollections,
  fetchRelatedCollectionFields,
} from "./api";

function emptyForm() {
  return { label: "", mongoUri: "", databaseName: "", collectionName: "" };
}

// Lets the admin join a related collection in the same database and sum
// numeric fields across every matched row — e.g. CA Guru's per-subject MCQ
// progress rows summed into total attempted/correct counts per student, so
// campaigns can filter/target on them like any other field.
function EnrichEditor({ ds, onSaved, onClose }) {
  const [collections, setCollections] = useState(null);
  const [collectionsError, setCollectionsError] = useState(null);
  const [collection, setCollection] = useState(ds.enrich?.collection || "");
  const [relatedFields, setRelatedFields] = useState([]);
  const [localField, setLocalField] = useState(ds.enrich?.localField || "");
  const [foreignField, setForeignField] = useState(ds.enrich?.foreignField || "");
  const [sumFields, setSumFields] = useState(ds.enrich?.sumFields || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchRelatedCollections(ds._id)
      .then((d) => setCollections(d.collections))
      .catch((err) => setCollectionsError(err.message));
  }, [ds._id]);

  useEffect(() => {
    if (!collection) {
      setRelatedFields([]);
      return;
    }
    fetchRelatedCollectionFields(ds._id, collection)
      .then((d) => setRelatedFields(d.fields))
      .catch(() => setRelatedFields([]));
  }, [ds._id, collection]);

  function toggleSumField(name, checked) {
    setSumFields((prev) => (checked ? [...prev, name] : prev.filter((n) => n !== name)));
  }

  async function handleSave() {
    setError(null);
    if (!collection || !localField || !foreignField || !sumFields.length) {
      setError("Pick a collection, both join fields, and at least one field to sum.");
      return;
    }
    setSaving(true);
    try {
      await updateDataSource(ds._id, { enrich: { collection, localField, foreignField, sumFields } });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setSaving(true);
    try {
      await updateDataSource(ds._id, { enrich: null });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="enrich-editor">
      <p className="muted">
        Join a related collection in the same database and sum numeric fields across every matched row into new
        fields on "{ds.label}" — usable as real filter fields for campaigns, same as any other column.
      </p>
      {error && <p className="error">{error}</p>}
      {collectionsError && <p className="error">{collectionsError}</p>}

      <label className="form-row">
        Related collection
        <select
          value={collection}
          onChange={(e) => {
            setCollection(e.target.value);
            setForeignField("");
            setSumFields([]);
          }}
        >
          <option value="">Pick a collection…</option>
          {(collections || []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label className="form-row">
        Join field on "{ds.collectionName}" (this data source)
        <select value={localField} onChange={(e) => setLocalField(e.target.value)}>
          <option value="">Pick a field…</option>
          {(ds.fieldsCache || []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label className="form-row">
        Matching field on "{collection || "<related collection>"}"
        <select value={foreignField} onChange={(e) => setForeignField(e.target.value)} disabled={!collection}>
          <option value="">Pick a field…</option>
          {relatedFields.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      {collection && (
        <div className="form-row">
          Numeric fields to sum across every matched "{collection}" row
          {relatedFields.map((name) => (
            <label key={name} className="checkbox-row">
              <input type="checkbox" checked={sumFields.includes(name)} onChange={(e) => toggleSumField(name, e.target.checked)} />
              {name}
            </label>
          ))}
        </div>
      )}

      <div className="form-actions">
        <button type="button" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save enrichment"}
        </button>
        {ds.enrich && (
          <button type="button" className="secondary-btn" onClick={handleRemove} disabled={saving}>
            Remove enrichment
          </button>
        )}
        <button type="button" className="link-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function DataSourcesTab({ onChanged }) {
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [connecting, setConnecting] = useState(false);
  const [formError, setFormError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [enrichOpenId, setEnrichOpenId] = useState(null);

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
    if (ambiguousCollections && form.collectionName.length === 0) {
      setFormError("Pick at least one collection.");
      return;
    }
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
        updateForm({ collectionName: [] });
      } else {
        setFormError(err.message);
      }
    } finally {
      setConnecting(false);
    }
  }

  function toggleCollection(name, checked) {
    setForm((f) => ({
      ...f,
      collectionName: checked
        ? [...f.collectionName, name]
        : f.collectionName.filter((n) => n !== name),
    }));
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
                  <Fragment key={ds._id}>
                    <tr>
                      <td>{ds.label}</td>
                      <td>
                        {ds.collectionName}
                        {ds.enrich && <div className="muted">+ {ds.enrich.collection} ({ds.enrich.sumFields.join(", ")})</div>}
                      </td>
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
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => setEnrichOpenId(enrichOpenId === ds._id ? null : ds._id)}
                        >
                          {enrichOpenId === ds._id ? "Close" : ds.enrich ? "Edit enrichment" : "Enrich"}
                        </button>{" "}
                        <button type="button" className="link-btn" disabled={busyId === ds._id} onClick={() => handleDelete(ds)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                    {enrichOpenId === ds._id && (
                      <tr>
                        <td colSpan={6}>
                          <EnrichEditor
                            ds={ds}
                            onSaved={() => {
                              setEnrichOpenId(null);
                              reload();
                            }}
                            onClose={() => setEnrichOpenId(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
          <div className="form-row">
            This database has more than one collection — pick which ones hold leads (each becomes its own data source):
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.collectionName.length === ambiguousCollections.length}
                onChange={(e) => updateForm({ collectionName: e.target.checked ? [...ambiguousCollections] : [] })}
              />
              Select all
            </label>
            {ambiguousCollections.map((name) => (
              <label key={name} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={form.collectionName.includes(name)}
                  onChange={(e) => toggleCollection(name, e.target.checked)}
                />
                {name}
              </label>
            ))}
            {form.collectionName.length > 1 && (
              <span className="muted">
                Each will be labeled "{form.label || "<label>"} — &lt;collection&gt;".
              </span>
            )}
          </div>
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
