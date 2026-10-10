import { useState } from 'react';
import { WorkflowMap } from './WorkflowMap';
import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/tabs';
import type { FormDefinition } from '../../types';
import type { CustomWorkflow, Person } from '../../adapters/workflow';
import { ProcessEditor } from './ProcessEditor';
import { FlowEditor } from './FlowEditor';
import { RecordAccessEditor } from './RecordAccessEditor';
import { WorkFieldsEditor } from './WorkFieldsEditor';
import { SlaEditor } from './SlaEditor';
import { EmailTemplatesEditor } from './EmailTemplatesEditor';

const LOCK = { border: 0, padding: 0, margin: 0, minWidth: 0 } as const;

interface WorkflowTabsProps {
  /** The form the workflow belongs to; for a library workflow, a stand-in with the answers it reads. */
  form: FormDefinition;
  people: Person[];
  customWorkflows: CustomWorkflow[];
  /** Status keys already published - records may carry them, so they never change. */
  publishedKeys: ReadonlySet<string>;
  readOnly: boolean;
  /** Editing a library workflow: what belongs to each form (its team, its record numbers) is left out. */
  shared?: boolean;
  /** A tab shown before the others. */
  first?: { value: string; label: string; content: ReactNode };
  /** The tab to open on, when it should not be the first one. */
  startOn?: string;
  onChange: (changes: Partial<FormDefinition>) => void;
}

/** The workflow editors, the same for a form's own workflow and for one in the library. */
export function WorkflowTabs({ form, people, customWorkflows, publishedKeys, readOnly, shared = false, first, startOn, onChange }: WorkflowTabsProps) {
  // With a team, records (and approvals) can only go to its members.
  const access = form.recordAccess;
  // With a workflow to look at, the picture comes first: what it is, before the tabs where each part is changed.
  // With none yet, Process comes first, since that is where tracking is switched on.
  const [tab, setTab] = useState(startOn ?? first?.value ?? (form.workflow?.enabled ? 'map' : 'process'));
  const [openAutomation, setOpenAutomation] = useState<number>();
  const teamPeople = access ? people.filter((p) => access.userIds.includes(p.uuid) || (!!p.department && access.departments.includes(p.department))) : people;
  return (
    // Tabs stay usable read-only; only the editors inside are locked.
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        {first && <TabsTrigger value={first.value}>{first.label}</TabsTrigger>}
        <TabsTrigger value="map">Picture</TabsTrigger>
        <TabsTrigger value="process">Process</TabsTrigger>
        <TabsTrigger value="sla">SLA</TabsTrigger>
        <TabsTrigger value="emails">Emails{form.workflow?.emailTemplates?.length ? ` (${form.workflow.emailTemplates.length})` : ''}</TabsTrigger>
        <TabsTrigger value="work-fields">Work fields{form.workflow?.workFields?.length ? ` (${form.workflow.workFields.length})` : ''}</TabsTrigger>
        <TabsTrigger value="automations">Automations{form.automations?.length ? ` (${form.automations.length})` : ''}</TabsTrigger>
      </TabsList>
      {first && (
        <TabsContent value={first.value}>
          <fieldset disabled={readOnly} style={LOCK}>
            {first.content}
          </fieldset>
        </TabsContent>
      )}
      <TabsContent value="map">
        {/* On a draft the picture is where the workflow is built; on a published form it only shows, and clicking leads to the tab. */}
        <WorkflowMap
          form={form}
          edit={readOnly ? undefined : { people: teamPeople, customWorkflows, publishedKeys, onChange }}
          onOpen={(to, automation) => {
            if (automation !== undefined) setOpenAutomation(automation);
            setTab(to);
          }}
        />
      </TabsContent>
      <TabsContent value="process">
        <fieldset disabled={readOnly} style={LOCK}>
          <div className="fb-settings" style={{ gap: 20 }}>
            <ProcessEditor form={form} people={teamPeople} publishedKeys={publishedKeys} shared={shared} onChange={(workflow) => onChange({ workflow })} />
            {!shared && <RecordAccessEditor form={form} people={people} onChange={(recordAccess) => onChange({ recordAccess })} />}
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
          <FlowEditor key={openAutomation ?? 'first'} startAt={openAutomation} form={form} people={teamPeople} customWorkflows={customWorkflows} onChange={(automations) => onChange({ automations })} />
        </fieldset>
      </TabsContent>
    </Tabs>
  );
}
