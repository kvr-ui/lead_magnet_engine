// Shared "send window" + "skip days" sub-form.
//
// Extracted out of NodeConfigPanel.jsx's wait-node panel (task 11, #39) so
// the Integrations tab's Sending policy panel can reuse the exact same
// from/to/timezone/skip-days inputs for quiet hours instead of building a
// second copy of them. Pure and controlled: the caller owns the
// window/skipDays state (whatever shape it's stored in — a wait node's
// config.window/config.skipDays, or the account policy's
// quietHours.window/quietHours.skipDays) and gets patches back through the
// two callbacks below. No behavior here changed from the original inline
// JSX in WaitPanel.
export const WEEKDAYS = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

export default function WindowScheduleFields({ window: win, skipDays, onChangeWindow, onToggleSkipDay }) {
  const w = win || {};
  const days = skipDays || [];

  return (
    <div>
      <h4>Send window</h4>
      <label className="form-row">
        From
        <input type="time" value={w.from || ""} onChange={(e) => onChangeWindow({ from: e.target.value })} />
      </label>
      <label className="form-row">
        To
        <input type="time" value={w.to || ""} onChange={(e) => onChangeWindow({ to: e.target.value })} />
      </label>
      <label className="form-row">
        Timezone
        <input placeholder="e.g. Asia/Kolkata" value={w.tz || ""} onChange={(e) => onChangeWindow({ tz: e.target.value })} />
      </label>

      <h4>Skip days</h4>
      <div className="value-chip-row">
        {WEEKDAYS.map((d) => (
          <label className="checkbox-row" key={d.value}>
            <input type="checkbox" checked={days.includes(d.value)} onChange={() => onToggleSkipDay(d.value)} />
            {d.label}
          </label>
        ))}
      </div>
    </div>
  );
}
