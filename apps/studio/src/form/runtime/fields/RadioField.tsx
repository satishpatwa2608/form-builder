import { useId } from 'react';
import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { RadioGroup, RadioGroupItem } from '@ui/radio-group';
import { Label } from '@ui/label';
import { optionsPlaceholder, useFieldOptions } from '../hooks/useFieldOptions';
import { FieldShell } from './FieldShell';
import { VISIBLE_BORDER } from '../styles';
import type { FieldComponentProps } from './types';

export function RadioField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  const state = useFieldOptions(field);
  const { options } = state;
  const idPrefix = useId();

  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FieldShell field={field} required={required}>
          <FormControl>
            <RadioGroup
              className="grid gap-2"
              name={rhf.name}
              value={(rhf.value as string | undefined) ?? ''}
              onValueChange={(v) => {
                rhf.onChange(v);
                rhf.onBlur();
              }}
              disabled={field.disabled}
              aria-label={field.label ?? field.name}
              aria-required={required}
            >
              {options.map((o) => {
                const id = `${idPrefix}-${o.value}`;
                return (
                  <div key={o.value} className="flex items-center gap-2">
                    <RadioGroupItem id={id} value={o.value} className={VISIBLE_BORDER} />
                    <Label htmlFor={id} style={{ fontWeight: 400 }}>
                      {o.label}
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          </FormControl>
          {state.status !== 'ready' && <p className="text-sm text-muted-foreground">{optionsPlaceholder(state, '')}</p>}
        </FieldShell>
      )}
    />
  );
}
