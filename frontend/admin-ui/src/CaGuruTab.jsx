import { useEffect, useState } from "react";
import { fetchAdMagnetStudents } from "./api";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";

const COLUMNS = [
  { key: "name", header: "Name", get: (d) => d.name },
  { key: "email", header: "Email", get: (d) => d.email },
  { key: "phoneNumber", header: "Phone", get: (d) => d.phoneNumber },
  { key: "city", header: "City", get: (d) => d.city },
  { key: "caLevel", header: "CA Level", get: (d) => d.caLevel },
  { key: "attemptGiven", header: "Attempt", get: (d) => d.attemptGiven },
  { key: "mcqAttempted", header: "MCQs Solved", get: (d) => d.mcqAttempted || 0 },
  { key: "mcqCorrect", header: "MCQs Correct", get: (d) => d.mcqCorrect || 0 },
  {
    key: "accuracy",
    header: "Accuracy",
    get: (d) => (d.mcqAttempted ? `${Math.round((d.mcqCorrect / d.mcqAttempted) * 100)}%` : ""),
  },
  { key: "createdAt", header: "Signed Up", get: (d) => (d.createdAt ? new Date(d.createdAt).toLocaleDateString() : "") },
];

export default function CaGuruTab() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [data, setData] = useState({ students: [], total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchAdMagnetStudents(page, search)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, search]);

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
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
      <LeadsTable columns={COLUMNS} rows={data.students} loading={loading} error={error} />
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
    </div>
  );
}
