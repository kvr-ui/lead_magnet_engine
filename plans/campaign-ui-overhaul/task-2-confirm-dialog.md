---
task: 2
name: confirm-dialog
parallel_group: 1
depends_on: []
issue: 19
---

# Task 2: Themed confirm dialog component

## What to build

A reusable confirmation dialog for the admin UI, to replace `window.confirm` on actions that carry
real consequences. The admin UI has no modal component today and no third-party UI library — this is
the first one.

The dialog takes a title, arbitrary children as its body (so callers can pass structured content —
labelled rows of statistics, a warning paragraph — rather than a string with `\n` in it), a
confirm-button label, and callbacks for confirm and cancel. It must support marking the confirm
action as destructive so it can be styled accordingly.

Behaviour it must have:

- Renders above the page with a backdrop; clicking the backdrop cancels.
- `Escape` cancels.
- Focus moves into the dialog when it opens, and returns to whatever was focused when it closes.
- `Tab` stays within the dialog while it is open.
- Correct dialog semantics for screen readers, with the title announced as the dialog's name.
- The confirm button can be put into a pending state while an async action runs, so a slow send or
  delete cannot be double-fired.

Styling goes in the existing global stylesheet, matching the established dark theme — reuse the CSS
custom properties already defined there rather than introducing new colour literals, and follow the
conventions of the existing `.panel` and button classes so it does not look bolted on.

This task delivers the component and its styles only. Wiring it into the send and delete actions is
task 8's job — do not modify `CampaignsTab.jsx`.

## Acceptance criteria

- [ ] A new dialog component exists, accepting title, body children, confirm label, destructive
      flag, and confirm/cancel callbacks.
- [ ] Backdrop click and `Escape` both cancel.
- [ ] Focus moves into the dialog on open, is trapped while open, and is restored on close.
- [ ] The dialog exposes correct dialog semantics and an accessible name to assistive tech.
- [ ] The confirm button supports a pending state that prevents double submission.
- [ ] Styles live in the global stylesheet and use existing theme custom properties — no new
      hardcoded colours.
- [ ] No other component is modified by this task.
- [ ] `npm run build` and `npm run lint` succeed in `frontend/admin-ui`.

## Commit convention

Your commit message MUST include `Closes #19` so the task's GitHub issue closes when
the commit lands on the default branch.
