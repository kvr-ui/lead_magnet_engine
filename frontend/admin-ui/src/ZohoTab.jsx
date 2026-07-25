import { useEffect, useMemo, useState } from "react";
import { fetchContactFields, fetchContacts } from "./api";
import FieldPicker from "./FieldPicker";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";

const STORAGE_KEY = "leads:columns:zoho";

// Shown by default until the user picks otherwise; everything else the
// Contact schema has (email, company, firstName/lastName, ...) is available
// but hidden.
const DEFAULT_VISIBLE = [
  "name",
  "phone",
  "caStatus",
  "city",
  "attempt",
  "status",
  "potential",
  "leadSource",
  "ownerName",
  "notes",
  "createdAt",
];

const LABELS = {
  caStatus: "CA Level",
  leadSource: "Lead Source",
  ownerName: "Owner",
  createdAt: "Created",
  updatedAt: "Updated",
  firstName: "First Name",
  lastName: "Last Name",
  biginId: "Bigin ID",
  referralDate: "Referral Date",
};

function humanize(key) {
  if (LABELS[key]) return LABELS[key];
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const DATE_KEY_RE = /date|At$/i;

function formatValue(key, value) {
  if (value === null || value === undefined) return "";
  if (DATE_KEY_RE.test(key)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return value;
}

function loadVisible() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(stored) && stored.length) return stored;
  } catch {
    // ignore malformed storage
  }
  return DEFAULT_VISIBLE;
}

export default function ZohoTab() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ contacts: [], total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dbFields, setDbFields] = useState(null);
  const [visible, setVisible] = useState(loadVisible);

  useEffect(() => {
    fetchContactFields()
      .then((d) => setDbFields(d.fields))
      .catch(() => setDbFields([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchContacts(page)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page]);

  function updateVisible(next) {
    setVisible(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  const allColumns = useMemo(
    () =>
      (dbFields || []).map((key) => ({
        key,
        header: humanize(key),
        get: (d) => formatValue(key, d[key]),
      })),
    [dbFields]
  );

  const columns = allColumns.filter((c) => visible.includes(c.key));

  return (
    <div>
      <FieldPicker allFields={allColumns.map(({ key, header }) => ({ key, label: header }))} visible={visible} onChange={updateVisible} />
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
      <LeadsTable columns={columns} rows={data.contacts} loading={loading} error={error} />
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
    </div>
  );
}
