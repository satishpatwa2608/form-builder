import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import type { FormDefinition, Priority, WorkflowAction, WorkflowConfig } from '../../types';
import type { Person } from '../../adapters/workflow';
import { RecipientsEditor } from './RecipientsEditor';
import { isValueField } from '../../engine';
import { VISIBLE_BORDER } from '../../runtime/styles';
import { ConditionEditor, defaultCondition } from '../components/ConditionEditor';
import { ChoiceSelect, SelectSetting, Setting, SwitchSetting, TextSetting } from '../components/settings';
import { actionKeyFrom, answerFields, conditionCandidates, newWorkflowAction, PRIORITY_LABEL } from './workflow-edits';

const PRIORITIES = Object.keys(PRIORITY_LABEL) as Priority[];
const STAY = '__stay__';
const NONE = '__none__';
const priorityChoices = PRIORITIES.map((p) => ({ label: PRIORITY_LABEL[p], value: p }));

interface Props {
  form: FormDefinition;
  wf: WorkflowConfig;
  onChange: (wf: WorkflowConfig) => void;
  people?: Person[];
}

/** New items' priority: a default plus "if the answers say so" rules (first match wins). */
export function PriorityEditor({ form, wf, onChange }: Props) {
  const priority = wf.priority ?? { default: 'MEDIUM' as Priority };
  const rules = priority.rules ?? [];
  const candidates = answerFields(form);
  const set = (changes: Partial<typeof priority>) => onChange({ ...wf, priority: { ...priority, ...changes } });

  return (
    <div className="fb-settings" style={{ gap: 10 }}>
      <div className="fb-panel__title">Priority</div>
      <SelectSetting<Priority> label="New items start as" value={priority.default} options={priorityChoices} onChange={(d) => set({ default: d })} />
      {rules.map((r, i) => (
        <div key={i} className="fb-panel fb-settings" style={{ gap: 8, padding: 10 }}>
          <div className="flex items-center gap-2">
            <span className="text-sm">Set to</span>
            <div style={{ width: 160 }}>
              <ChoiceSelect<Priority>
                ariaLabel={`Rule ${i + 1} priority`}
                value={r.priority}
                options={priorityChoices}
                onChange={(p) => set({ rules: rules.map((x, j) => (j === i ? { ...x, priority: p } : x)) })}
              />
            </div>
            <span className="text-sm">when…</span>
            <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label={`Delete priority rule ${i + 1}`} onClick={() => set({ rules: rules.filter((_, j) => j !== i) })}>
              <Trash2 size={14} />
            </button>
          </div>
          <ConditionEditor condition={r.if} candidates={candidates} onChange={(c) => set({ rules: rules.map((x, j) => (j === i ? { ...x, if: c } : x)) })} />
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        style={{ alignSelf: 'flex-start' }}
        disabled={!candidates.length}
        onClick={() => set({ rules: [...rules, { if: defaultCondition(candidates[0]), priority: 'HIGH' }] })}
      >
        <Plus /> Add priority rule
      </Button>
    </div>
  );
}

/**
 * Named moves shown as buttons in the Inbox ("Start", "Resolve", "Reject").
 * Once a form has actions, records move only through them.
 */
export function ActionsEditor({ form, wf, onChange, people = [] }: Props) {
  const actions = wf.actions ?? [];
  const workFields = (wf.workFields ?? []).filter(isValueField);
  const statusChoices = wf.statuses.map((s) => ({ label: s.label, value: s.key }));
  const setAction = (i: number, changes: Partial<WorkflowAction>) =>
    onChange({ ...wf, actions: actions.map((a, j) => (j === i ? { ...a, ...changes } : a)) });
  const setActions = (list: WorkflowAction[]) => onChange({ ...wf, actions: list.length ? list : undefined });

  return (
    <div className="fb-settings" style={{ gap: 10 }}>
      <div className="fb-panel__title">Actions</div>
      <p className="fb-muted">
        Buttons people use to move an item, e.g. "Resolve" (needs the root cause and a comment). With actions, items move only through them;
        without, any allowed status can be picked.
      </p>
      {actions.map((a, i) => (
        <div key={i} className="fb-panel fb-settings" style={{ gap: 8, padding: 10 }} aria-label={`Action ${a.label}`}>
          <div className="flex items-center gap-2">
            <div style={{ flex: 1 }}>
              <TextSetting
                label="Button label"
                value={a.label}
                onChange={(label) => setAction(i, { label, key: a.key.startsWith('action_') || a.key === actionKeyFrom(a.label) ? actionKeyFrom(label) : a.key })}
              />
            </div>
            <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label={`Delete action ${a.label}`} style={{ alignSelf: 'flex-end' }} onClick={() => setActions(actions.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </button>
          </div>
          <SelectSetting label="Moves the item to" value={a.to || undefined} options={statusChoices} onChange={(to) => setAction(i, { to })} />
          <Setting label="Shown when the item is in" hint="None ticked = every status (except the one it moves to).">
            {() => (
              <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                {wf.statuses.map((s) => (
                  <label key={s.key} className="flex items-center gap-2 text-sm" style={{ marginRight: 10 }}>
                    <Checkbox
                      className={VISIBLE_BORDER}
                      checked={a.from?.includes(s.key) ?? false}
                      onCheckedChange={(c) => {
                        const from = c === true ? [...(a.from ?? []), s.key] : (a.from ?? []).filter((x) => x !== s.key);
                        setAction(i, { from: from.length ? from : undefined });
                      }}
                    />
                    {s.label}
                  </label>
                ))}
              </div>
            )}
          </Setting>
          {workFields.length > 0 && (
            <Setting label="Work fields that must be filled first">
              {() => (
                <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                  {workFields.map((f) => (
                    <label key={f.name} className="flex items-center gap-2 text-sm" style={{ marginRight: 10 }}>
                      <Checkbox
                        className={VISIBLE_BORDER}
                        checked={a.requireFields?.includes(f.name) ?? false}
                        onCheckedChange={(c) => {
                          const req = c === true ? [...(a.requireFields ?? []), f.name] : (a.requireFields ?? []).filter((x) => x !== f.name);
                          setAction(i, { requireFields: req.length ? req : undefined });
                        }}
                      />
                      {f.label || f.name}
                    </label>
                  ))}
                </div>
              )}
            </Setting>
          )}
          <SwitchSetting label="Ask for a comment" checked={!!a.requireComment} onChange={(on) => setAction(i, { requireComment: on || undefined })} />
          <SwitchSetting
            label="Needs approval"
            checked={!!a.approval}
            hint="The move waits until an approver agrees (e.g. the assignee's manager approves Resolve)."
            onChange={(on) => setAction(i, { approval: on ? { to: [{ kind: 'MANAGER' }] } : undefined })}
          />
          {a.approval && (
            <>
              <Setting label="Approvers">
                {() => <RecipientsEditor form={form} people={people} usersOnly value={a.approval!.to} onChange={(to) => setAction(i, { approval: { ...a.approval!, to } })} />}
              </Setting>
              <SwitchSetting
                label="Only when…"
                checked={!!a.approval.if}
                hint="e.g. only when the compensation amount is at least 50,000 - otherwise the action moves straight away."
                onChange={(on) => setAction(i, { approval: { ...a.approval!, if: on ? defaultCondition(conditionCandidates(form)[0]) : undefined } })}
              />
              {a.approval.if && (
                <ConditionEditor
                  condition={a.approval.if}
                  candidates={conditionCandidates(form)}
                  onChange={(cond) => setAction(i, { approval: { ...a.approval!, if: cond } })}
                />
              )}
              <SelectSetting
                label="If rejected, move to"
                value={a.approval.onReject ?? STAY}
                options={[{ label: 'Stay where it is', value: STAY }, ...statusChoices]}
                onChange={(v) => setAction(i, { approval: { ...a.approval!, onReject: v === STAY ? undefined : v } })}
              />
            </>
          )}
          <span className="fb-setting__hint">
            Key <span className="fb-code">{a.key}</span>
          </span>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setActions([...actions, newWorkflowAction(wf)])}>
        <Plus /> Add action
      </Button>
    </div>
  );
}

/** Reopen window, "request information" status and where the requester's email is. */
export function FollowUpEditor({ form, wf, onChange }: Props) {
  const statusChoices = wf.statuses.map((st) => ({ label: st.label, value: st.key }));
  const openStatuses = wf.statuses.filter((st) => st.category !== 'DONE').map((st) => ({ label: st.label, value: st.key }));
  const emailFields = form.fields.filter((f) => f.type === 'EMAIL').map((f) => ({ label: f.label || f.name, value: f.name }));
  return (
    <div className="fb-settings" style={{ gap: 10 }}>
      <div className="fb-panel__title">Follow-up</div>
      <SwitchSetting
        label="Closed items can be reopened"
        checked={!!wf.reopen}
        onChange={(on) => onChange({ ...wf, reopen: on ? { to: openStatuses[0]?.value ?? '', withinDays: 30 } : undefined })}
      />
      {wf.reopen && (
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200, flex: 1 }}>
            <SelectSetting label="Reopen into" value={wf.reopen.to || undefined} options={openStatuses} onChange={(to) => onChange({ ...wf, reopen: { ...wf.reopen!, to } })} />
          </div>
          <div style={{ width: 180 }}>
            <Setting label="Within (days)">
              {(id) => (
                <input
                  id={id}
                  type="number"
                  min={1}
                  className="fb-number"
                  value={wf.reopen!.withinDays ?? ''}
                  onChange={(e) => onChange({ ...wf, reopen: { ...wf.reopen!, withinDays: Number(e.target.value) > 0 ? Number(e.target.value) : undefined } })}
                />
              )}
            </Setting>
          </div>
        </div>
      )}
      <SelectSetting
        label='"Request information" moves the item to'
        value={wf.requestInfoStatus ?? NONE}
        options={[{ label: "Don't move it", value: NONE }, ...statusChoices]}
        hint="Pick your waiting status; add it to the SLA's pause list so the clock stops while you wait."
        onChange={(v) => onChange({ ...wf, requestInfoStatus: v === NONE ? undefined : v })}
      />
      <SelectSetting
        label="Requester's email is in"
        value={wf.contactEmailField ?? NONE}
        options={[{ label: emailFields.length ? `The first email field (${emailFields[0].label})` : 'The signed-in submitter', value: NONE }, ...emailFields]}
        onChange={(v) => onChange({ ...wf, contactEmailField: v === NONE ? undefined : v })}
      />
    </div>
  );
}
