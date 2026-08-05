import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Anything a keyboard user could land on inside the dialog, for the focus
// trap and for picking where focus lands on open.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Reusable confirm/cancel dialog — the admin UI's first modal, meant to
 * replace `window.confirm` on actions with real consequences (sending a
 * campaign, deleting one).
 *
 * There is no `open` prop: mounting this component *is* opening it. A caller
 * keeps "which thing am I confirming" in its own state and renders
 * `<ConfirmDialog .../>` only while that state is set, so closing it (confirm,
 * cancel, backdrop, Escape) is just a matter of the caller clearing that
 * state — this component never has to model its own "closed" state.
 *
 * `children` is the dialog body and can be arbitrary structured JSX (labelled
 * stat rows, a warning paragraph) rather than a message string, so a caller
 * isn't forced to flatten everything into one line with embedded `\n`s the
 * way `window.confirm` requires.
 */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  pendingRef.current = pending;

  // Move focus into the dialog on mount, and back to whatever had it once
  // the dialog goes away. Also pin the page underneath so it can't scroll
  // behind the backdrop while the dialog is up.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const node = dialogRef.current;
    const firstFocusable = node?.querySelector(FOCUSABLE_SELECTOR);
    (firstFocusable || node)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  function cancel() {
    // A cancel mid-flight (Escape, backdrop click) while the confirm action
    // is still pending would abandon the dialog while its own async request
    // is still in the air; block it the same as a second confirm click.
    if (pendingRef.current) return;
    onCancel?.();
  }

  // Escape-to-cancel and a manual Tab trap, both scoped to this dialog only
  // (there is no other modal in the tree for them to conflict with).
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key !== "Tab") return;

      const node = dialogRef.current;
      if (!node) return;
      const focusable = Array.from(node.querySelectorAll(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
    // `cancel` reads pendingRef.current at call time rather than closing over
    // `pending`, so it doesn't need to be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConfirm() {
    if (pendingRef.current) return;
    const result = onConfirm?.();
    // Only a promise-returning confirm needs a pending state; a synchronous
    // one has already finished by the time this line runs.
    if (result && typeof result.then === "function") {
      setPending(true);
      try {
        await result;
      } finally {
        setPending(false);
      }
    }
  }

  function onBackdropMouseDown(e) {
    // Only the backdrop itself, not a click that started inside the dialog
    // and bubbled — mousedown target is the actual element under the cursor.
    if (e.target === e.currentTarget) cancel();
  }

  return createPortal(
    <div className="confirm-dialog-backdrop" onMouseDown={onBackdropMouseDown}>
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={dialogRef} tabIndex={-1}>
        <h3 id={titleId} className="confirm-dialog-title">
          {title}
        </h3>
        <div className="confirm-dialog-body">{children}</div>
        <div className="confirm-dialog-actions form-actions">
          <button type="button" className="secondary-btn" onClick={cancel} disabled={pending}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={destructive ? "confirm-dialog-confirm destructive" : "confirm-dialog-confirm"}
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
