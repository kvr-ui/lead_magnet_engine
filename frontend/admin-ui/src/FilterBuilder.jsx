import { useEffect, useState } from "react";
import { fetchFilterFields, fetchFilterValues } from "./api";

// One filter condition row: pick a field, then toggle which discovered
// values to include (equality via $in). `source` is any value getSourceFields
// on the backend understands — "Contact"/"Lead"/"AdMagnetStudent" or
// "datasource:<id>" for a user-connected external collection.
export function FilterCondition({ source, condition, onChange, onRemove }) {
  const [fields, setFields] = useState([]);
  const [values, setValues] = useState([]);
  const [loadingValues, setLoadingValues] = useState(false);

  useEffect(() => {
    fetchFilterFields(source)
      .then((d) => setFields(d.fields))
      .catch(() => setFields([]));
  }, [source]);

  useEffect(() => {
    if (!condition.field) {
      setValues([]);
      return;
    }
    setLoadingValues(true);
    fetchFilterValues(source, condition.field)
      .then((d) => setValues(d.values))
      .catch(() => setValues([]))
      .finally(() => setLoadingValues(false));
  }, [source, condition.field]);

  function toggleValue(v) {
    const selected = condition.values.includes(v)
      ? condition.values.filter((x) => x !== v)
      : [...condition.values, v];
    onChange({ ...condition, values: selected });
  }

  return (
    <div className="condition-row">
      <select
        value={condition.field}
        onChange={(e) => onChange({ field: e.target.value, values: [] })}
      >
        <option value="">Pick a field…</option>
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>

      {condition.field && (
        <div className="value-chip-row">
          {loadingValues && <span className="muted">Loading values…</span>}
          {!loadingValues && !values.length && <span className="muted">No values found for this field.</span>}
          {values.map((v) => (
            <button
              type="button"
              key={String(v.value)}
              className={`chip ${condition.values.includes(v.value) ? "active" : ""}`}
              onClick={() => toggleValue(v.value)}
            >
              {String(v.value) || "(blank)"} ({v.count})
            </button>
          ))}
        </div>
      )}

      <button type="button" className="link-btn" onClick={onRemove}>
        remove condition
      </button>
    </div>
  );
}

export function buildMongoFilter(conditions) {
  const filter = {};
  for (const c of conditions) {
    if (c.field && c.values.length) filter[c.field] = { $in: c.values };
  }
  return filter;
}

export default FilterCondition;
