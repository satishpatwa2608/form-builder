import { useFormContext } from 'react-hook-form';
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@ui/form';
import { Checkbox } from '@ui/checkbox';
import { RequiredMark } from './FieldShell';
import { VISIBLE_BORDER, errorText } from '../styles';
import type { FieldComponentProps } from './types';

/** A single boolean. Label sits beside the box rather than above it. */
export function CheckboxField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => (
        <FormItem>
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
