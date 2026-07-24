export default function Pager({ page, totalPages, total, onChange }) {
  return (
    <div className="pager">
      <span className="muted">
        Page {page} of {totalPages} ({total} documents)
      </span>
      <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        prev
      </button>
      <button type="button" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        next
      </button>
    </div>
  );
}
