export default function Pager({ page, totalPages, total, onChange }) {
  return (
    <div className="pager">
      <span className="muted">
        Page {page} of {totalPages} ({total} documents)
      </span>
      <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ‹ prev
      </button>
      <button type="button" aria-label="Next page" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        next ›
      </button>
    </div>
  );
}
