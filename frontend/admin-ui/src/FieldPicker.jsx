import { useEffect, useRef, useState } from "react";

// Dropdown checklist for choosing which columns to show in a LeadsTable.
// `allFields` is [{ key, label }], `visible` is an array of selected keys.
export default function FieldPicker({ allFields, visible, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function toggle(key) {
    onChange(visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key]);
  }

  return (
    <div className="field-picker" ref={ref}>
      <button type="button" className="secondary-btn" onClick={() => setOpen((o) => !o)}>
        Columns ({visible.length}/{allFields.length}) {open ? "▴" : "▾"}
      </button>
      {open && (
        <div className="field-picker-menu">
          <div className="field-picker-actions">
            <button type="button" className="link-btn" onClick={() => onChange(allFields.map((f) => f.key))}>
              Select all
            </button>
            <button type="button" className="link-btn" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          {allFields.map((f) => (
            <label key={f.key} className="field-picker-item">
              <input type="checkbox" checked={visible.includes(f.key)} onChange={() => toggle(f.key)} />
              {f.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
