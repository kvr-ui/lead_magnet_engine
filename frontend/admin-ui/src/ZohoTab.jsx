import { useEffect, useState } from "react";
import { fetchContacts } from "./api";
import LeadsTable from "./LeadsTable";
import Pager from "./Pager";

const COLUMNS = [
  { key: "name", header: "Name", get: (d) => d.name },
  { key: "phone", header: "Phone", get: (d) => d.phone },
  { key: "caStatus", header: "CA Level", get: (d) => d.caStatus },
  { key: "city", header: "City", get: (d) => d.city },
  { key: "attempt", header: "Attempt", get: (d) => d.attempt },
  { key: "status", header: "Status", get: (d) => d.status },
  { key: "potential", header: "Potential", get: (d) => d.potential },
  { key: "leadSource", header: "Lead Source", get: (d) => d.leadSource },
  { key: "ownerName", header: "Owner", get: (d) => d.ownerName },
  { key: "notes", header: "Notes", get: (d) => d.notes },
  { key: "createdAt", header: "Created", get: (d) => (d.createdAt ? new Date(d.createdAt).toLocaleString() : "") },
];

export default function ZohoTab() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ contacts: [], total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchContacts(page)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page]);

  return (
    <div>
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
      <LeadsTable columns={COLUMNS} rows={data.contacts} loading={loading} error={error} />
      <Pager page={data.page || page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
    </div>
  );
}
