import { Button } from '@ui/button';
import type { FormDefinition } from '../../types';
import { fieldLabel, matchWorkflowFields, refPrefixOf, resolveSharedWorkflow, workflowFieldChoices, type WorkflowRef } from '../../engine';
import type { LibraryWorkflow } from '../../adapters/shared-workflows';
import { ChoiceSelect, TextSetting } from '../components/settings';

interface SharedWorkflowPanelProps {
  form: FormDefinition;
  /** The library workflow the form uses; undefined when it has been removed from the library. */
  shared: LibraryWorkflow | undefined;
  readOnly: boolean;
  onChange: (changes: Partial<FormDefinition>) => void;
}

/**
 * A form that uses a workflow from the library: what the workflow does, and
 * which of this form's fields it reads. Fields with the same name are matched
 * already; only the others ask for a choice.
 */
export function SharedWorkflowPanel({ form, shared, readOnly, onChange }: SharedWorkflowPanelProps) {
  const ref = form.workflowRef as WorkflowRef;
  if (!shared) {
    return (
      <div className="fb-issues" role="alert">
        <div className="fb-issues__title">This workflow is no longer in the library</div>
        Choose another above, or give the form its own workflow.
      </div>
    );
  }

  const matches = matchWorkflowFields(shared, form.fields, ref.map);
  const missing = matches.filter((m) => !m.field);
  const wf = shared.workflow;
  const choose = (need: string, field: string) => {
    const map = { ...ref.map };
    // Only differences are kept: a field with the workflow's own name needs no entry.
    if (field === need) delete map[need];
    else map[need] = field;
    onChange({ workflowRef: { ...ref, map: Object.keys(map).length ? map : undefined } });
  };
  const copy = () => {
    const { definition } = resolveSharedWorkflow(form, shared);
    onChange({ workflow: definition.workflow, automations: definition.automations, workflowRef: undefined });
  };

  return (
    <div className="fb-settings" style={{ gap: 16 }}>
      {shared.description && <p className="fb-muted">{shared.description}</p>}
      <dl className="fb-summary">
        <dt>Statuses</dt>
        <dd>{wf.statuses.map((s) => s.label).join(' → ')}</dd>
        {!!wf.actions?.length && (
          <>
            <dt>Actions</dt>
            <dd>{wf.actions.map((a) => a.label).join(', ')}</dd>
          </>
        )}
        {!!shared.automations.length && (
          <>
            <dt>Automations</dt>
            <dd>{shared.automations.map((a) => a.name).join(', ')}</dd>
          </>
        )}
      </dl>

      {!!matches.length && (
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="fb-panel__title">Answers it reads from this form</div>
          <p className="fb-muted">{missing.length ? 'Choose which of this form\'s fields each one is.' : 'All matched. Change one only if a different field should be used.'}</p>
          <div className="fb-match">
            {matches.map(({ need, field, by }) => {
              const options = workflowFieldChoices(form.fields, need).map((f) => ({ label: fieldLabel(f), value: f.name }));
              return (
                <div key={need.name} className="fb-match__row">
                  <span className="fb-match__need">{need.label}</span>
                  <ChoiceSelect ariaLabel={need.label} value={field?.name} options={options} onChange={(v) => choose(need.name, v)} placeholder={options.length ? 'Choose a field' : 'No field of this kind on the form'} disabled={!options.length} />
                  <span className={field ? 'fb-muted' : 'fb-match__missing'}>{field ? (by === 'name' ? 'Matched by name' : 'Chosen') : 'Needed before publishing'}</span>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}

      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <TextSetting
          label="Reference prefix"
          value={ref.refPrefix}
          placeholder={refPrefixOf({ code: form.code })}
          hint={`This form's records are numbered ${ref.refPrefix || refPrefixOf({ code: form.code })}-000001, -000002, ...`}
          onChange={(v) => onChange({ workflowRef: { ...ref, refPrefix: v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) || undefined } })}
        />
      </fieldset>

      <p className="fb-muted">
        The workflow is kept in the library and shared with other forms. Changes made to it there reach this form the next time the form is published.
      </p>
      {!readOnly && (
        <div>
          <Button type="button" variant="outline" disabled={missing.length > 0} onClick={copy} title={missing.length ? 'Match the answers first' : undefined}>
            Copy into this form to change it
          </Button>
          <span className="fb-muted" style={{ marginLeft: 10 }}>
            The form gets its own copy and stops following the library.
          </span>
        </div>
      )}
    </div>
  );
}
