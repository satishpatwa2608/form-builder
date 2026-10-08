import { Input } from '@ui/input';
import { checkExpression } from '../../engine';
import { errorText, VISIBLE_BORDER } from '../../runtime/styles';

export const MONO = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } as const;

/** A formula box that says what is wrong with it as you type. */
export function FormulaInput({ label, value, names, placeholder, onChange }: { label: string; value: string; names: ReadonlySet<string>; placeholder: string; onChange: (value: string) => void }) {
  const problem = value.trim() ? checkExpression(value, names) : null;
  return (
    <div className="fb-settings" style={{ gap: 4 }}>
      <Input aria-label={label} className={VISIBLE_BORDER} style={MONO} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      {problem && (
        <span role="alert" className="text-sm" style={errorText}>
          {problem}
        </span>
      )}
    </div>
  );
}
