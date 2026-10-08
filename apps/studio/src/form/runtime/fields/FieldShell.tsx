import type { ReactNode } from 'react';
import { FormDescription, FormItem, FormLabel, FormMessage } from '@ui/form';
import type { FormField } from '../../types';
import { errorText } from '../styles';

export function RequiredMark({ required }: { required: boolean }) {
  if (!required) return null;
  return (
    <span aria-hidden="true" style={errorText}>
      *
    </span>
  );
}

interface FieldShellProps {
  field: FormField;
  required: boolean;
  /** The control, already wrapped in <FormControl>. */
  children: ReactNode;
}

/** Label, help text and error message around a control. */
export function FieldShell({ field, required, children }: FieldShellProps) {
  return (
    <FormItem>
      {field.label && (
        <FormLabel>
          {field.label}
          <RequiredMark required={required} />
        </FormLabel>
      )}
      {children}
      {field.helpText && <FormDescription>{field.helpText}</FormDescription>}
      <FormMessage style={errorText} />
    </FormItem>
  );
}
