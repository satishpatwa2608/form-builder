import { Button } from '@ui/button';
import { useFormRuntime } from '../FormRuntimeContext';
import type { FieldComponentProps } from './types';

/** Carries its value in form state (from defaultValues); renders nothing. */
export function HiddenField(_props: FieldComponentProps) {
  return null;
}

/**
 * An extra, non-submit button. Submit and cancel come from
 * `definition.actions`, not from fields. `props.href` navigates.
 */
export function ButtonField({ field }: FieldComponentProps) {
  const { navigate } = useFormRuntime();
  const href = typeof field.props?.href === 'string' ? field.props.href : undefined;
  return (
    <div>
      <Button type="button" variant="outline" disabled={field.disabled || !href} onClick={() => href && navigate(href)}>
        {field.label ?? field.name}
      </Button>
    </div>
  );
}

/**
 * HTML type, shown as a "Content block": headings/instructions between fields.
 * Rendered as plain text with line breaks - never as injected markup, since
 * definitions are authored in a browser and served to the public.
 */
export function ContentField({ field }: FieldComponentProps) {
  const content = typeof field.props?.content === 'string' ? field.props.content : '';
  return (
    <div className="space-y-1">
      {field.label && <p className="text-lg font-semibold text-gray-900">{field.label}</p>}
      {content && (
        <p className="text-sm text-muted-foreground" style={{ whiteSpace: 'pre-line' }}>
          {content}
        </p>
      )}
    </div>
  );
}

/** Placeholder for field types that have no runtime component yet. */
export function UnsupportedField({ field }: FieldComponentProps) {
  return (
    <div className="rounded-md border border-gray-300 p-3 text-sm text-muted-foreground">
      {field.label ?? field.name}: <strong>{field.type}</strong> fields are not available yet.
    </div>
  );
}
