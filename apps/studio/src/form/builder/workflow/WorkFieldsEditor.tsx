import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/button';
import type { FormDefinition, FormField, WorkflowConfig } from '../../types';
import { FieldConfigPanel } from '../components/FieldConfigPanel';
import { newWorkField, resolutionPreset, WORK_FIELD_TYPES } from './workflow-edits';

interface WorkFieldsEditorProps {
  form: FormDefinition;
  readOnly: boolean;
  onChange: (wf: WorkflowConfig) => void;
}

/**
 * Internal fields the team fills while working an item (investigation, root
 * cause, resolution...). Same field settings as the form itself; stored apart
 * from the submitted answers, which never change.
 */
export function WorkFieldsEditor({ form, readOnly, onChange }: WorkFieldsEditorProps) {
  const wf = form.workflow;
  const [selected, setSelected] = useState<string>();
  if (!wf?.enabled) {
    return <p className="fb-muted">Turn on "Track submissions as records" (Process tab) to add work fields.</p>;
  }
  const fields = wf.workFields ?? [];
  const set = (list: FormField[]) => onChange({ ...wf, workFields: list.length ? list : undefined });
  const add = (list: FormField[]) => {
    set([...fields, ...list]);
    if (list[0]) setSelected(list[0].id);
  };
  const move = (i: number, d: -1 | 1) => {
    const next = [...fields];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set(next);
  };
  const field = fields.find((f) => f.id === selected);
  // The config panel works on a "form" whose fields are the work fields (names must be unique among them).
  const workForm: FormDefinition = { ...form, fields };

  return (
    <div className="fb-flow-layout">
      <div className="fb-settings" style={{ gap: 10 }}>
        <p className="fb-muted">
          Filled in the Inbox while working the item and saved as you go. Actions can require them (e.g. "Resolve" needs the root cause).
          Automations can use them as <span className="fb-code">{'{{$work.<key>}}'}</span>.
        </p>
        {fields.length === 0 && <p className="fb-muted">No work fields yet.</p>}
        {fields.map((f, i) => (
          <div key={f.id} className={`fb-flow__node${f.id === selected ? ' fb-flow__node--selected' : ''}`} style={{ maxWidth: 'none' }}>
            <button type="button" className="fb-flow__select" onClick={() => setSelected(f.id)}>
              <span className="fb-flow__text">
                <span className="fb-flow__title">{f.label || f.name}</span>
                <span className="fb-flow__summary">
                  {WORK_FIELD_TYPES.find((t) => t.type === f.type)?.label ?? f.type} · <span className="fb-code">{f.name}</span>
                </span>
              </span>
            </button>
            {!readOnly && (
              <span className="fb-flow__tools">
                <button type="button" className="fb-icon-btn" aria-label={`Move ${f.label} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={14} />
                </button>
                <button type="button" className="fb-icon-btn" aria-label={`Move ${f.label} down`} disabled={i === fields.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={14} />
                </button>
                <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label={`Delete ${f.label}`} onClick={() => set(fields.filter((x) => x.id !== f.id))}>
                  <Trash2 size={14} />
                </button>
              </span>
            )}
          </div>
        ))}
        {!readOnly && (
          <>
            <div className="fb-flow__picker" role="group" aria-label="Add a work field" style={{ maxWidth: 'none', borderStyle: 'solid' }}>
              {WORK_FIELD_TYPES.map((t) => (
                <button key={t.type} type="button" className="fb-flow__pick" onClick={() => add([newWorkField(t.type, fields)])}>
                  <Plus size={14} /> {t.label}
                </button>
              ))}
            </div>
            <Button type="button" variant="outline" size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => add(resolutionPreset(fields))}>
              <Plus /> Add resolution section (root cause, corrective, preventive, summary)
            </Button>
          </>
        )}
      </div>
      <aside className="fb-flow-inspector fb-panel" aria-label="Work field settings">
        {field ? (
          <FieldConfigPanel
            field={field}
            form={workForm}
            readOnly={readOnly}
            onChange={(changes) => set(fields.map((f) => (f.id === field.id ? { ...f, ...changes } : f)))}
            onFormChange={() => {}}
            onSetColumns={() => {}}
          />
        ) : (
          <p className="fb-muted">Select a field to edit its label, key, options and rules.</p>
        )}
      </aside>
    </div>
  );
}
