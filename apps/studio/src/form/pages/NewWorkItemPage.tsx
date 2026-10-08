import { useMemo, useState } from 'react';
import { Button } from '@ui/button';
import type { FormDefinition } from '../types';
import { useFormDefinitions } from '../adapters/registry/useFormRegistry';
import { portalSubmissionAdapter, recordsAvailable } from '../adapters/workflow';
import { FormContainer } from '../runtime/FormContainer/FormContainer';
import { useUserSystemContext } from '../launch/useUserSystemContext';
import { ChoiceSelect } from '../builder/components/settings';
import '../styles/form-builder.css';

interface NewWorkItemPageProps {
  onOpen: (id: string) => void;
}

/**
 * Raise a work item from the portal: pick a form that tracks records (often a
 * sign-in-only internal one, e.g. "Machine breakdown"), fill it in, done.
 * Same validation and process as a public submission; no CAPTCHA.
 */
export default function NewWorkItemPage({ onOpen }: NewWorkItemPageProps) {
  const { data: forms = [], isLoading } = useFormDefinitions();
  const [code, setCode] = useState<string>();
  const [created, setCreated] = useState<{ id: string; ref: string } | null>(null);
  const context = useUserSystemContext('APP');

  // Latest published version of every form with a workflow.
  const choices = useMemo(() => {
    const latest = new Map<string, FormDefinition>();
    for (const f of forms) {
      if (f.status === 'PUBLISHED' && f.workflow?.enabled && (latest.get(f.code)?.version ?? 0) < f.version) latest.set(f.code, f);
    }
    return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [forms]);
  const chosen = choices.find((f) => f.code === code);
  // The portal is trusted (signed in): no CAPTCHA widget to solve.
  const definition = useMemo(
    () => (chosen ? { ...chosen, captcha: undefined, fields: chosen.fields.filter((f) => f.type !== 'CAPTCHA') } : undefined),
    [chosen],
  );

  return (
    <div className="p-6 space-y-6" style={{ maxWidth: 860 }}>
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900">New work item</h1>
        <p className="text-sm text-muted-foreground">Raise an item on any form that tracks records. It follows that form's process.</p>
      </div>

      {!recordsAvailable ? (
        <p className="fb-muted">Work items are kept by the server. This app is running on local storage only.</p>
      ) : created ? (
        <div role="status" className="fb-panel fb-settings" style={{ gap: 10 }}>
          <strong>Created {created.ref || 'the work item'}.</strong>
          <div className="flex items-center gap-2">
            <Button type="button" onClick={() => onOpen(created.id)}>
              Open it
            </Button>
            <Button type="button" variant="outline" onClick={() => setCreated(null)}>
              Raise another
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ maxWidth: 420 }}>
            <ChoiceSelect
              ariaLabel="Type of work item"
              placeholder={isLoading ? 'Loading…' : choices.length ? 'Choose what to raise…' : 'No forms track records yet'}
              value={code}
              options={choices.map((f) => ({ label: f.name, value: f.code }))}
              onChange={setCode}
            />
          </div>
          {definition && (
            <FormContainer
              key={definition.id}
              definition={definition}
              systemContext={context}
              submissionAdapter={portalSubmissionAdapter}
              onSubmitted={(r) => r.submissionId && setCreated({ id: r.submissionId, ref: r.ref ?? '' })}
            />
          )}
        </>
      )}
    </div>
  );
}
