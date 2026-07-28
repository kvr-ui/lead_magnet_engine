import { isValidElement } from "react";
import { formatDisplayValue } from "./formatValue";

function cell(value) {
  if (value === null || value === undefined) return "";
  // A column may return markup (status pills, links) rather than a scalar.
  // Without this it would fall through to the object branch below and render
  // as JSON.
  if (isValidElement(value)) return value;
  if (typeof value === "boolean") return value ? "yes" : "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(formatDisplayValue(value));
}

export default function LeadsTable({ columns, rows, loading, error, onRowClick = null, activeRowId = null }) {
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
            <tr
              key={row._id}
              className={[onRowClick ? "clickable-row" : "", String(row._id) === String(activeRowId) ? "row-active" : ""]
                .filter(Boolean)
                .join(" ")}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
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
