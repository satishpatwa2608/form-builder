import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { Input } from '@ui/input';
import { FieldShell } from './FieldShell';
import type { FieldComponentProps } from './types';

/** Holds a number, or undefined while blank - never the raw input string. */
export function NumberField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FieldShell field={field} required={required}>
          <FormControl>
            <Input
              type="number"
              inputMode="decimal"
              name={rhf.name}
              value={(rhf.value as number | undefined) ?? ''}
              onChange={(e) => {
                const raw = e.target.value;
                const n = Number(raw);
                rhf.onChange(raw === '' || Number.isNaN(n) ? undefined : n);
              }}
              onBlur={rhf.onBlur}
              min={field.validation?.min}
              max={field.validation?.max}
              placeholder={field.placeholder}
              disabled={field.disabled}
              aria-required={required}
            />
          </FormControl>
        </FieldShell>
      )}
    />
  );
}
