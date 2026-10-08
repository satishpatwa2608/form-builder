import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import { Input } from '@ui/input';
import { Switch } from '@ui/switch';
import type { Condition, FormDefinition, FormField, FormRule, RuleAction } from '../../types';
import { EXPRESSION_FUNCTIONS, isExpressionCondition, MAX_RULES } from '../../engine';
import { ConditionEditor } from '../components/ConditionEditor';
import { ChoiceSelect } from '../components/settings';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/tabs';
import { FormulaInput, MONO } from './FormulaInput';
import { EventsEditor } from './EventsEditor';
import { VISIBLE_BORDER } from '../../runtime/styles';
import { errorText } from '../../runtime/styles';
import {
  ACTION_LABEL,
  ACTION_TYPES,
  actionOf,
  conditionMode,
  newRule,
  readableFields,
  ruleProblems,
  targetsFor,
  withConditionMode,
  type ActionType,
  type ConditionMode,
} from './rule-edits';

const LOCK = { border: 0, padding: 0, margin: 0, minWidth: 0 } as const;
const fieldName = (f: FormField) => f.label || f.name;

interface ActionRowProps {
  action: RuleAction;
  fields: FormField[];
  names: ReadonlySet<string>;
  onChange: (action: RuleAction) => void;
  onRemove?: () => void;
}

function ActionRow({ action, fields, names, onChange, onRemove }: ActionRowProps) {
  const targets = targetsFor(action.type, fields);
  const target = fields.find((f) => f.name === action.target);
  const options = target?.dataSource?.type === 'STATIC' ? target.dataSource.options ?? [] : [];
  return (
    <div className="fb-settings fb-panel" style={{ gap: 8, padding: 10 }}>
      <div className="flex items-center gap-2">
        <div style={{ flex: 1, minWidth: 0 }}>
          <ChoiceSelect<ActionType>
            ariaLabel="Action"
            value={action.type}
            options={ACTION_TYPES.map((t) => ({ label: ACTION_LABEL[t], value: t }))}
            onChange={(type) => onChange(actionOf(type, fields, action.target))}
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ChoiceSelect
            ariaLabel="Field"
            placeholder={targets.length ? 'Choose a field' : 'No field fits this action'}
            value={targets.some((f) => f.name === action.target) ? action.target : undefined}
            options={targets.map((f) => ({ label: fieldName(f), value: f.name }))}
            onChange={(name) => onChange({ ...actionOf(action.type, fields, name), ...('value' in action ? { value: action.value } : {}), ...('message' in action ? { message: action.message } : {}) } as RuleAction)}
          />
        </div>
        {onRemove && (
          <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label="Remove action" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {action.type === 'SET_VALUE' && (
        <FormulaInput label="Formula" value={action.value} names={names} placeholder="quantity * unitPrice" onChange={(value) => onChange({ ...action, value })} />
      )}
      {action.type === 'ERROR' && (
        <Input aria-label="Error message" className={VISIBLE_BORDER} value={action.message} maxLength={300} placeholder="What the person should fix" onChange={(e) => onChange({ ...action, message: e.target.value })} />
      )}
      {action.type === 'SET_OPTIONS' && (
        <div className="fb-settings" style={{ gap: 6 }}>
          {options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <Checkbox
                className={VISIBLE_BORDER}
                checked={action.values.includes(o.value)}
                onCheckedChange={(checked) => {
                  const chosen = new Set(action.values);
                  if (checked) chosen.add(o.value);
                  else chosen.delete(o.value);
                  onChange({ ...action, values: options.map((x) => x.value).filter((v) => chosen.has(v)) });
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

interface ActionListProps {
  title: string;
  actions: RuleAction[];
  /** The "then" list always keeps one action; "otherwise" may be emptied. */
  keepOne?: boolean;
  fields: FormField[];
  names: ReadonlySet<string>;
  onChange: (actions: RuleAction[]) => void;
}

function ActionList({ title, actions, keepOne, fields, names, onChange }: ActionListProps) {
  return (
    <div className="fb-settings" style={{ gap: 8 }} role="group" aria-label={title}>
      <div className="fb-panel__title">{title}</div>
      {actions.map((action, i) => (
        <ActionRow
          key={i}
          action={action}
          fields={fields}
          names={names}
          onChange={(next) => onChange(actions.map((a, j) => (j === i ? next : a)))}
          onRemove={keepOne && actions.length === 1 ? undefined : () => onChange(actions.filter((_, j) => j !== i))}
        />
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...actions, actionOf('SHOW', fields)])}>
          <Plus /> Add action
        </Button>
      </div>
    </div>
  );
}

const MODES: { label: string; value: ConditionMode }[] = [
  { label: 'Always', value: 'always' },
  { label: 'When conditions are met', value: 'conditions' },
  { label: 'When a formula is true', value: 'formula' },
];

interface RuleCardProps {
  rule: FormRule;
  index: number;
  fields: FormField[];
  names: ReadonlySet<string>;
  problems: string[];
  onChange: (rule: FormRule) => void;
  onRemove: () => void;
}

function RuleCard({ rule, index, fields, names, problems, onChange, onRemove }: RuleCardProps) {
  const mode = conditionMode(rule);
  const title = rule.name?.trim() || `Rule ${index + 1}`;
  return (
    <section className="fb-panel fb-settings" style={{ gap: 14 }} aria-label={title}>
      <div className="flex items-center gap-2">
        <Input aria-label="Rule name" className={VISIBLE_BORDER} style={{ flex: 1 }} value={rule.name ?? ''} maxLength={120} placeholder={`Rule ${index + 1}`} onChange={(e) => onChange({ ...rule, name: e.target.value })} />
        <label className="flex items-center gap-2 text-sm">
          <Switch aria-label="Rule is on" checked={!rule.disabled} onCheckedChange={(on) => onChange({ ...rule, disabled: on ? undefined : true })} />
          On
        </label>
        <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label={`Delete ${title}`} onClick={onRemove}>
          <Trash2 size={16} />
        </button>
      </div>

      <div className="fb-settings" style={{ gap: 8 }}>
        <ChoiceSelect<ConditionMode> ariaLabel="When" value={mode} options={MODES} onChange={(m) => onChange(withConditionMode(rule, m, fields))} />
        {rule.when && isExpressionCondition(rule.when) && (
          <FormulaInput label="Condition formula" value={rule.when.expr} names={names} placeholder="total > 5000 && !approved" onChange={(expr) => onChange({ ...rule, when: { expr } })} />
        )}
        {rule.when && !isExpressionCondition(rule.when) && (
          <ConditionEditor condition={rule.when as Condition} candidates={readableFields(fields)} onChange={(when) => onChange({ ...rule, when })} />
        )}
      </div>

      <ActionList title="Then" keepOne actions={rule.then} fields={fields} names={names} onChange={(then) => onChange({ ...rule, then })} />
      {rule.when && (
        <ActionList
          title="Otherwise"
          actions={rule.else ?? []}
          fields={fields}
          names={names}
          onChange={(actions) => {
            const { else: _else, ...rest } = rule;
            onChange(actions.length ? { ...rest, else: actions } : rest);
          }}
        />
      )}

      {problems.length > 0 && (
        <ul role="alert" className="text-sm" style={{ ...errorText, margin: 0, paddingLeft: 18 }}>
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FormulaHelp({ fields }: { fields: FormField[] }) {
  const groups = [...new Set(EXPRESSION_FUNCTIONS.map((f) => f.group))];
  return (
    <details className="fb-panel">
      <summary className="text-sm" style={{ cursor: 'pointer' }}>
        Writing formulas
      </summary>
      <div className="fb-settings" style={{ gap: 10, marginTop: 10 }}>
        <p className="fb-muted">
          Use field names, numbers, text in quotes and + - * / % &amp; (join text) == != &lt; &lt;= &gt; &gt;= &amp;&amp; || ! and condition ? a : b. A blank field counts as 0 in sums.
        </p>
        <p className="fb-muted">
          Fields:{' '}
          {readableFields(fields).map((f) => (
            <code key={f.id} className="fb-code" style={{ marginRight: 6 }}>
              {f.name}
            </code>
          ))}
        </p>
        {groups.map((group) => (
          <div key={group}>
            <div className="fb-panel__title">{group}</div>
            <ul className="fb-muted" style={{ margin: 0, paddingLeft: 18 }}>
              {EXPRESSION_FUNCTIONS.filter((f) => f.group === group).map((f) => (
                <li key={f.name} style={MONO}>
                  {f.help}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

interface RulesDialogProps {
  form: FormDefinition;
  readOnly: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (changes: Partial<FormDefinition>) => void;
}

/**
 * The form's rules: calculations, and what is shown, required, switched off,
 * faulted or offered depending on the answers. Edits go into the draft like
 * any other setting; the server applies the same rules on every submission.
 */
export function RulesDialog({ form, readOnly, open, onOpenChange, onChange }: RulesDialogProps) {
  const rules = form.rules ?? [];
  const names = new Set(form.fields.map((f) => f.name));
  const problems = open ? ruleProblems(form) : new Map<number, string[]>();
  const setRules = (next: FormRule[]) => onChange({ rules: next });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="large" style={{ width: 'min(900px, calc(100vw - 2rem))', maxWidth: 'none', maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>Rules</DialogTitle>
          <DialogDescription>
            Calculate values and change what {form.name} shows, requires and accepts as it is filled in. The same rules are checked again when it is submitted.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules">Rules{rules.length ? ` (${rules.length})` : ''}</TabsTrigger>
            <TabsTrigger value="events">Events{form.events?.length ? ` (${form.events.length})` : ''}</TabsTrigger>
          </TabsList>
          <TabsContent value="rules">
        <fieldset disabled={readOnly} style={LOCK}>
          <div className="fb-settings" style={{ gap: 16 }}>
            {!rules.length && <p className="fb-muted">No rules yet. Add one to calculate a total, show a section only when it applies, or check one answer against another.</p>}
            {(problems.get(-1) ?? []).map((p, i) => (
              <p key={i} role="alert" className="text-sm" style={errorText}>
                {p}
              </p>
            ))}
            {rules.map((rule, i) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                index={i}
                fields={form.fields}
                names={names}
                problems={problems.get(i) ?? []}
                onChange={(next) => setRules(rules.map((r, j) => (j === i ? next : r)))}
                onRemove={() => setRules(rules.filter((_, j) => j !== i))}
              />
            ))}
            {!readOnly && (
              <div>
                <Button type="button" variant="outline" disabled={rules.length >= MAX_RULES || !form.fields.length} onClick={() => setRules([...rules, newRule(rules, form.fields)])}>
                  <Plus /> Add rule
                </Button>
              </div>
            )}
            <FormulaHelp fields={form.fields} />
          </div>
        </fieldset>
          </TabsContent>
          <TabsContent value="events">
            <fieldset disabled={readOnly} style={LOCK}>
              <EventsEditor form={form} readOnly={readOnly} onChange={(events) => onChange({ events })} />
            </fieldset>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
