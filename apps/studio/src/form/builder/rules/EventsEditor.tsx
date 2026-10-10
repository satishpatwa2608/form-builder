import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import { Switch } from '@ui/switch';
import type { Condition, FormDefinition, FormEvent, FormEventAction, FormField } from '../../types';
import { isExpressionCondition, MAX_EVENTS } from '../../engine';
import { useDataSources } from '../../adapters/data-source/data-source-adapter';
import { ConditionEditor, defaultCondition } from '../components/ConditionEditor';
import { ChoiceSelect } from '../components/settings';
import { errorText, VISIBLE_BORDER } from '../../runtime/styles';
import { FormulaInput } from './FormulaInput';
import {
  buttonsOf,
  watchableFields,
  EVENT_ACTION_LABEL,
  EVENT_ACTIONS_FOR,
  eventActionOf,
  eventProblems,
  newEvent,
  readableFields,
  stepsOf,
  targetsFor,
  TRIGGER_LABEL,
  withTrigger,
  type ConditionMode,
  type EventActionType,
  type TriggerType,
} from './rule-edits';

const fieldName = (f: FormField) => f.label || f.name;
const TRIGGERS = Object.keys(TRIGGER_LABEL) as TriggerType[];

/** Rows of "left = right" text pairs kept as an object; an empty left side is a row being typed. */
function Pairs({ label, left, right, value, onChange }: { label: string; left: string; right: string; value: Record<string, string>; onChange: (value: Record<string, string>) => void }) {
  const rows = Object.entries(value);
  const set = (index: number, key: string, val: string) => onChange(Object.fromEntries(rows.map((row, i) => (i === index ? [key, val] : row))));
  return (
    <div className="fb-settings" style={{ gap: 6 }} role="group" aria-label={label}>
      <span className="fb-setting__label">{label}</span>
      {rows.map(([key, val], i) => (
        <div key={i} className="flex items-center gap-2">
          <Input aria-label={left} className={VISIBLE_BORDER} value={key} placeholder={left} onChange={(e) => set(i, e.target.value, val)} />
          <Input aria-label={right} className={VISIBLE_BORDER} value={val} placeholder={right} onChange={(e) => set(i, key, e.target.value)} />
          <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label={`Remove ${label.toLowerCase()} row`} onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" disabled={'' in value} onClick={() => onChange({ ...value, '': '' })}>
          <Plus /> Add
        </Button>
      </div>
    </div>
  );
}

/** Where to look, what to send, and which fields the answer goes into. */
function FetchEditor({ action, fields, onChange }: { action: Extract<FormEventAction, { type: 'FETCH' }>; fields: FormField[]; onChange: (action: FormEventAction) => void }) {
  const { data: sources = [] } = useDataSources();
  const targets = targetsFor('SET_VALUE', fields);
  const filled = Object.entries(action.set);
  const free = targets.filter((f) => !(f.name in action.set));
  return (
    <div className="fb-settings" style={{ gap: 10 }}>
      <ChoiceSelect
        ariaLabel="Data source"
        placeholder={sources.length ? 'Pick a data source…' : 'No data sources yet'}
        value={sources.some((s) => s.key === action.source.url) ? action.source.url : undefined}
        options={sources.map((s) => ({ label: s.name, value: s.key }))}
        onChange={(url) => onChange({ ...action, source: { ...action.source, url } })}
      />
      <Pairs
        label="Send"
        left="Parameter"
        right="{{fieldName}} or a fixed value"
        value={action.source.params ?? {}}
        onChange={(params) => onChange({ ...action, source: { ...action.source, params: Object.keys(params).length ? params : undefined } })}
      />
      <div className="fb-settings" style={{ gap: 6 }} role="group" aria-label="Fill in">
        <span className="fb-setting__label">Fill in</span>
        {filled.map(([name, path]) => (
          <div key={name} className="flex items-center gap-2">
            <span className="text-sm" style={{ flex: 1, minWidth: 0 }}>
              {fieldName(fields.find((f) => f.name === name) ?? ({ name } as FormField))}
            </span>
            <Input
              aria-label={`Property for ${name}`}
              className={VISIBLE_BORDER}
              style={{ flex: 1 }}
              value={path}
              placeholder="property of the row, e.g. address.city"
              onChange={(e) => onChange({ ...action, set: { ...action.set, [name]: e.target.value } })}
            />
            <button
              type="button"
              className="fb-icon-btn fb-icon-btn--danger"
              aria-label={`Stop filling ${name}`}
              onClick={() => onChange({ ...action, set: Object.fromEntries(filled.filter(([n]) => n !== name)) })}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {free.length > 0 && (
          <ChoiceSelect
            ariaLabel="Add a field to fill in"
            placeholder="Add a field to fill in…"
            value={undefined}
            options={free.map((f) => ({ label: fieldName(f), value: f.name }))}
            onChange={(name) => onChange({ ...action, set: { ...action.set, [name]: '' } })}
          />
        )}
      </div>
    </div>
  );
}

interface ActionProps {
  action: FormEventAction;
  allowed: EventActionType[];
  fields: FormField[];
  names: ReadonlySet<string>;
  onChange: (action: FormEventAction) => void;
  onRemove?: () => void;
}

function EventActionRow({ action, allowed, fields, names, onChange, onRemove }: ActionProps) {
  const targets = targetsFor('SET_VALUE', fields);
  return (
    <div className="fb-settings fb-panel" style={{ gap: 8, padding: 10 }}>
      <div className="flex items-center gap-2">
        <div style={{ flex: 1, minWidth: 0 }}>
          <ChoiceSelect<EventActionType>
            ariaLabel="Action"
            value={action.type}
            options={allowed.map((t) => ({ label: EVENT_ACTION_LABEL[t], value: t }))}
            onChange={(type) => onChange(eventActionOf(type, fields))}
          />
        </div>
        {action.type === 'SET_VALUE' && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ChoiceSelect
              ariaLabel="Field"
              placeholder="Choose a field"
              value={targets.some((f) => f.name === action.target) ? action.target : undefined}
              options={targets.map((f) => ({ label: fieldName(f), value: f.name }))}
              onChange={(target) => onChange({ ...action, target })}
            />
          </div>
        )}
        {action.type === 'GO_TO_STEP' && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <ChoiceSelect
              ariaLabel="Step"
              placeholder={stepsOf(fields).length ? 'Choose a step' : 'The form has no steps'}
              value={stepsOf(fields).some((f) => f.name === action.step) ? action.step : undefined}
              options={stepsOf(fields).map((f) => ({ label: fieldName(f), value: f.name }))}
              onChange={(step) => onChange({ ...action, step })}
            />
          </div>
        )}
        {onRemove && (
          <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label="Remove action" onClick={onRemove}>
            <Trash2 size={14} />
          </button>
        )}
      </div>
      {action.type === 'SET_VALUE' && <FormulaInput label="Formula" value={action.value} names={names} placeholder="today()" onChange={(value) => onChange({ ...action, value })} />}
      {action.type === 'FETCH' && <FetchEditor action={action} fields={fields} onChange={onChange} />}
      {action.type === 'SHOW_MESSAGE' && (
        <Input aria-label="Message" className={VISIBLE_BORDER} value={action.message} maxLength={500} placeholder="What the person should read" onChange={(e) => onChange({ ...action, message: e.target.value })} />
      )}
      {action.type === 'REDIRECT' && (
        <Input aria-label="Address" className={VISIBLE_BORDER} value={action.url} maxLength={500} placeholder="https://… or /a-page-on-this-site" onChange={(e) => onChange({ ...action, url: e.target.value })} />
      )}
    </div>
  );
}

const MODES: { label: string; value: ConditionMode }[] = [
  { label: 'Every time', value: 'always' },
  { label: 'Only when conditions are met', value: 'conditions' },
  { label: 'Only when a formula is true', value: 'formula' },
];

const modeOf = (event: FormEvent): ConditionMode => (!event.when ? 'always' : isExpressionCondition(event.when) ? 'formula' : 'conditions');

interface EventCardProps {
  event: FormEvent;
  index: number;
  fields: FormField[];
  names: ReadonlySet<string>;
  problems: string[];
  onChange: (event: FormEvent) => void;
  onRemove: () => void;
}

function EventCard({ event, index, fields, names, problems, onChange, onRemove }: EventCardProps) {
  const title = event.name?.trim() || `Event ${index + 1}`;
  const allowed = EVENT_ACTIONS_FOR[event.on.type];
  const buttons = buttonsOf(fields);
  const watchable = watchableFields(fields);
  const setMode = (mode: ConditionMode) => {
    if (mode === modeOf(event)) return;
    const { when: _when, ...rest } = event;
    onChange(mode === 'always' ? rest : { ...rest, when: mode === 'formula' ? { expr: '' } : defaultCondition(readableFields(fields)[0]) });
  };
  return (
    <section className="fb-panel fb-settings" style={{ gap: 14 }} aria-label={title}>
      <div className="flex items-center gap-2">
        <Input aria-label="Event name" className={VISIBLE_BORDER} style={{ flex: 1 }} value={event.name ?? ''} maxLength={120} placeholder={`Event ${index + 1}`} onChange={(e) => onChange({ ...event, name: e.target.value })} />
        <label className="flex items-center gap-2 text-sm">
          <Switch aria-label="Event is on" checked={!event.disabled} onCheckedChange={(on) => onChange({ ...event, disabled: on ? undefined : true })} />
          On
        </label>
        <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label={`Delete ${title}`} onClick={onRemove}>
          <Trash2 size={16} />
        </button>
      </div>

      <div className="fb-settings" style={{ gap: 8 }}>
        <ChoiceSelect<TriggerType> ariaLabel="Happens" value={event.on.type} options={TRIGGERS.map((t) => ({ label: TRIGGER_LABEL[t], value: t }))} onChange={(type) => onChange(withTrigger(event, type, fields))} />
        {event.on.type === 'CLICK' && (
          <ChoiceSelect
            ariaLabel="Button"
            placeholder={buttons.length ? 'Choose a button' : 'Add a Button field to the form first'}
            value={buttons.some((b) => b.name === (event.on as { field: string }).field) ? (event.on as { field: string }).field : undefined}
            options={buttons.map((b) => ({ label: fieldName(b), value: b.name }))}
            onChange={(field) => onChange({ ...event, on: { type: 'CLICK', field } })}
          />
        )}
        {event.on.type === 'CHANGE' && (
          <ChoiceSelect
            ariaLabel="Answer"
            placeholder="Choose the question"
            value={watchable.some((f) => f.name === (event.on as { field: string }).field) ? (event.on as { field: string }).field : undefined}
            options={watchable.map((f) => ({ label: fieldName(f), value: f.name }))}
            onChange={(field) => onChange({ ...event, on: { type: 'CHANGE', field } })}
          />
        )}
        <ChoiceSelect<ConditionMode> ariaLabel="Runs" value={modeOf(event)} options={MODES} onChange={setMode} />
        {event.when && isExpressionCondition(event.when) && (
          <FormulaInput label="Condition formula" value={event.when.expr} names={names} placeholder="amount > 5000" onChange={(expr) => onChange({ ...event, when: { expr } })} />
        )}
        {event.when && !isExpressionCondition(event.when) && (
          <ConditionEditor condition={event.when as Condition} candidates={readableFields(fields)} onChange={(when) => onChange({ ...event, when })} />
        )}
      </div>

      <div className="fb-settings" style={{ gap: 8 }} role="group" aria-label="Do">
        <div className="fb-panel__title">Do</div>
        {event.do.map((action, i) => (
          <EventActionRow
            key={i}
            action={action}
            allowed={allowed}
            fields={fields}
            names={names}
            onChange={(next) => onChange({ ...event, do: event.do.map((a, j) => (j === i ? next : a)) })}
            onRemove={event.do.length === 1 ? undefined : () => onChange({ ...event, do: event.do.filter((_, j) => j !== i) })}
          />
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" disabled={event.do.length >= 10} onClick={() => onChange({ ...event, do: [...event.do, eventActionOf(allowed[0], fields)] })}>
            <Plus /> Add action
          </Button>
        </div>
      </div>

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

interface EventsEditorProps {
  form: FormDefinition;
  readOnly: boolean;
  onChange: (events: FormEvent[]) => void;
}

/**
 * Things that happen once, at a moment: the form opens, a button is clicked,
 * a submit succeeds or fails. They help the person filling in; the server
 * relies on none of them.
 */
export function EventsEditor({ form, readOnly, onChange }: EventsEditorProps) {
  const events = form.events ?? [];
  const names = new Set(form.fields.map((f) => f.name));
  const problems = eventProblems(form);
  return (
    <div className="fb-settings" style={{ gap: 16 }}>
      {!events.length && (
        <p className="fb-muted">
          No events yet. Add one to fill a date when the form opens, look a customer up when a button is clicked, or end with a different message for some answers.
        </p>
      )}
      {events.map((event, i) => (
        <EventCard
          key={event.id}
          event={event}
          index={i}
          fields={form.fields}
          names={names}
          problems={problems.get(i) ?? []}
          onChange={(next) => onChange(events.map((e, j) => (j === i ? next : e)))}
          onRemove={() => onChange(events.filter((_, j) => j !== i))}
        />
      ))}
      {!readOnly && (
        <div>
          <Button type="button" variant="outline" disabled={events.length >= MAX_EVENTS} onClick={() => onChange([...events, newEvent(events, form.fields)])}>
            <Plus /> Add event
          </Button>
        </div>
      )}
    </div>
  );
}
