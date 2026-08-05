import { useEffect, useRef, useState } from "react";
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
//
// `narrowBy` is the filter the OTHER conditions in the same builder already
// express. The counts on each chip are taken within it, so "how many CA
// Intermediate leads sit the September attempt" is what the row answers rather
// than "how many leads in the entire source do". Defaulted to {} so a caller
// that doesn't pass it gets the old whole-source counts.
export function FilterCondition({ source, condition, onChange, onRemove, narrowBy = {} }) {
  const [fields, setFields] = useState([]);
  const [values, setValues] = useState([]);
  const [loadingValues, setLoadingValues] = useState(false);

  useEffect(() => {
    fetchFilterFields(source)
      .then((d) => setFields(d.fields))
      .catch(() => setFields([]));
  }, [source]);

  // Serialized rather than passed as an object: the parent rebuilds this filter
  // on every render, so a bare object would differ by identity each time and
  // refetch forever.
  const narrowKey = JSON.stringify(narrowBy || {});
  // Held in a ref, not read as a dependency: the fetch needs the current
  // selection to know which chips to keep alive, but selecting one must not
  // itself trigger a refetch or every click would reload the row it was made in.
  const selectedRef = useRef(condition.values);
  selectedRef.current = condition.values;

  useEffect(() => {
    if (!condition.field) {
      setValues([]);
      return;
    }
    let live = true;
    setLoadingValues(true);
    fetchFilterValues(source, condition.field, JSON.parse(narrowKey))
      .then((d) => {
        if (!live) return;
        // A value that narrows to zero is simply absent from the response, which
        // is what keeps the row to real choices. One exception: a value already
        // selected has to stay on screen at (0), or narrowing would make a chip
        // vanish while it was still in the saved filter — invisible and
        // impossible to click off.
        const returned = new Set((d.values || []).map((v) => String(v.value)));
        const orphaned = (selectedRef.current || [])
          .filter((v) => !returned.has(String(v)))
          .map((value) => ({ value, count: 0 }));
        setValues([...(d.values || []), ...orphaned]);
      })
      .catch(() => live && setValues([]))
      .finally(() => live && setLoadingValues(false));
    // Ignore a response that arrives after the field or the narrowing changed:
    // out of order, it would paint one field's values under another's heading.
    return () => {
      live = false;
    };
  }, [source, condition.field, narrowKey]);

  function toggleValue(v) {
    const selected = condition.values.includes(v)
      ? condition.values.filter((x) => x !== v)
      : [...condition.values, v];
    onChange({ ...condition, values: selected });
  }

  const isCompare = condition.cmp != null;

  // A zero-count chip only earns its place while it is still selected. Once it
  // is clicked off it is a choice that matches nobody, so it goes rather than
  // sitting there as a dead "(0)" until the next fetch happens to drop it.
  const shown = values.filter((v) => v.count > 0 || condition.values.includes(v.value));

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
              {!loadingValues && !shown.length && (
                <span className="muted">
                  {Object.keys(narrowBy || {}).length
                    ? "No values for this field within the conditions above."
                    : "No values found for this field."}
                </span>
              )}
              {shown.map((v) => (
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

// The same job as describeFilter, for the shape a campaign *stores* once
// auto-enroll is armed. That is no longer a bare Mongo filter: /enroll writes
// `{ graphVersion, confirmedAt, sources: [{ nodeId, sourceId, filter }] }` —
// one entry per source node of the graph it confirmed, because a graph can
// enrol from several sources at once and "the segment" is their union.
//
// Handing that object to describeFilter is what produced the nonsense the
// status strip used to show ("graphVersion is 3 · sources is [object
// Object]"): every top-level key was read as a field name. Rather than
// teaching describeFilter about a shape that isn't a filter, this wraps it and
// calls it per source, where it is correct.
//
// Rows armed before the graph migration stored a flat Mongo filter here, so
// anything without a `sources` array is still passed straight through — an old
// campaign should read as what it actually repeats, not as "no segment".
export function describeAutoEnrollFilter(autoEnrollFilter, sourceLabels = {}) {
  if (!autoEnrollFilter || typeof autoEnrollFilter !== "object") return "no segment stored";
  const sources = autoEnrollFilter.sources;
  if (!Array.isArray(sources)) return describeFilter(autoEnrollFilter);
  if (!sources.length) return "no segment stored";

  return sources
    .map((s) => {
      const label = sourceLabels[s.sourceId] || s.sourceId || "an unnamed source";
      const filter = s.filter || {};
      // describeFilter's empty case already reads "everyone in this source",
      // which would repeat the source name if appended with "where".
      return Object.keys(filter).length ? `${label} where ${describeFilter(filter)}` : `everyone in ${label}`;
    })
    .join("; ");
}

export default FilterCondition;
