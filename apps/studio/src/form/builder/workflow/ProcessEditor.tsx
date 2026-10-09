import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import { Input } from '@ui/input';
import type { AssignmentRule, FormDefinition, StatusCategory, WorkflowConfig } from '../../types';
import { isOptionField, refPrefixOf } from '../../engine';
import type { Person } from '../../adapters/workflow';
import { VISIBLE_BORDER } from '../../runtime/styles';
import { ChoiceSelect, SelectSetting, Setting, SwitchSetting, TextSetting } from '../components/settings';
import { PersonSelect } from './PersonSelect';
import { ActionsEditor, FollowUpEditor, PriorityEditor } from './ProcessExtras';
import { addStatus, moveStatus, removeStatus, renameStatus, setRestricted, STARTER_WORKFLOW, toggleMove } from './workflow-edits';

interface ProcessEditorProps {
  form: FormDefinition;
  people: Person[];
  /** Status keys earlier versions published - records may carry them, so their keys never change. */
  publishedKeys: ReadonlySet<string>;
  /** In the library: record numbers belong to each form that uses the workflow, not to the workflow. */
  shared?: boolean;
  onChange: (workflow: WorkflowConfig | undefined) => void;
}

const CATEGORIES: { label: string; value: StatusCategory }[] = [
  { label: 'Open', value: 'OPEN' },
  { label: 'In progress', value: 'IN_PROGRESS' },
  { label: 'Done (closes it)', value: 'DONE' },
];

type RuleType = AssignmentRule['type'];

/** Statuses, allowed moves and who new records go to. */
export function ProcessEditor({ form, people, publishedKeys, shared = false, onChange }: ProcessEditorProps) {
  const wf = form.workflow;
  const optionFields = form.fields.filter((f) => isOptionField(f) && f.dataSource?.type === 'STATIC');

  if (!wf?.enabled) {
    return (
      <div className="fb-settings" style={{ gap: 12 }}>
        <SwitchSetting
          label="Track submissions as records"
          checked={false}
          onChange={() => onChange(wf ? { ...wf, enabled: true } : STARTER_WORKFLOW)}
          hint="Each submission gets a reference number, a status and an owner, and appears in the Inbox. Leave off for forms that only collect data."
        />
      </div>
    );
  }

  const set = (next: WorkflowConfig) => onChange(next);
  const rule: AssignmentRule = wf.assignment ?? { type: 'NONE' };
  const setRule = (assignment: AssignmentRule) => set({ ...wf, assignment });

  return (
    <div className="fb-settings" style={{ gap: 12 }}>
      <SwitchSetting
        label="Track submissions as records"
        checked
        onChange={() => onChange({ ...wf, enabled: false })}
        hint="Turning this off keeps your statuses here, but new submissions won't get a status or owner."
      />
      {!shared && (
        <TextSetting
          label="Reference prefix"
          value={wf.refPrefix}
          placeholder={refPrefixOf({ code: form.code })}
          hint={`Records are numbered ${wf.refPrefix || refPrefixOf({ code: form.code })}-000001, -000002, ...`}
          onChange={(v) => set({ ...wf, refPrefix: v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || undefined })}
        />
      )}

      <div className="fb-panel__title">Statuses</div>
      <p className="fb-muted">New records start in the first status. A "Done" status closes a record and stops its SLA clock.</p>
      {wf.statuses.map((s, i) => (
        <div key={i} className="fb-panel fb-settings" style={{ gap: 8, padding: 10 }}>
          <div className="flex items-center gap-2">
            <Input aria-label="Status name" value={s.label} onChange={(e) => set(renameStatus(wf, i, e.target.value, publishedKeys))} />
            <button type="button" className="fb-icon-btn" aria-label={`Move ${s.label} up`} disabled={i === 0} onClick={() => set(moveStatus(wf, i, -1))}>
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              className="fb-icon-btn"
              aria-label={`Move ${s.label} down`}
              disabled={i === wf.statuses.length - 1}
              onClick={() => set(moveStatus(wf, i, 1))}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              className="fb-icon-btn fb-icon-btn--danger"
              aria-label={`Delete ${s.label}`}
              disabled={wf.statuses.length <= 1 || publishedKeys.has(s.key)}
              title={publishedKeys.has(s.key) ? 'Published versions use this status - records may be in it' : undefined}
              onClick={() => set(removeStatus(wf, i))}
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div style={{ flex: 1 }}>
              <ChoiceSelect<StatusCategory>
                ariaLabel={`${s.label} kind`}
                value={s.category}
                options={CATEGORIES}
                onChange={(category) => set({ ...wf, statuses: wf.statuses.map((x, j) => (j === i ? { ...x, category, slaHours: category === 'DONE' ? undefined : x.slaHours } : x)) })}
              />
            </div>
            {s.category !== 'DONE' && (
              <Input
                aria-label={`${s.label} SLA hours`}
                type="number"
                min={1}
                style={{ width: 150 }}
                placeholder="SLA (hours)"
                value={s.slaHours ?? ''}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  set({ ...wf, statuses: wf.statuses.map((x, j) => (j === i ? { ...x, slaHours: e.target.value && n > 0 ? n : undefined } : x)) });
                }}
              />
            )}
          </div>
          <span className="fb-setting__hint">
            Key <span className="fb-code">{s.key}</span>
            {i === 0 ? ' · new records start here' : ''}
          </span>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => set(addStatus(wf))} style={{ alignSelf: 'flex-start' }}>
        <Plus /> Add status
      </Button>

      <SwitchSetting
        label="Limit which moves are allowed"
        checked={!!wf.transitions}
        onChange={(on) => set(setRestricted(wf, on))}
        hint="Off: a record can move to any status."
      />
      {wf.transitions && (
        <div className="fb-settings" style={{ gap: 8 }}>
          {wf.statuses.map((from) => (
            <div key={from.key} className="fb-panel" style={{ padding: 10 }}>
              <div className="text-sm" style={{ marginBottom: 6 }}>
                From <strong>{from.label}</strong> to:
              </div>
              <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                {wf.statuses
                  .filter((to) => to.key !== from.key)
                  .map((to) => (
                    <label key={to.key} className="flex items-center gap-2 text-sm" style={{ marginRight: 12 }}>
                      <Checkbox
                        className={VISIBLE_BORDER}
                        checked={wf.transitions?.[from.key]?.includes(to.key) ?? false}
                        onCheckedChange={(c) => set(toggleMove(wf, from.key, to.key, c === true))}
                      />
                      {to.label}
                    </label>
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="fb-panel__title">Assignment</div>
      <SelectSetting<RuleType>
        label="New records go to"
        value={rule.type}
        options={[
          { label: 'No one (pick up from the Inbox)', value: 'NONE' },
          { label: 'One person', value: 'USER' },
          { label: 'A team, in turn (round robin)', value: 'ROUND_ROBIN' },
          ...(optionFields.length ? [{ label: 'Depends on an answer', value: 'BY_FIELD' as const }] : []),
        ]}
        onChange={(type) =>
          setRule(
            type === 'USER'
              ? { type, userId: '' }
              : type === 'ROUND_ROBIN'
                ? { type, userIds: [] }
                : type === 'BY_FIELD'
                  ? { type, field: optionFields[0]?.name ?? '', map: {} }
                  : { type: 'NONE' },
          )
        }
        hint={people.length ? undefined : 'Only people with a Form records module (or Form designer / publisher / admin) can be assigned.'}
      />
      {rule.type === 'USER' && (
        <Setting label="Person">{() => <PersonSelect people={people} value={rule.userId} onChange={(userId) => setRule({ ...rule, userId })} />}</Setting>
      )}
      {rule.type === 'ROUND_ROBIN' && (
        <Setting label="Team" hint="Each new record goes to the next person in the list.">
          {() => (
            <div className="fb-settings" style={{ gap: 6 }}>
              {people.map((p) => (
                <label key={p.uuid} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    className={VISIBLE_BORDER}
                    checked={rule.userIds.includes(p.uuid)}
                    onCheckedChange={(c) => setRule({ ...rule, userIds: c === true ? [...rule.userIds, p.uuid] : rule.userIds.filter((u) => u !== p.uuid) })}
                  />
                  {p.name || p.email}
                </label>
              ))}
            </div>
          )}
        </Setting>
      )}
      {rule.type === 'BY_FIELD' && (
        <>
          <SelectSetting
            label="Answer"
            value={rule.field || undefined}
            options={optionFields.map((f) => ({ label: f.label || f.name, value: f.name }))}
            onChange={(field) => setRule({ ...rule, field, map: {} })}
          />
          {(optionFields.find((f) => f.name === rule.field)?.dataSource?.options ?? []).map((o) => (
            <Setting key={o.value} label={`"${o.label}" goes to`}>
              {() => (
                <PersonSelect
                  people={people}
                  value={rule.map[o.value] ?? ''}
                  onChange={(userId) => {
                    const map = { ...rule.map };
                    if (userId) map[o.value] = userId;
                    else delete map[o.value];
                    setRule({ ...rule, map });
                  }}
                />
              )}
            </Setting>
          ))}
          <Setting label="Anything else goes to">
            {() => <PersonSelect people={people} value={rule.fallbackUserId ?? ''} placeholder="No one" onChange={(u) => setRule({ ...rule, fallbackUserId: u || undefined })} />}
          </Setting>
        </>
      )}
      <PriorityEditor form={form} wf={wf} onChange={set} />
      <ActionsEditor form={form} wf={wf} onChange={set} people={people} />
      <FollowUpEditor form={form} wf={wf} onChange={set} />
    </div>
  );
}
