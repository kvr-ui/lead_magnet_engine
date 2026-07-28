import { formatDisplayValue } from "./formatValue";

function cell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "yes" : "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(formatDisplayValue(value));
}

export default function LeadsTable({ columns, rows, loading, error }) {
  if (loading) {
    return (
      <div className="table-wrap table-state">
        <span className="spinner" /> <span className="muted">Loading…</span>
      </div>
    );
  }
  if (error) return <div className="table-wrap table-state error">{error}</div>;
  if (!rows.length) return <div className="table-wrap table-state muted">No documents.</div>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key}>{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row._id}>
              {columns.map((col) => (
                <td key={col.key}>{cell(col.get(row))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
