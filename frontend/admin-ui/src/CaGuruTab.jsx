import { useEffect, useMemo, useState } from "react";
import { fetchAdMagnetStudentFields, fetchAdMagnetStudents } from "./api";
import FieldPicker from "./FieldPicker";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";

const STORAGE_KEY = "leads:columns:ca-guru";

// Shown by default until the user picks otherwise; everything else the DB
// has (examDate, lastLogin, freeTrialUsed, ...) is available but hidden.
const DEFAULT_VISIBLE = [
  "name",
  "email",
  "phoneNumber",
  "city",
  "caLevel",
  "attemptGiven",
  "mcqAttempted",
  "mcqCorrect",
  "accuracy",
  "createdAt",
];

const LABELS = {
  phoneNumber: "Phone",
  caLevel: "CA Level",
  attemptGiven: "Attempt",
  mcqAttempted: "MCQs Solved",
  mcqCorrect: "MCQs Correct",
  accuracy: "Accuracy",
  createdAt: "Signed Up",
};

function humanize(key) {
  if (LABELS[key]) return LABELS[key];
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const DATE_KEY_RE = /date|At$|login/i;

function formatValue(key, value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "no";
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

export default function CaGuruTab() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [data, setData] = useState({ students: [], total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [dbFields, setDbFields] = useState(null);
  const [visible, setVisible] = useState(loadVisible);

  useEffect(() => {
    fetchAdMagnetStudentFields()
      .then((d) => setDbFields(d.fields))
      .catch(() => setDbFields([]));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchAdMagnetStudents(page, search)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, search]);

  function updateVisible(next) {
    setVisible(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  const allColumns = useMemo(() => {
    // mcqAttempted/mcqCorrect are computed on the backend, accuracy purely on
    // the frontend — none are real DB columns, so union them in explicitly.
    const computed = ["mcqAttempted", "mcqCorrect", "accuracy"];
    const keys = [...new Set([...(dbFields || []), ...computed])];
    return keys.map((key) => ({
      key,
      header: humanize(key),
      get: (d) =>
        key === "accuracy"
          ? d.mcqAttempted
            ? `${Math.round((d.mcqCorrect / d.mcqAttempted) * 100)}%`
            : ""
          : formatValue(key, d[key]),
    }));
  }, [dbFields]);

  const columns = allColumns.filter((c) => visible.includes(c.key));

  if (error && !data.students.length) {
    return <p className="notice">{error}. Set AD_MAGNET_MONGODB_URI in .env and restart.</p>;
  }

  return (
    <div>
      <input
        type="text"
        placeholder="Search by name, email, or phone…"
        defaultValue={search}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            setPage(1);
            setSearch(e.currentTarget.value.trim());
          }
        }}
        className="search-input"
      />
      <FieldPicker allFields={allColumns.map(({ key, header }) => ({ key, label: header }))} visible={visible} onChange={updateVisible} />
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
      <LeadsTable columns={columns} rows={data.students} loading={loading} error={error} />
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
    </div>
  );
}
