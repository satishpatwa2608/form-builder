import { Fragment, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRightLeft, ArrowUp, Bell, Code2, Flag, ListChecks, Mail, Play, Plus, Trash2, UserCheck, UserPlus, Webhook, X, PenLine, Workflow, Undo2 } from 'lucide-react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import type { Automation, AutomationAction, AutomationTrigger, FormDefinition } from '../../types';
import { isValueField, stepKey } from '../../engine';
import type { CustomWorkflow, Person } from '../../adapters/workflow';
import { ConditionEditor, defaultCondition } from '../components/ConditionEditor';
import { SelectSetting, Setting, SwitchSetting, TextSetting } from '../components/settings';
import { ActionEditor } from './ActionEditor';
import {
  ACTION_LABEL,
  availableData,
  canRunWithPrevious,
  branchEnd,
  branchOf,
  DECISION_LABEL,
  DECISIONS,
  decisionIf,
  flowBlocks,
  type Decision,
  insertStep,
  moveStep,
  newAutomation,
  newStep,
  outputPseudoFields,
  conditionCandidates,
  stepSummary,
  stepTitle,
  UNAVAILABLE_ACTIONS, WORKFLOW_ONLY_ACTIONS,
} from './workflow-edits';

interface FlowEditorProps {
  form: FormDefinition;
  people: Person[];
  customWorkflows: CustomWorkflow[];
  /** Which automation to show first (the picture of the workflow opens the one that was clicked). */
  startAt?: number;
  onChange: (automations: Automation[] | undefined) => void;
}

export const STEP_ICON: Record<AutomationAction['type'], ReactNode> = {
  EMAIL: <Mail size={16} />,
  APPROVAL: <UserCheck size={16} />,
  SIGN: <PenLine size={16} />,
  NOTIFY: <Bell size={16} />,
  CREATE_TASK: <ListChecks size={16} />,
  ASSIGN: <UserPlus size={16} />,
  SET_STATUS: <ArrowRightLeft size={16} />,
  WEBHOOK: <Webhook size={16} />,
  FLOW: <Workflow size={16} />,
  HANDLER: <Code2 size={16} />,
  GO_BACK: <Undo2 size={16} />,
};

export const TRIGGER_LABEL: Record<AutomationTrigger, string> = {
  SUBMITTED: 'A form is submitted',
  STATUS_CHANGED: 'The status changes',
  SLA_BREACHED: 'A time limit is missed (SLA)',
  FIELD_UPDATED: 'A work field changes',
  SLA_APPROACHING: 'Resolution time is almost up (SLA warning)',
};

const ANY = '__any__';
type Selected = { kind: 'start' } | { kind: 'step'; index: number };

/**
 * Automations as flow diagrams, like an AEM workflow model: a start (the
 * trigger), steps top to bottom, an end. "+" between nodes inserts a step;
 * clicking a node opens its settings on the right. Each step gets the
 * payload (answers + record) and what the steps above it produced.
 */
export function FlowEditor({ form, people, customWorkflows, startAt = 0, onChange }: FlowEditorProps) {
  const automations = form.automations ?? [];
  const [current, setCurrent] = useState(startAt);
  const [selected, setSelected] = useState<Selected>({ kind: 'start' });
  const [pickerAt, setPickerAt] = useState<number | null>(null);
  const [branchPick, setBranchPick] = useState<string | null>(null);

  const tracked = !!form.workflow?.enabled;
  const index = Math.min(current, Math.max(automations.length - 1, 0));
  const flow = automations[index];

  const setAll = (list: Automation[]) => onChange(list.length ? list : undefined);
  const update = (changes: Partial<Automation>) => setAll(automations.map((a, i) => (i === index ? { ...a, ...changes } : a)));
  const setSteps = (actions: AutomationAction[]) => update({ actions });

  const addFlow = () => {
    setAll([...automations, newAutomation(automations)]);
    setCurrent(automations.length);
    setSelected({ kind: 'start' });
    setPickerAt(null);
  };
  const openFlow = (i: number) => {
    setCurrent(i);
    setSelected({ kind: 'start' });
    setPickerAt(null);
  };
  const addStep = (at: number, type: AutomationAction['type'], onlyIf?: AutomationAction['if']) => {
    if (!flow) return;
    setSteps(insertStep(flow.actions, at, { ...newStep(type, form, flow.actions), ...(onlyIf ? { if: onlyIf } : {}) }));
    setSelected({ kind: 'step', index: at });
    setPickerAt(null);
    setBranchPick(null);
  };

  const stepTypes = (Object.keys(ACTION_LABEL) as AutomationAction['type'][]).filter((t) => !UNAVAILABLE_ACTIONS.has(t) && (tracked || !WORKFLOW_ONLY_ACTIONS.has(t)));

  const connector = (at: number) => (
    <Fragment key={`c${at}`}>
      <div className="fb-flow__connector">
        <button
          type="button"
          className="fb-flow__add"
          aria-label={`Add a step ${at === 0 ? 'at the start' : `after step ${at}`}`}
          aria-expanded={pickerAt === at}
          onClick={() => setPickerAt(pickerAt === at ? null : at)}
        >
          {pickerAt === at ? <X size={14} /> : <Plus size={14} />}
        </button>
      </div>
      {pickerAt === at && (
        <div className="fb-flow__picker" role="group" aria-label="Choose a step">
          {stepTypes.map((t) => (
            <button key={t} type="button" className="fb-flow__pick" onClick={() => addStep(at, t)}>
              {STEP_ICON[t]}
              {ACTION_LABEL[t]}
            </button>
          ))}
        </div>
      )}
    </Fragment>
  );

  // One step's box. Steps on an approval's branch are the same boxes, drawn under "If approved" / "If rejected".
  const node = (i: number) => {
    if (!flow) return null;
    const step = flow.actions[i]!;
    return (
      <div key={`s${i}`} className={`fb-flow__node${selected.kind === 'step' && selected.index === i ? ' fb-flow__node--selected' : ''}`}>
        <button type="button" className="fb-flow__select" onClick={() => setSelected({ kind: 'step', index: i })}>
          <span className="fb-flow__icon">{STEP_ICON[step.type]}</span>
          <span className="fb-flow__text">
            <span className="fb-flow__title">
              {i + 1}. {stepTitle(step)}
            </span>
            <span className="fb-flow__summary">
              {step.withPrevious && canRunWithPrevious(flow.actions, i) ? 'At the same time as the step before · ' : ''}
              {stepSummary(step, form, people, customWorkflows)}
            </span>
            <span className="fb-flow__badges">
              <span className="fb-code">{stepKey(step, i)}</span>
              {/* On a branch the branch's own title already says when it runs. */}
                        {step.if && !branchOf(step) && <span className="fb-chip fb-chip--rule">only if…</span>}
              {step.continueOnError && <span className="fb-chip">continues on error</span>}
            </span>
          </span>
        </button>
        <span className="fb-flow__tools">
          <button type="button" className="fb-icon-btn" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => setSteps(moveStep(flow.actions, i, -1))}>
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className="fb-icon-btn"
            aria-label={`Move step ${i + 1} down`}
            disabled={i === flow.actions.length - 1}
            onClick={() => setSteps(moveStep(flow.actions, i, 1))}
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className="fb-icon-btn fb-icon-btn--danger"
            aria-label={`Delete step ${i + 1}`}
            onClick={() => {
              setSteps(flow.actions.filter((_, j) => j !== i));
              setSelected({ kind: 'start' });
            }}
          >
            <Trash2 size={14} />
          </button>
        </span>
      </div>
    );
  };

  // "+ Add a step" at the foot of a branch: the new step runs only when that approval ended that way.
  const branchAdd = (approvalIndex: number, decision: Decision) => {
    if (!flow) return null;
    const id = `${approvalIndex}:${decision}`;
    return (
      <>
        <button type="button" className="fb-flow__branch-add" aria-expanded={branchPick === id} onClick={() => setBranchPick(branchPick === id ? null : id)}>
          {branchPick === id ? <X size={12} /> : <Plus size={12} />} Add a step {decision === 'APPROVED' ? 'when approved' : 'when rejected'}
        </button>
        {branchPick === id && (
          <div className="fb-flow__picker fb-flow__picker--branch" role="group" aria-label="Choose a step">
            {stepTypes
              .filter((t) => t !== 'APPROVAL')
              .map((t) => (
                <button key={t} type="button" className="fb-flow__pick" onClick={() => addStep(branchEnd(flow.actions, approvalIndex), t, decisionIf(stepKey(flow.actions[approvalIndex]!, approvalIndex), decision))}>
                  {STEP_ICON[t]}
                  {ACTION_LABEL[t]}
                </button>
              ))}
          </div>
        )}
      </>
    );
  };

  return (
    <div className="fb-settings" style={{ gap: 12 }}>
      <p className="fb-muted">
        Each automation is a flow that runs on the server after a submission is saved, top to bottom. Every step gets the answers and the record
        (the payload) plus what earlier steps produced. A failed step stops the flow unless it's set to continue. Every run shows on the record's
        timeline.
      </p>

      <div className="fb-flow-tabs" role="tablist" aria-label="Automations">
        {automations.map((a, i) => (
          <button key={a.id} type="button" role="tab" aria-selected={i === index} className="fb-flow-tab" onClick={() => openFlow(i)}>
            {a.name || 'Untitled'}
            {!a.enabled && <span className="fb-chip">Off</span>}
          </button>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addFlow}>
          <Plus /> New automation
        </Button>
      </div>

      {!flow ? (
        <p className="fb-muted">No automations yet. Add one to send emails, create tasks, call APIs and more after a submission.</p>
      ) : (
        <div className="fb-flow-layout">
          <div className="fb-flow" aria-label={`${flow.name} flow`}>
            <button
              type="button"
              className={`fb-flow__node fb-flow__node--start${selected.kind === 'start' ? ' fb-flow__node--selected' : ''}`}
              onClick={() => setSelected({ kind: 'start' })}
            >
              <span className="fb-flow__icon">
                <Play size={16} />
              </span>
              <span className="fb-flow__text">
                <span className="fb-flow__title">Start</span>
                <span className="fb-flow__summary">
                  {TRIGGER_LABEL[flow.when]}
                  {flow.when === 'STATUS_CHANGED' && flow.toStatus ? ` → ${form.workflow?.statuses.find((s) => s.key === flow.toStatus)?.label ?? flow.toStatus}` : ''}
                  {flow.if ? ' · only if…' : ''}
                </span>
              </span>
            </button>
            {connector(0)}
            {flowBlocks(flow.actions).map((block) => (
              <Fragment key={`b${block.index}`}>
                {node(block.index)}
                {block.branches && (
                  <div className="fb-flow__fork" role="group" aria-label={`Branches of step ${block.index + 1}`}>
                    {DECISIONS.map((d) => (
                      <div key={d} className={`fb-flow__branch fb-flow__branch--${d}`} role="group" aria-label={`${DECISION_LABEL[d]}, after step ${block.index + 1}`}>
                        <span className="fb-flow__branch-title">{DECISION_LABEL[d]}</span>
                        {block.branches![d].map((i) => node(i))}
                        {branchAdd(block.index, d)}
                      </div>
                    ))}
                  </div>
                )}
                {connector(block.branches ? branchEnd(flow.actions, block.index) : block.index + 1)}
              </Fragment>
            ))}
            <div className="fb-flow__node fb-flow__node--end" aria-label="End">
              <span className="fb-flow__icon">
                <Flag size={16} />
              </span>
              <span className="fb-flow__title">End</span>
            </div>
          </div>

          <aside className="fb-flow-inspector fb-panel" aria-label="Step settings">
            {selected.kind === 'start' || !flow.actions[selected.index] ? (
              <StartSettings
                form={form}
                flow={flow}
                onChange={update}
                onDelete={() => {
                  setAll(automations.filter((_, i) => i !== index));
                  setCurrent(Math.max(0, index - 1));
                }}
              />
            ) : (
              <StepSettings
                form={form}
                steps={flow.actions}
                index={selected.index}
                people={people}
                customWorkflows={customWorkflows}
                onChange={(step) => setSteps(flow.actions.map((s, j) => (j === selected.index ? step : s)))}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

export function StartSettings({ form, flow, onChange, onDelete }: { form: FormDefinition; flow: Automation; onChange: (c: Partial<Automation>) => void; onDelete: () => void }) {
  const tracked = !!form.workflow?.enabled;
  const statuses = form.workflow?.statuses ?? [];
  const candidates = conditionCandidates(form);
  const workFields = (form.workflow?.workFields ?? []).filter((f) => isValueField(f));
  const triggers = (Object.keys(TRIGGER_LABEL) as AutomationTrigger[])
    .filter((t) => tracked || t === 'SUBMITTED' || t === flow.when)
    .map((t) => ({ label: TRIGGER_LABEL[t], value: t }));

  return (
    <div className="fb-settings" style={{ gap: 10 }}>
      <div className="fb-panel__title">Start</div>
      <TextSetting label="Automation name" value={flow.name} onChange={(name) => onChange({ name })} />
      <SwitchSetting label="On" checked={flow.enabled} onChange={(enabled) => onChange({ enabled })} />
      <SelectSetting<AutomationTrigger>
        label="Starts when"
        value={flow.when}
        options={triggers}
        hint={tracked ? undefined : 'Turn on "Track submissions as records" (Process tab) to start flows on status changes or overdue records.'}
        onChange={(when) => onChange({ when, toStatus: undefined, field: undefined, sla: undefined })}
      />
      {flow.when === 'SLA_BREACHED' && (
        <SelectSetting<'ANY' | 'STATUS' | 'RESPONSE' | 'RESOLUTION'>
          label="Which target"
          value={flow.sla ?? 'ANY'}
          options={[
            { label: 'Any missed target', value: 'ANY' },
            { label: 'First response', value: 'RESPONSE' },
            { label: 'Resolution', value: 'RESOLUTION' },
            { label: "A status's own time limit", value: 'STATUS' },
          ]}
          onChange={(v) => onChange({ sla: v === 'ANY' ? undefined : v })}
        />
      )}
      {flow.when === 'FIELD_UPDATED' && (
        <SelectSetting
          label="Which field"
          value={flow.field ?? ANY}
          options={[{ label: 'Any work field', value: ANY }, ...workFields.map((f) => ({ label: f.label || f.name, value: f.name }))]}
          hint="Test the new value with Only if… on Work: <field>."
          onChange={(v) => onChange({ field: v === ANY ? undefined : v })}
        />
      )}
      {flow.when === 'STATUS_CHANGED' && (
        <SelectSetting
          label="Into"
          value={flow.toStatus ?? ANY}
          options={[{ label: 'Any status', value: ANY }, ...statuses.map((s) => ({ label: s.label, value: s.key }))]}
          onChange={(v) => onChange({ toStatus: v === ANY ? undefined : v })}
        />
      )}
      <SwitchSetting label="Only if..." checked={!!flow.if} onChange={(on) => onChange({ if: on ? defaultCondition(candidates[0]) : undefined })} />
      {flow.if && <ConditionEditor condition={flow.if} candidates={candidates} onChange={(cond) => onChange({ if: cond })} />}
      <Button type="button" variant="outline" size="sm" onClick={onDelete} style={{ alignSelf: 'flex-start' }}>
        <Trash2 /> Delete this automation
      </Button>
    </div>
  );
}

export interface StepSettingsProps {
  form: FormDefinition;
  steps: AutomationAction[];
  index: number;
  people: Person[];
  customWorkflows: CustomWorkflow[];
  onChange: (step: AutomationAction) => void;
}

export function StepSettings({ form, steps, index, people, customWorkflows, onChange }: StepSettingsProps) {
  const step = steps[index];
  const key = stepKey(step, index);
  const candidates = [...conditionCandidates(form), ...outputPseudoFields(steps, index, customWorkflows)];
  const data = availableData(form, steps, index, customWorkflows);

  return (
    <div className="fb-settings" style={{ gap: 10 }}>
      <div className="fb-panel__title">
        Step {index + 1} · {ACTION_LABEL[step.type]}
      </div>
      <TextSetting label="Name on the diagram" value={step.label} placeholder={ACTION_LABEL[step.type]} onChange={(label) => onChange({ ...step, label: label || undefined })} />
      <Setting label="Step key" hint={`Later steps use this step's output as {{$steps.${key}.<field>}}.`}>
        {(id) => (
          <Input
            id={id}
            value={key}
            onChange={(e) => onChange({ ...step, id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').replace(/^[^a-z]+/, '').slice(0, 30) || undefined })}
          />
        )}
      </Setting>

      <ActionEditor form={form} action={step} people={people} customWorkflows={customWorkflows} onChange={onChange} />
      {step.type === 'GO_BACK' && (
        <>
          <SelectSetting
            label="Go back to"
            value={step.to || undefined}
            options={steps.slice(0, index).map((s, n) => ({ label: `${n + 1}. ${stepTitle(s)}`, value: stepKey(s, n) }))}
            hint={index === 0 ? 'There is no earlier step: move this one further down.' : 'The flow carries on from that step again. Give this step a condition below, so it only goes back when it should.'}
            onChange={(to) => onChange({ ...step, to })}
          />
          <Setting label="At most this many times" hint="After that the flow carries on with the next step, so it can never go round for ever (1 to 10).">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={10}
                value={step.times ?? 3}
                onChange={(e) => onChange({ ...step, times: Math.min(Math.max(Math.trunc(Number(e.target.value)) || 1, 1), 10) })}
              />
            )}
          </Setting>
        </>
      )}
      {canRunWithPrevious(steps, index) && (
        <SwitchSetting
          label="At the same time as the step before"
          checked={!!step.withPrevious}
          hint="Both start together and neither waits for the other, so this step cannot use what that one returns."
          onChange={(on) => onChange({ ...step, withPrevious: on || undefined })}
        />
      )}

      <SwitchSetting
        label="Run only if..."
        checked={!!step.if}
        hint="Otherwise the step is skipped and the flow goes on."
        onChange={(on) => onChange({ ...step, if: on ? defaultCondition(candidates[0]) : undefined })}
      />
      {step.if && <ConditionEditor condition={step.if} candidates={candidates} onChange={(cond) => onChange({ ...step, if: cond })} />}
      <SelectSetting<'stop' | 'continue'>
        label="If this step fails"
        value={step.continueOnError ? 'continue' : 'stop'}
        options={[
          { label: 'Stop the flow', value: 'stop' },
          { label: 'Continue with the next step', value: 'continue' },
        ]}
        onChange={(v) => onChange({ ...step, continueOnError: v === 'continue' || undefined })}
      />

      <details className="fb-flow__data">
        <summary>Data this step can use</summary>
        <DataList title="Answers" items={data.answers.map((a) => `${a.token} ${a.label}`)} />
        {data.record.length > 0 && <DataList title="Record" items={data.record.map((r) => `${r.token} ${r.label}`)} />}
        <DataList title="Form" items={['{{$form.name}} Form name']} />
        {data.steps.map((s) => (
          <DataList key={s.key} title={`From step "${s.name}" (${s.key})`} items={s.outputs.length ? s.outputs : ['(no declared outputs)']} />
        ))}
      </details>
    </div>
  );
}

function DataList({ title, items }: { title: string; items: string[] }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div className="fb-setting__label">{title}</div>
      <ul className="fb-flow__tokens">
        {items.map((t) => (
          <li key={t} className="fb-code">
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}
