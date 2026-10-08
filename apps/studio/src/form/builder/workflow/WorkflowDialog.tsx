import { useMemo } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/tabs';
import type { FormDefinition } from '../../types';
import { useCustomWorkflows, usePeople } from '../../adapters/workflow';
import { ProcessEditor } from './ProcessEditor';
import { FlowEditor } from './FlowEditor';
import { RecordAccessEditor } from './RecordAccessEditor';
import { WorkFieldsEditor } from './WorkFieldsEditor';
import { SlaEditor } from './SlaEditor';
import { EmailTemplatesEditor } from './EmailTemplatesEditor';

const LOCK = { border: 0, padding: 0, margin: 0, minWidth: 0 } as const;

interface WorkflowDialogProps {
  form: FormDefinition;
  /** Other versions of this form (status keys they published must keep their meaning). */
  versions: FormDefinition[];
  readOnly: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (changes: Partial<FormDefinition>) => void;
}

/**
 * What happens after a form is submitted: an optional record workflow
 * (statuses, owner, SLA) and automations - configured steps, or a custom API
 * a developer wrote for needs beyond them. Edits go into the draft like any
 * other form setting, and are checked when it's published.
 */
export function WorkflowDialog({ form, versions, readOnly, open, onOpenChange, onChange }: WorkflowDialogProps) {
  const { data: people = [] } = usePeople(open);
  const { data: customWorkflows = [] } = useCustomWorkflows(open);
  // With a team, records (and approvals) can only go to its members.
  const access = form.recordAccess;
  const teamPeople = useMemo(
    () => (access ? people.filter((p) => access.userIds.includes(p.uuid) || (!!p.department && access.departments.includes(p.department))) : people),
    [people, access],
  );
  const publishedKeys = useMemo(
    () => new Set(versions.filter((v) => v.code === form.code && v.id !== form.id && v.status !== 'DRAFT').flatMap((v) => v.workflow?.statuses.map((s) => s.key) ?? [])),
    [versions, form.code, form.id],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="large" style={{ width: 'min(1180px, calc(100vw - 2rem))', maxWidth: 'none', maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>Workflow</DialogTitle>
          <DialogDescription>
            What happens after someone submits {form.name}. Changes are saved with the draft and take effect when it's published.
          </DialogDescription>
        </DialogHeader>
        {/* Tabs stay usable read-only; only the editors inside are locked. */}
        <Tabs defaultValue="process">
          <TabsList>
            <TabsTrigger value="process">Process</TabsTrigger>
            <TabsTrigger value="sla">SLA</TabsTrigger>
            <TabsTrigger value="emails">Emails{form.workflow?.emailTemplates?.length ? ` (${form.workflow.emailTemplates.length})` : ''}</TabsTrigger>
            <TabsTrigger value="work-fields">Work fields{form.workflow?.workFields?.length ? ` (${form.workflow.workFields.length})` : ''}</TabsTrigger>
            <TabsTrigger value="automations">Automations{form.automations?.length ? ` (${form.automations.length})` : ''}</TabsTrigger>
          </TabsList>
          <TabsContent value="process">
            <fieldset disabled={readOnly} style={LOCK}>
              <div className="fb-settings" style={{ gap: 20 }}>
                <ProcessEditor form={form} people={teamPeople} publishedKeys={publishedKeys} onChange={(workflow) => onChange({ workflow })} />
                <RecordAccessEditor form={form} people={people} onChange={(recordAccess) => onChange({ recordAccess })} />
              </div>
            </fieldset>
          </TabsContent>
          <TabsContent value="sla">
            <fieldset disabled={readOnly} style={LOCK}>
              <SlaEditor form={form} people={teamPeople} onChange={(workflow) => onChange({ workflow })} />
            </fieldset>
          </TabsContent>
          <TabsContent value="emails">
            <fieldset disabled={readOnly} style={LOCK}>
              <EmailTemplatesEditor form={form} onChange={(workflow) => onChange({ workflow })} />
            </fieldset>
          </TabsContent>
          <TabsContent value="work-fields">
            <fieldset disabled={readOnly} style={LOCK}>
              <WorkFieldsEditor form={form} readOnly={readOnly} onChange={(workflow) => onChange({ workflow })} />
            </fieldset>
          </TabsContent>
          <TabsContent value="automations">
            <fieldset disabled={readOnly} style={LOCK}>
              <FlowEditor form={form} people={teamPeople} customWorkflows={customWorkflows} onChange={(automations) => onChange({ automations })} />
            </fieldset>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
