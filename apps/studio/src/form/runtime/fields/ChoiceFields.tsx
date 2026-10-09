import { useUi } from '../FormRuntimeContext';
import { useId } from 'react';
import { useFormContext } from 'react-hook-form';
import { Minus, Plus } from 'lucide-react';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@ui/form';
import { Checkbox } from '@ui/checkbox';
import { Input } from '@ui/input';
import { Label } from '@ui/label';
import { Switch } from '@ui/switch';
import { optionsPlaceholder, useFieldOptions } from '../hooks/useFieldOptions';
import { FieldShell, RequiredMark } from './FieldShell';
import { VISIBLE_BORDER, errorText } from '../styles';
import type { FieldComponentProps } from './types';

/** On/off. The label sits beside the switch, like a checkbox. */
export function SwitchField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FormItem>
          <div className="flex items-center gap-2">
            <FormControl>
              <Switch
                name={rhf.name}
                checked={rhf.value === true}
                onCheckedChange={(on) => {
                  rhf.onChange(on === true);
                  rhf.onBlur();
                }}
                disabled={field.disabled}
                aria-required={required}
              />
            </FormControl>
            <FormLabel className="font-medium">
              {field.label ?? field.name}
              <RequiredMark required={required} />
            </FormLabel>
          </div>
          {field.helpText && <FormDescription>{field.helpText}</FormDescription>}
          <FormMessage style={errorText} />
        </FormItem>
      )}
    />
  );
}

/** Several of a list, as tick boxes. Holds string[] of option values, in the order of the options. */
export function CheckboxGroupField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  const state = useFieldOptions(field);
  const idPrefix = useId();
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => {
        const chosen = new Set(Array.isArray(rhf.value) ? (rhf.value as string[]) : []);
        return (
          <FieldShell field={field} required={required}>
            <FormControl>
              <div role="group" aria-label={field.label ?? field.name} className="grid gap-2">
                {state.options.map((o) => {
                  const id = `${idPrefix}-${o.value}`;
                  return (
                    <div key={o.value} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        className={VISIBLE_BORDER}
                        checked={chosen.has(o.value)}
                        disabled={field.disabled}
                        onCheckedChange={(checked) => {
                          const next = new Set(chosen);
                          if (checked === true) next.add(o.value);
                          else next.delete(o.value);
                          rhf.onChange(state.options.map((x) => x.value).filter((v) => next.has(v)));
                          rhf.onBlur();
                        }}
                      />
                      <Label htmlFor={id} style={{ fontWeight: 400 }}>
                        {o.label}
                      </Label>
                    </div>
                  );
                })}
              </div>
            </FormControl>
            {state.status !== 'ready' && <p className="text-sm text-muted-foreground">{optionsPlaceholder(state, '')}</p>}
          </FieldShell>
        );
      }}
    />
  );
}

/** A number with - and + buttons. Typing still works; the buttons stay within min and max. */
export function StepperField({ field, required }: FieldComponentProps) {
  const ui = useUi();
  const { control } = useFormContext();
  const step = typeof field.props?.step === 'number' && field.props.step > 0 ? field.props.step : 1;
  const { min, max } = field.validation ?? {};
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  // Avoids 0.1 + 0.2 = 0.30000000000000004 after a few presses.
  const tidy = (n: number) => Number(n.toPrecision(12));
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => {
        const value = typeof rhf.value === 'number' ? rhf.value : undefined;
        const move = (by: number) => {
          rhf.onChange(clamp(tidy((value ?? (by > 0 ? (min ?? 0) - step : (min ?? 0) + step)) + by)));
          rhf.onBlur();
        };
        const name = field.label ?? field.name;
        return (
          <FieldShell field={field} required={required}>
            <div className="flex items-center gap-2">
              <button type="button" className="fp-stepper__btn" aria-label={ui('decrease', { label: name })} disabled={field.disabled || (value !== undefined && min !== undefined && value <= min)} onClick={() => move(-step)}>
                <Minus size={16} />
              </button>
              <FormControl>
                <Input
                  type="number"
                  inputMode="decimal"
                  className="fp-stepper__input"
                  name={rhf.name}
                  value={value ?? ''}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    rhf.onChange(e.target.value === '' || Number.isNaN(n) ? undefined : n);
                  }}
                  onBlur={rhf.onBlur}
                  min={min}
                  max={max}
                  step={step}
                  disabled={field.disabled}
                  aria-required={required}
                />
              </FormControl>
              <button type="button" className="fp-stepper__btn" aria-label={ui('increase', { label: name })} disabled={field.disabled || (value !== undefined && max !== undefined && value >= max)} onClick={() => move(step)}>
                <Plus size={16} />
              </button>
            </div>
          </FieldShell>
        );
      }}
    />
  );
}

/** Terms to read, then a box to accept them. The terms are plain text: never injected markup. */
export function ConsentField({ field, required }: FieldComponentProps) {
  const ui = useUi();
  const { control } = useFormContext();
  const text = typeof field.props?.text === 'string' ? field.props.text : '';
  const textId = useId();
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FormItem>
          {text && (
            <div id={textId} className="fp-consent__text" tabIndex={0} role="region" aria-label={ui('terms')}>
              {text}
            </div>
          )}
          <div className="flex items-start gap-2">
            <FormControl>
              <Checkbox
                className={VISIBLE_BORDER}
                name={rhf.name}
                checked={rhf.value === true}
                onCheckedChange={(checked) => rhf.onChange(checked === true)}
                onBlur={rhf.onBlur}
                disabled={field.disabled}
                aria-required={required}
                aria-describedby={text ? textId : undefined}
              />
            </FormControl>
            <FormLabel className="font-medium">
              {field.label ?? 'I accept'}
              <RequiredMark required={required} />
            </FormLabel>
          </div>
          {field.helpText && <FormDescription>{field.helpText}</FormDescription>}
          <FormMessage style={errorText} />
        </FormItem>
      )}
    />
  );
}
