import { useEffect, useMemo, useState } from "react";
import { fetchDataSourceFields, fetchDataSourceDocuments } from "./api";
import FieldPicker from "./FieldPicker";
import FilterCondition, { buildMongoFilter } from "./FilterBuilder";
import LeadsTable from "./LeadsTable";
import MoveToCampaign from "./MoveToCampaign";
import Pager from "./Pager";

function humanize(key) {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function loadVisible(storageKey, defaultVisible) {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    // ignore malformed storage
  }
  return defaultVisible;
}

// Generic replacement for a hand-written per-lead-magnet tab (like the
// original CaGuruTab/ZohoTab): given a DataSourceConnection id, this
// discovers its fields, and renders the same field-picker + filter +
// paginated table pattern for any connected external collection.
export default function LeadMagnetDataTab({ dataSourceId, label, onOpenCampaigns }) {
  const storageKey = `leads:columns:datasource:${dataSourceId}`;
  const source = `datasource:${dataSourceId}`;

  const [fields, setFields] = useState(null);
  const [fieldsError, setFieldsError] = useState(null);
  const [visible, setVisible] = useState(() => loadVisible(storageKey, []));
  const [conditions, setConditions] = useState([]);
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ documents: [], total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setFields(null);
    fetchDataSourceFields(dataSourceId)
      .then((d) => {
        setFields(d.fields);
        setVisible((current) => (current.length ? current : d.fields.map((f) => f.key)));
      })
      .catch((err) => setFieldsError(err.message));
  }, [dataSourceId]);

  const filter = buildMongoFilter(conditions);
  const filterKey = JSON.stringify(filter);

  useEffect(() => setPage(1), [filterKey, dataSourceId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchDataSourceDocuments(dataSourceId, page, filter)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataSourceId, page, filterKey]);

  function updateVisible(next) {
    setVisible(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  }

  const allColumns = useMemo(() => {
    return (fields || []).map(({ key, label: fieldLabel }) => ({
      key,
      header: fieldLabel || humanize(key),
      get: (d) => d[key],
    }));
  }, [fields]);

  const columns = allColumns.filter((c) => visible.includes(c.key));

  if (fieldsError) {
    return <p className="notice">{fieldsError}. Check the connection from the Data Sources tab.</p>;
  }

  return (
    <div>
      <h3>{label}</h3>

      {conditions.map((c, i) => (
        <FilterCondition
          key={i}
          source={source}
          condition={c}
          // Counted within the other conditions, same as the campaign builder —
          // see the note there.
          narrowBy={buildMongoFilter(conditions.filter((_, idx) => idx !== i))}
          onChange={(next) => setConditions(conditions.map((cc, idx) => (idx === i ? next : cc)))}
          onRemove={() => setConditions(conditions.filter((_, idx) => idx !== i))}
        />
      ))}
      <div className="filter-actions">
        <button type="button" className="link-btn" onClick={() => setConditions([...conditions, { field: "", values: [] }])}>
          + add condition
        </button>
        <MoveToCampaign
          source={source}
          filter={filter}
          filterKey={filterKey}
          matchCount={data.total}
          onOpenCampaigns={onOpenCampaigns}
        />
      </div>

      <FieldPicker allFields={allColumns.map(({ key, header }) => ({ key, label: header }))} visible={visible} onChange={updateVisible} />
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
      <LeadsTable columns={columns} rows={data.documents} loading={loading} error={error} />
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
    </div>
  );
}
