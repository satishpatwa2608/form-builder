import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Input } from '@ui/input';
import { Button } from '@ui/button';
import type { SelectOption } from '../../types';
import { suggestCode } from '../blank-form';
import { moveItem } from '../definition-edits';

interface OptionsEditorProps {
  options: SelectOption[];
  onChange: (options: SelectOption[]) => void;
}

/** A value still tracks its label until someone edits the value by hand. */
const isAutoValue = (option: SelectOption) =>
  option.value === suggestCode(option.label) || /^OPTION_\d+$/.test(option.value);

export function OptionsEditor({ options, onChange }: OptionsEditorProps) {
  const update = (index: number, changes: Partial<SelectOption>) =>
    onChange(options.map((o, i) => (i === index ? { ...o, ...changes } : o)));

  const add = () => {
    const taken = new Set(options.map((o) => o.value));
    let n = options.length + 1;
    while (taken.has(`OPTION_${n}`)) n++;
    onChange([...options, { label: `Option ${n}`, value: `OPTION_${n}` }]);
  };

  return (
    <div className="fb-settings" style={{ gap: 8 }}>
      <div className="fb-options-row fb-setting__hint">
        <span>Label (shown)</span>
        <span>Value (submitted)</span>
        <span style={{ width: 84 }} />
      </div>
      {options.map((option, index) => (
        <div key={index} className="fb-options-row">
          <Input
            aria-label={`Option ${index + 1} label`}
            value={option.label}
            onChange={(e) => {
              const label = e.target.value;
              update(index, isAutoValue(option) ? { label, value: suggestCode(label) || option.value } : { label });
            }}
          />
          <Input
            aria-label={`Option ${index + 1} value`}
            className="fb-code"
            value={option.value}
            onChange={(e) => update(index, { value: e.target.value })}
          />
          <div className="flex items-center">
            <button type="button" className="fb-icon-btn" aria-label="Move option up" disabled={index === 0} onClick={() => onChange(moveItem(options, index, index - 1))}>
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="fb-icon-btn"
              aria-label="Move option down"
              disabled={index === options.length - 1}
              onClick={() => onChange(moveItem(options, index, index + 1))}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              className="fb-icon-btn fb-icon-btn--danger"
              aria-label="Remove option"
              disabled={options.length <= 1}
              onClick={() => onChange(options.filter((_, i) => i !== index))}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus /> Add option
        </Button>
      </div>
    </div>
  );
}
