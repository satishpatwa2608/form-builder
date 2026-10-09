import { useUi } from '../FormRuntimeContext';
import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { MultiSelect } from '@ui/multiselect';
import { optionsPlaceholder, useFieldOptions } from '../hooks/useFieldOptions';
import { FieldShell } from './FieldShell';
import type { FieldComponentProps } from './types';

/** Holds string[] of option values. */
export function MultiSelectField({ field, required }: FieldComponentProps) {
  const ui = useUi();
  const { control } = useFormContext();
  const state = useFieldOptions(field);

  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FieldShell field={field} required={required}>
          <FormControl>
            <MultiSelect
              options={state.options.map((o) => ({ value: o.value, label: o.label }))}
              value={Array.isArray(rhf.value) ? (rhf.value as string[]) : []}
              onChange={(next) => {
                rhf.onChange(next);
                rhf.onBlur();
              }}
              placeholder={optionsPlaceholder(state, field.placeholder ?? ui('searchSelect'))}
              disabled={field.disabled || state.status !== 'ready'}
              maxVisibleTags={3}
            />
          </FormControl>
        </FieldShell>
      )}
    />
  );
}
