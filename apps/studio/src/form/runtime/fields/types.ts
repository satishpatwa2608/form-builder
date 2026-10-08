import type { ComponentType } from 'react';
import type { FormField } from '../../types';

/** Every field component takes exactly this - nothing form-specific. */
export interface FieldComponentProps {
  field: FormField;
  /** Resolved for the current values (required or requiredWhen). */
  required: boolean;
}

export type FieldComponent = ComponentType<FieldComponentProps>;
