import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { Input } from '@ui/input';
import type { FieldType } from '../../types';
import { FieldShell } from './FieldShell';
import type { FieldComponentProps } from './types';

const INPUT_TYPE: Partial<Record<FieldType, string>> = {
  TEXT: 'text',
  EMAIL: 'email',
  PHONE: 'tel',
  DATE: 'date',
  DATETIME: 'datetime-local',
};

const AUTOCOMPLETE: Partial<Record<FieldType, string>> = {
  EMAIL: 'email',
  PHONE: 'tel',
};

/** TEXT, EMAIL, PHONE, DATE and DATETIME: a single-line input that holds a string. */
export function TextField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FieldShell field={field} required={required}>
          <FormControl>
            <Input
              type={INPUT_TYPE[field.type] ?? 'text'}
              name={rhf.name}
              value={(rhf.value as string | undefined) ?? ''}
              onChange={rhf.onChange}
              onBlur={rhf.onBlur}
              placeholder={field.placeholder}
              disabled={field.disabled}
              autoComplete={AUTOCOMPLETE[field.type]}
              aria-required={required}
            />
          </FormControl>
        </FieldShell>
      )}
    />
  );
}
