import { useId, useState, type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { AlertCircle, CheckCircle2, Info, Layers, TriangleAlert } from 'lucide-react';
import { ApiError, errorMessage } from '../lib/api';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  block?: boolean;
  busy?: boolean;
};

export function Button({ variant = 'primary', size = 'md', block, busy, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  const cls = ['st-btn', `st-btn--${variant}`, size === 'sm' && 'st-btn--sm', block && 'st-btn--block', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy && <span className="st-spinner" aria-hidden />}
      {children}
    </button>
  );
}

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/** A labelled control with its hint and error wired up for screen readers. */
export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const described = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="st-field">
      <label htmlFor={id}>{label}</label>
      {children(id, described)}
      {error ? (
        <span id={`${id}-error`} className="st-field__error">
          {error}
        </span>
      ) : hint ? (
        <span id={`${id}-hint`} className="st-field__hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextField({ label, hint, error, className, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string }) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, describedBy) => <input id={id} className={['st-input', className].filter(Boolean).join(' ')} aria-invalid={!!error || undefined} aria-describedby={describedBy} {...input} />}
    </Field>
  );
}

export function SelectField({ label, hint, error, children, ...select }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: ReactNode; error?: string }) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, describedBy) => (
        <select id={id} className="st-select" aria-describedby={describedBy} {...select}>
          {children}
        </select>
      )}
    </Field>
  );
}

const ALERT_ICON = { error: AlertCircle, success: CheckCircle2, info: Info, warn: TriangleAlert };

export function Alert({ tone, children }: { tone: 'error' | 'success' | 'info' | 'warn'; children: ReactNode }) {
  const Icon = ALERT_ICON[tone];
  return (
    <div className={`st-alert st-alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={16} aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export function Badge({ tone, children }: { tone?: 'accent' | 'success' | 'warn' | 'danger'; children: ReactNode }) {
  return <span className={`st-badge${tone ? ` st-badge--${tone}` : ''}`}>{children}</span>;
}

export function Card({ title, subtitle, actions, children, bodyless }: { title?: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; bodyless?: boolean }) {
  return (
    <section className="st-card" aria-label={title}>
      {(title || actions) && (
        <div className="st-card__head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions}
        </div>
      )}
      {bodyless ? children : <div className="st-card__body">{children}</div>}
    </section>
  );
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="st-page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export function Avatar({ name }: { name: string }) {
  return (
    <span className="st-avatar" aria-hidden>
      {initials(name)}
    </span>
  );
}

export function Logo() {
  return (
    <span className="st-logo">
      <span className="st-logo__mark">
        <Layers size={18} />
      </span>
      Form Builder
    </span>
  );
}

/** 0-3: a rough guide only; the server's rule is 10+ characters. */
export function passwordLevel(pw: string): 0 | 1 | 2 | 3 {
  if (!pw) return 0;
  if (pw.length < 10) return 1;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  return pw.length >= 14 || kinds >= 3 ? 3 : 2;
}

export function PasswordStrength({ value }: { value: string }) {
  const level = passwordLevel(value);
  const text = ['At least 10 characters', 'Too short', 'Good', 'Strong'][level];
  return (
    <div className="st-stack" style={{ gap: 6 }}>
      <div className="st-strength" data-level={level} aria-hidden>
        <i />
        <i />
        <i />
      </div>
      <span className="st-field__hint">{text}</span>
    </div>
  );
}

/**
 * Submit handling for small forms: busy state, a top-level message and the
 * server's per-field messages.
 */
export function useSubmit<T>(action: () => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [fields, setFields] = useState<Record<string, string>>({});
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    setFields({});
    try {
      return await action();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) setFields(err.fields);
      setError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, fields, submit, setError };
}
