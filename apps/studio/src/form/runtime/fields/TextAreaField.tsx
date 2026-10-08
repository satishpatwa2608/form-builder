import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { Textarea } from '@ui/textarea';
import { FieldShell } from './FieldShell';
import { VISIBLE_BORDER } from '../styles';
import type { FieldComponentProps } from './types';

export function TextAreaField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  const rows = typeof field.props?.rows === 'number' ? field.props.rows : 4;
  const maxLength = field.validation?.maxLength;

  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => {
        const value = (rhf.value as string | undefined) ?? '';
        return (
          <FieldShell field={field} required={required}>
            <FormControl>
              <Textarea
                className={VISIBLE_BORDER}
                rows={rows}
                name={rhf.name}
                value={value}
                onChange={rhf.onChange}
                onBlur={rhf.onBlur}
                placeholder={field.placeholder}
                disabled={field.disabled}
                aria-required={required}
              />
            </FormControl>
            {maxLength !== undefined && (
              <p className="text-xs text-muted-foreground" style={{ textAlign: 'right' }}>
                {value.length} / {maxLength}
              </p>
            )}
          </FieldShell>
        );
      }}
    />
  );
}
