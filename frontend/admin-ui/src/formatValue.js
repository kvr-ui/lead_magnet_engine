// Mongo Date fields serialize over JSON as full ISO-8601 strings
// ("2026-07-16T14:05:41.269Z") regardless of source (Contact schema,
// any user-connected data source) — detecting that shape
// directly means every table and filter-value picker gets readable dates
// without each caller having to know which of its fields are dates.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/;

export function formatDisplayValue(value) {
  if (typeof value === "string" && ISO_DATE_RE.test(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return value;
}
