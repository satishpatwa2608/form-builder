import { useEffect, useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { CUSTOM_FIELD_KEY, MAX_CUSTOM_LENGTH } from '../../engine';
import { API_URL } from '../../../lib/api';
import { useFormRuntime } from '../FormRuntimeContext';
import { FieldShell } from './FieldShell';
import type { FieldComponentProps } from './types';

/** Where the page of a custom field is served from (the copy the server took from the organisation's extension). */
export const customFieldUrl = (orgId: string, key: string) => `${API_URL}/public/extensions/${encodeURIComponent(orgId)}/fields/${encodeURIComponent(key)}`;

/**
 * A field drawn by the organisation's own code. The code runs in a frame
 * that is locked twice over: by the `sandbox` here and by the policy the
 * server sends with the page. It has an origin of its own, so it cannot read
 * this form, anyone's session or any storage, and it can load nothing from
 * the network. All it can do is tell us its answer, as text.
 */
export function CustomField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  return <FormField control={control} name={field.name} render={({ field: rhf }) => <Frame field={field} required={required} value={rhf.value} onChange={rhf.onChange} onBlur={rhf.onBlur} />} />;
}

interface FrameProps extends FieldComponentProps {
  value: unknown;
  onChange: (value: string) => void;
  onBlur: () => void;
}

function Frame({ field, required, value, onChange, onBlur }: FrameProps) {
  const { definition, readOnly, resetKey } = useFormRuntime();
  const frame = useRef<HTMLIFrameElement>(null);
  const key = typeof field.props?.custom === 'string' ? field.props.custom : '';
  const [height, setHeight] = useState(typeof field.props?.height === 'number' ? field.props.height : 120);
  const locked = !!field.disabled || readOnly.has(field.name);
  // What the frame is told when it asks: always the newest, without re-subscribing on every keystroke.
  const now = useRef({ value, locked, required, onChange, onBlur });
  now.current = { value, locked, required, onChange, onBlur };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      // Only our own frame is listened to, and only messages in the shape the bridge sends.
      const data = event.data as { fb?: unknown; type?: unknown; value?: unknown; height?: unknown } | null;
      if (!target || event.source !== target || !data || data.fb !== 1) return;
      if (data.type === 'ready') {
        const { value: v, locked: l, required: r } = now.current;
        target.postMessage({ fb: 1, type: 'init', value: typeof v === 'string' ? v : '', readOnly: l, required: r, label: field.label ?? field.name }, '*');
      } else if (data.type === 'change') {
        // Text of a sane size and nothing else; and nothing at all while a rule has the field switched off.
        if (typeof data.value !== 'string' || data.value.length > MAX_CUSTOM_LENGTH || now.current.locked) return;
        now.current.onChange(data.value);
        now.current.onBlur();
      } else if (data.type === 'height' && typeof data.height === 'number' && Number.isFinite(data.height)) {
        setHeight(Math.min(800, Math.max(40, Math.round(data.height))));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [field.label, field.name]);

  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ fb: 1, type: 'readOnly', readOnly: locked }, '*');
  }, [locked]);

  return (
    <FieldShell field={field} required={required}>
      {CUSTOM_FIELD_KEY.test(key) ? (
        <FormControl>
          <iframe
            // A reset form gets a fresh frame, which asks for the (now empty) value again.
            key={resetKey}
            ref={frame}
            title={field.label ?? field.name}
            src={customFieldUrl(definition.orgId, key)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            style={{ display: 'block', width: '100%', height, border: 0 }}
          />
        </FormControl>
      ) : (
        <p className="fb-muted">Choose which of your extension's fields this is, in the field's settings.</p>
      )}
    </FieldShell>
  );
}
