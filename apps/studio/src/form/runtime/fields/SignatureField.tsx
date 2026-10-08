import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import { isSignature } from '../../engine';
import { useFormRuntime } from '../FormRuntimeContext';
import { FieldShell } from './FieldShell';
import { VISIBLE_BORDER } from '../styles';
import type { FieldComponentProps } from './types';

const WIDTH = 600;
const HEIGHT = 180;

/**
 * A signature drawn with a mouse, finger or pen, or typed for people who
 * cannot draw. Either way the value is a small PNG of what is on the pad.
 */
export function SignatureField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  return <FormField control={control} name={field.name} render={({ field: rhf }) => <Pad field={field} required={required} value={rhf.value} onChange={rhf.onChange} onBlur={rhf.onBlur} />} />;
}

interface PadProps extends FieldComponentProps {
  value: unknown;
  onChange: (value: string) => void;
  onBlur: () => void;
}

function Pad({ field, required, value, onChange, onBlur }: PadProps) {
  const { resetKey } = useFormRuntime();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [typed, setTyped] = useState('');
  const name = field.label ?? field.name;

  const context = () => {
    const ctx = canvas.current?.getContext('2d') ?? null;
    if (ctx) {
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111827';
      ctx.fillStyle = '#111827';
    }
    return ctx;
  };
  const wipe = () => context()?.clearRect(0, 0, WIDTH, HEIGHT);
  const save = () => {
    const png = canvas.current?.toDataURL('image/png');
    if (isSignature(png)) onChange(png);
    onBlur();
  };
  const clear = () => {
    wipe();
    setTyped('');
    onChange('');
    onBlur();
  };

  // A value that is already there (a resumed draft) is shown; a form reset empties the pad.
  useEffect(() => {
    wipe();
    setTyped('');
    if (!isSignature(value)) return;
    const img = new Image();
    img.onload = () => context()?.drawImage(img, 0, 0, WIDTH, HEIGHT);
    img.src = value;
    // Only on mount and reset: redrawing on every change would fight the pen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  /** Pointer position in canvas pixels, whatever size the pad is shown at. */
  const at = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - box.left) / (box.width || WIDTH)) * WIDTH, y: ((e.clientY - box.top) / (box.height || HEIGHT)) * HEIGHT };
  };
  const start = (e: PointerEvent<HTMLCanvasElement>) => {
    if (field.disabled) return;
    drawing.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const { x, y } = at(e);
    const ctx = context();
    ctx?.beginPath();
    ctx?.moveTo(x, y);
    // A tap leaves a dot.
    ctx?.lineTo(x + 0.1, y + 0.1);
    ctx?.stroke();
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const { x, y } = at(e);
    const ctx = context();
    ctx?.lineTo(x, y);
    ctx?.stroke();
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    save();
  };

  const type = (text: string) => {
    setTyped(text);
    wipe();
    if (!text.trim()) {
      onChange('');
      return;
    }
    const ctx = context();
    if (ctx) {
      ctx.font = 'italic 48px "Brush Script MT", "Segoe Script", cursive';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 24, HEIGHT / 2, WIDTH - 48);
    }
    save();
  };

  return (
    <FieldShell field={field} required={required}>
      <div className="fp-signature">
        <FormControl>
          <canvas
            ref={canvas}
            width={WIDTH}
            height={HEIGHT}
            className="fp-signature__pad"
            role="img"
            aria-label={`${name}: ${isSignature(value) ? 'signed' : 'not signed yet'}`}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={end}
            onPointerCancel={end}
          />
        </FormControl>
        <div className="flex items-center gap-2">
          <Input
            aria-label={`Or type your name to sign ${name}`}
            className={VISIBLE_BORDER}
            value={typed}
            maxLength={80}
            placeholder="Or type your name"
            disabled={field.disabled}
            aria-required={required}
            onChange={(e) => type(e.target.value)}
          />
          <Button type="button" variant="outline" disabled={field.disabled || !isSignature(value)} onClick={clear}>
            Clear
          </Button>
        </div>
      </div>
    </FieldShell>
  );
}
