import { useEffect, useState } from "react";
import { fetchFilterFields, fetchFilterValues } from "./api";
import { formatDisplayValue } from "./formatValue";

const COMPARISON_OPS = [
  { op: "$lt", label: "less than" },
  { op: "$lte", label: "at most" },
  { op: "$gt", label: "greater than" },
  { op: "$gte", label: "at least" },
];

// One filter condition row: pick a field, then either toggle which
// discovered values to include (equality via $in) or compare it against a
// number (e.g. an enrichment metric like totalAttempted < 1). `source` is
// any value getSourceFields on the backend understands —
// "Contact"/"Lead" or "datasource:<id>" for a
// user-connected external collection.
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

  const isCompare = condition.cmp != null;

  function setCompareMode(compare) {
    onChange(
      compare
        ? { ...condition, values: [], cmp: condition.cmp || { op: "$lt", value: "" } }
        : { ...condition, cmp: null }
    );
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
        <>
          <div className="value-chip-row">
            <button type="button" className={`chip ${!isCompare ? "active" : ""}`} onClick={() => setCompareMode(false)}>
              Match values
            </button>
            <button type="button" className={`chip ${isCompare ? "active" : ""}`} onClick={() => setCompareMode(true)}>
              Compare number
            </button>
          </div>

          {!isCompare && (
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
                  {String(formatDisplayValue(v.value)) || "(blank)"} ({v.count})
                </button>
              ))}
            </div>
          )}

          {isCompare && (
            <div className="value-chip-row">
              <select
                value={condition.cmp.op}
                onChange={(e) => onChange({ ...condition, cmp: { ...condition.cmp, op: e.target.value } })}
              >
                {COMPARISON_OPS.map((o) => (
                  <option key={o.op} value={o.op}>
                    {o.label}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Number"
                value={condition.cmp.value}
                onChange={(e) => onChange({ ...condition, cmp: { ...condition.cmp, value: e.target.value } })}
              />
            </div>
          )}
        </>
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
    if (!c.field) continue;
    const num = c.cmp ? Number(c.cmp.value) : null;
    if (c.cmp && c.cmp.value !== "" && !Number.isNaN(num)) {
      filter[c.field] = { [c.cmp.op]: num };
    } else if (c.values?.length) {
      filter[c.field] = { $in: c.values };
    }
  }
  return filter;
}

const CMP_LABELS = { $lt: "<", $lte: "≤", $gt: ">", $gte: "≥" };

// Human-readable one-liner for a filter buildMongoFilter produced — for the
// places a segment has to be shown back without the builder UI around it, like
// the standing segment an auto-enrolling campaign keeps repeating.
//
// An empty filter reads as "everyone in this source" rather than as blank:
// that case is the widest possible segment, not the absence of one, and it
// should never look like nothing is set.
export function describeFilter(filter) {
  const parts = Object.entries(filter || {}).map(([field, value]) => {
    if (value && typeof value === "object") {
      if (Array.isArray(value.$in)) {
        const shown = value.$in.slice(0, 3).join(", ");
        const rest = value.$in.length - 3;
        return `${field} is ${shown}${rest > 0 ? ` +${rest} more` : ""}`;
      }
      const [op] = Object.keys(value);
      if (CMP_LABELS[op]) return `${field} ${CMP_LABELS[op]} ${value[op]}`;
    }
    return `${field} is ${value}`;
  });
  return parts.length ? parts.join(" · ") : "everyone in this source";
}

export default FilterCondition;
