import { useUi } from '../FormRuntimeContext';
import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui/select';
import { SearchWithSelect } from '@ui/search-with-select';
import type { SelectOption } from '../../types';
import { optionsPlaceholder, useFieldOptions } from '../hooks/useFieldOptions';
import { FieldShell } from './FieldShell';
import { VISIBLE_BORDER, errorText } from '../styles';
import type { FieldComponentProps } from './types';

/** Above this many options the dropdown becomes searchable (repo rule: SearchWithSelect for >10). */
export const SEARCHABLE_THRESHOLD = 10;

export function SelectField({ field, required }: FieldComponentProps) {
  const ui = useUi();
  const { control } = useFormContext();
  const state = useFieldOptions(field);
  const { options, status } = state;
  const blocked = status !== 'ready' || !options.length;
  const placeholder = optionsPlaceholder(state, field.placeholder ?? ui('select'));

  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => {
        const value = (rhf.value as string | undefined) ?? '';
        const choose = (next: string) => {
          rhf.onChange(next);
          rhf.onBlur();
        };

        return (
          <FieldShell field={field} required={required}>
            {options.length > SEARCHABLE_THRESHOLD ? (
              <FormControl>
                <SearchWithSelect<SelectOption>
                  items={options}
                  value={value}
                  onChange={(key: string) => choose(key)}
                  getKey={(o: SelectOption) => o.value}
                  getLabel={(o: SelectOption) => o.label}
                  placeholder={placeholder}
                  disabled={field.disabled}
                />
              </FormControl>
            ) : (
              <Select name={rhf.name} value={value} onValueChange={choose} disabled={field.disabled || blocked}>
                <FormControl>
                  <SelectTrigger className={VISIBLE_BORDER} onBlur={rhf.onBlur} aria-required={required}>
                    <SelectValue placeholder={placeholder} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {status === 'error' && (
              <p className="text-xs" style={errorText}>
                Couldn't load options: {state.error}
              </p>
            )}
          </FieldShell>
        );
      }}
    />
  );
}
