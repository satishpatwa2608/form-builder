import { useFormContext } from 'react-hook-form';
import { FormControl, FormField } from '@ui/form';
import { FieldShell } from './FieldShell';
import type { FieldComponentProps } from './types';

/**
 * A number chosen by dragging (or with the arrow keys). Nothing is chosen
 * until the person moves it: the value shown beside it says so, and a
 * required slider left alone is still unanswered.
 */
export function SliderField({ field, required }: FieldComponentProps) {
  const { control } = useFormContext();
  const min = field.validation?.min ?? 0;
  const max = field.validation?.max ?? 100;
  const step = typeof field.props?.step === 'number' && field.props.step > 0 ? field.props.step : 1;
  return (
    <FormField
      control={control}
      name={field.name}
      render={({ field: rhf }) => {
        const value = typeof rhf.value === 'number' ? rhf.value : undefined;
        return (
          <FieldShell field={field} required={required}>
            <div className="fp-slider">
              <FormControl>
                <input
                  type="range"
                  className="fp-slider__input"
                  name={rhf.name}
                  min={min}
                  max={max}
                  step={step}
                  // Before a choice the thumb rests in the middle; the text beside it says nothing is chosen yet.
                  value={value ?? (min + max) / 2}
                  onChange={(e) => rhf.onChange(Number(e.target.value))}
                  // Tapping the thumb where it rests is a choice too.
                  onPointerUp={(e) => value === undefined && rhf.onChange(Number(e.currentTarget.value))}
                  onBlur={rhf.onBlur}
                  disabled={field.disabled}
                  aria-required={required}
                  aria-valuetext={value === undefined ? '-' : String(value)}
                />
              </FormControl>
              <output className="fp-slider__value" aria-hidden="true">
                {value ?? '–'}
              </output>
              <span className="fp-slider__ends" aria-hidden="true">
                <span>{min}</span>
                <span>{max}</span>
              </span>
            </div>
          </FieldShell>
        );
      }}
    />
  );
}
