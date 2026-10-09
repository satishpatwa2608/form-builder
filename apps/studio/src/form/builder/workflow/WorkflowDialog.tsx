import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import type { FormDefinition } from '../../types';
import { describeWorkflowFields } from '../../engine';
import { messageOf } from '../../adapters/backend';
import { useSaveSharedWorkflow, useSharedWorkflows } from '../../adapters/shared-workflows';
import { useCustomWorkflows, usePeople } from '../../adapters/workflow';
import { SelectSetting, TextSetting } from '../components/settings';
import { RecordAccessEditor } from './RecordAccessEditor';
import { SharedWorkflowPanel } from './SharedWorkflowPanel';
import { WorkflowTabs } from './WorkflowTabs';

const OWN = '__own__';

interface WorkflowDialogProps {
  form: FormDefinition;
  /** Other versions of this form (status keys they published must keep their meaning). */
  versions: FormDefinition[];
  readOnly: boolean;
  /** May add this form's workflow to the organisation's library. */
  canManageLibrary?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (changes: Partial<FormDefinition>) => void;
}

/**
 * What happens after a form is submitted: an optional record workflow
 * (statuses, owner, SLA) and automations - configured steps, or a custom API
 * a developer wrote for needs beyond them. The form either has its own, or
 * uses one from the organisation's library that other forms share. Edits go
 * into the draft like any other form setting, and are checked when it's published.
 */
export function WorkflowDialog({ form, versions, readOnly, canManageLibrary = false, open, onOpenChange, onChange }: WorkflowDialogProps) {
  const { data: people = [] } = usePeople(open);
  const { data: customWorkflows = [] } = useCustomWorkflows(open);
  const { data: library = [], isSuccess: libraryLoaded } = useSharedWorkflows(open);
  const saveToLibrary = useSaveSharedWorkflow();
  const [libraryName, setLibraryName] = useState<string | null>(null);
  const publishedKeys = useMemo(
    () => new Set(versions.filter((v) => v.code === form.code && v.id !== form.id && v.status !== 'DRAFT').flatMap((v) => v.workflow?.statuses.map((s) => s.key) ?? [])),
    [versions, form.code, form.id],
  );
  const ref = form.workflowRef;
  const shared = ref ? library.find((w) => w.id === ref.id) : undefined;
  const sources = [{ label: "This form's own workflow", value: OWN }, ...library.map((w) => ({ label: w.name, value: w.id }))];
  // Kept even when a removed workflow is still named, so the designer can choose again.
  const showSource = library.length > 0 || !!ref;

  const share = async () => {
    if (!form.workflow) return;
    try {
      // Record numbers stay with each form, so the prefix is not part of what is shared.
      const { refPrefix, ...workflow } = form.workflow;
      const saved = await saveToLibrary.mutateAsync({ name: (libraryName ?? '').trim(), workflow, automations: form.automations ?? [], fields: describeWorkflowFields(form) });
      onChange({ workflowRef: { id: saved.id, ...(refPrefix ? { refPrefix } : {}) } });
      setLibraryName(null);
      toast.success(`"${saved.name}" is in the library. This form now uses it from there.`);
    } catch (e) {
      toast.error(messageOf(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="large" style={{ width: 'min(1180px, calc(100vw - 2rem))', maxWidth: 'none', maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>Workflow</DialogTitle>
          <DialogDescription>
            What happens after someone submits {form.name}. Changes are saved with the draft and take effect when it's published.
          </DialogDescription>
        </DialogHeader>

        {(showSource || canManageLibrary) && (
          <div className="fb-source">
            {showSource && (
              <div style={{ flex: '1 1 320px', maxWidth: 460 }}>
                <SelectSetting
                  label="Workflow for this form"
                  value={ref ? ref.id : OWN}
                  options={ref && libraryLoaded && !shared ? [...sources, { label: 'Removed from the library', value: ref.id }] : sources}
                  disabled={readOnly}
                  hint="Use a workflow from the library to run several forms through the same process."
                  onChange={(v) => onChange({ workflowRef: v === OWN ? undefined : { id: v } })}
                />
              </div>
            )}
            {!ref && canManageLibrary && !readOnly && form.workflow?.enabled && libraryName === null && (
              <Button type="button" variant="outline" onClick={() => setLibraryName(`${form.name} workflow`)}>
                Save to library
              </Button>
            )}
          </div>
        )}
        {libraryName !== null && (
          <div className="fb-source fb-source--box">
            <div style={{ flex: '1 1 320px', maxWidth: 460 }}>
              <TextSetting label="Name in the library" value={libraryName} onChange={setLibraryName} hint="Other forms will be able to use this workflow. This form will use it from the library too." />
            </div>
            <Button type="button" disabled={!libraryName.trim() || saveToLibrary.isPending} onClick={() => void share()}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setLibraryName(null)}>
              Cancel
            </Button>
          </div>
        )}

        {ref ? (
          <div className="fb-settings" style={{ gap: 20 }}>
            {(libraryLoaded || shared) && <SharedWorkflowPanel form={form} shared={shared} readOnly={readOnly} onChange={onChange} />}
            <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <RecordAccessEditor form={form} people={people} onChange={(recordAccess) => onChange({ recordAccess })} />
            </fieldset>
          </div>
        ) : (
          <WorkflowTabs form={form} people={people} customWorkflows={customWorkflows} publishedKeys={publishedKeys} readOnly={readOnly} onChange={onChange} />
        )}
      </DialogContent>
    </Dialog>
  );
}
