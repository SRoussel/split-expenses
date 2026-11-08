import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    // Stop the page behind the sheet from scrolling (iOS especially).
    document.body.classList.add("locked");
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.classList.remove("locked");
    };
  }, [onClose]);

  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** In-app replacement for window.confirm, which looks out of place in a home-screen app. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack">
        <p>{message}</p>
        <ErrorText message={error} />
        <div className="actions-row">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={danger ? "danger" : "primary"} onClick={() => void confirm()} disabled={busy}>
            {busy ? "One moment…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p className="error" role="alert">
      {message}
    </p>
  ) : null;
}

/** Password field with a Show / Hide button. */
export function PasswordInput({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  const hintId = useId();
  return (
    <label>
      {label}
      <span className="with-button">
        <input {...props} type={shown ? "text" : "password"} aria-describedby={hint ? hintId : undefined} />
        <button
          type="button"
          className="inline-btn"
          onClick={() => setShown(!shown)}
          aria-label={shown ? "Hide password" : "Show password"}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </span>
      {hint && (
        <span id={hintId} className="hint">
          {hint}
        </span>
      )}
    </label>
  );
}

/** Dollar amount field with a $ in front. */
export function MoneyInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode">) {
  return (
    <span className="money">
      <span aria-hidden="true">$</span>
      <input {...props} inputMode="decimal" placeholder={props.placeholder ?? "0.00"} />
    </span>
  );
}

export interface ToastState {
  message: string;
  /** Optional button, e.g. Undo. The toast stays up longer when there is one. */
  action?: { label: string; onClick: () => void };
}

/** Short message at the bottom of the screen that fades away. */
export function Toast({ toast, onDone }: { toast: ToastState | null; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDone, toast.action ? 6000 : 2200);
    return () => clearTimeout(t);
  }, [toast, onDone]);
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <span>{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action!.onClick();
            onDone();
          }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

/** One printed line of a tally: label, dotted leader, amount. */
export function TallyLine({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`tally-line ${className}`}>
      <span>{label}</span>
      <span className="lead" aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}

/** A choice between a few options: boxed inside forms (who paid), or `tabs` for switching views. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  tabs = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label?: string;
  tabs?: boolean;
}) {
  return (
    <div className={`segmented${tabs ? " tabs" : ""}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={value === o.value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
