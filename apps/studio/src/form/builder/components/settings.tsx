import { useId, type ReactNode } from 'react';
import { Input } from '@ui/input';
import { Switch } from '@ui/switch';
import { Textarea } from '@ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui/select';
import { VISIBLE_BORDER } from '../../runtime/styles';

/**
 * Small labelled controls for the builder's config panels. Every setting
 * writes straight to the builder store on change, so these are controlled
 * and stateless.
 */

interface SettingProps {
  label: string;
  hint?: ReactNode;
  children: (id: string) => ReactNode;
}

export function Setting({ label, hint, children }: SettingProps) {
  const id = useId();
  return (
    <div className="fb-setting">
      <label className="fb-setting__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <span className="fb-setting__hint">{hint}</span>}
    </div>
  );
}

interface TextSettingProps {
  label: string;
  hint?: ReactNode;
  value: string | undefined;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  type?: string;
  disabled?: boolean;
}

export function TextSetting({ label, hint, value, onChange, placeholder, multiline, type, disabled }: TextSettingProps) {
  return (
    <Setting label={label} hint={hint}>
      {(id) =>
        multiline ? (
          <Textarea
            id={id}
            className={VISIBLE_BORDER}
            rows={3}
            value={value ?? ''}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <Input
            id={id}
            type={type ?? 'text'}
            value={value ?? ''}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
        )
      }
    </Setting>
  );
}

interface NumberSettingProps {
  label: string;
  hint?: ReactNode;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  disabled?: boolean;
}

export function NumberSetting({ label, hint, value, onChange, min, disabled }: NumberSettingProps) {
  return (
    <Setting label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={min}
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(e.target.value === '' || Number.isNaN(n) ? undefined : n);
          }}
        />
      )}
    </Setting>
  );
}

interface SwitchSettingProps {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function SwitchSetting({ label, hint, checked, onChange, disabled }: SwitchSettingProps) {
  const id = useId();
  return (
    <div className="fb-setting">
      <div className="fb-setting fb-setting--inline">
        <label className="fb-setting__label" htmlFor={id}>
          {label}
        </label>
        <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
      </div>
      {hint && <span className="fb-setting__hint">{hint}</span>}
    </div>
  );
}

export interface Choice<T extends string> {
  label: string;
  value: T;
}

interface SelectSettingProps<T extends string> {
  label: string;
  hint?: ReactNode;
  value: T | undefined;
  options: Choice<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function SelectSetting<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  placeholder,
  disabled,
}: SelectSettingProps<T>) {
  return (
    <Setting label={label} hint={hint}>
      {(id) => <ChoiceSelect id={id} value={value} options={options} onChange={onChange} placeholder={placeholder} disabled={disabled} />}
    </Setting>
  );
}

interface ChoiceSelectProps<T extends string> {
  id?: string;
  value: T | undefined;
  options: Choice<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Bare select, for use inside rows where a label above would be noise. */
export function ChoiceSelect<T extends string>({ id, value, options, onChange, placeholder, disabled, ariaLabel }: ChoiceSelectProps<T>) {
  return (
    <Select value={value ?? ''} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectTrigger id={id} className={VISIBLE_BORDER} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder ?? 'Select...'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface ColorSettingProps {
  label: string;
  hint?: ReactNode;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Colour swatch + hex box. Empty = not set (inherits). Only hex is stored. */
export function ColorSetting({ label, hint, value, onChange }: ColorSettingProps) {
  return (
    <Setting label={label} hint={hint}>
      {(id) => (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${label} swatch`}
            value={value && HEX.test(value) && value.length === 7 ? value : '#ffffff'}
            onChange={(e) => onChange(e.target.value)}
            style={{ width: 36, height: 32, padding: 0, border: '1px solid var(--border)', borderRadius: 6, background: 'none' }}
          />
          <Input
            id={id}
            className="fb-code"
            placeholder="#1458e2"
            value={value ?? ''}
            onChange={(e) => onChange(e.target.value.trim() || undefined)}
          />
          {value && (
            <button type="button" className="fb-link" onClick={() => onChange(undefined)}>
              Clear
            </button>
          )}
        </div>
      )}
    </Setting>
  );
}
