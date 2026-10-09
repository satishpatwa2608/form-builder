import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition, FormField } from '../../types';
import { seedLocalWorkflows, type LibraryWorkflow } from '../../adapters/shared-workflows';
import { publishIssues } from '../publish-issues';
import WorkflowsPage from '../../pages/WorkflowsPage';
import { answerName } from './LibraryWorkflowDialog';
import { WorkflowDialog } from './WorkflowDialog';

const admin = { value: true };
vi.mock('../../../lib/auth', () => ({ useAuth: () => ({ me: { user: { id: 'u1', name: 'Asha', email: 'a@x.test' } }, can: () => admin.value }) }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const levels = [
  { label: 'Minor', value: 'LOW' },
  { label: 'Serious', value: 'HIGH' },
];
const handling = (): LibraryWorkflow => ({
  id: 'wf1',
  name: 'Complaint handling',
  description: 'New, investigation, closed.',
  workflow: {
    enabled: true,
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'INVESTIGATION', label: 'Investigation', category: 'IN_PROGRESS' },
      { key: 'CLOSED', label: 'Closed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
    priority: { default: 'MEDIUM', rules: [{ if: { field: 'severity', operator: 'equals', value: 'HIGH' }, priority: 'HIGH' }] },
    actions: [{ key: 'accept', label: 'Accept', from: ['NEW'], to: 'INVESTIGATION' }],
    contactEmailField: 'email',
  },
  automations: [{ id: 'a1', name: 'Acknowledge', enabled: true, when: 'SUBMITTED', actions: [{ id: 's1', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'Received', body: 'Thank you.' }] }],
  fields: [
    { name: 'severity', label: 'Severity', type: 'RADIO', options: levels },
    { name: 'email', label: "Requester's email", type: 'EMAIL' },
  ],
  usedBy: [],
});

const fields = (email: string, severity: string): FormField[] => [
  { id: 'a', type: 'TEXT', name: 'fullName', label: 'Full name' },
  { id: 'b', type: 'EMAIL', name: email, label: 'Contact email' },
  { id: 'c', type: 'EMAIL', name: 'managerEmail', label: "Manager's email" },
  { id: 'd', type: 'RADIO', name: severity, label: 'How bad is it', dataSource: { type: 'STATIC', options: levels } },
];
const form = (over: Partial<FormDefinition> = {}): FormDefinition => ({
  id: 'f1',
  orgId: 'o1',
  businessId: '',
  name: 'Return request',
  code: 'RETURN_REQUEST',
  version: 1,
  status: 'DRAFT',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: fields('contactEmail', 'urgency'),
  createdBy: 'u1',
  updatedBy: 'u1',
  ...over,
});

function Harness({ initial, spy, canManageLibrary = false }: { initial: FormDefinition; spy: (f: FormDefinition) => void; canManageLibrary?: boolean }) {
  const [current, setCurrent] = useState(initial);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <WorkflowDialog
        form={current}
        versions={[]}
        readOnly={false}
        canManageLibrary={canManageLibrary}
        open
        onOpenChange={() => {}}
        onChange={(changes) =>
          setCurrent((f) => {
            const next = { ...f, ...changes };
            spy(next);
            return next;
          })
        }
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  seedLocalWorkflows([handling()]);
  admin.value = true;
});

describe('A form that uses a shared workflow', () => {
  it('with nothing in the library, the dialog is as it always was', async () => {
    seedLocalWorkflows([]);
    render(<Harness initial={form()} spy={vi.fn()} />);
    expect(await screen.findByRole('switch', { name: 'Track submissions as records' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Workflow for this form' })).not.toBeInTheDocument();
  });

  it('choosing one asks only for the fields whose names differ, by picking from a list', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={form()} spy={spy} />);
    await user.click(await screen.findByRole('combobox', { name: 'Workflow for this form' }));
    await user.click(await screen.findByRole('option', { name: 'Complaint handling' }));
    expect(spy.mock.lastCall![0].workflowRef).toEqual({ id: 'wf1' });
    expect(screen.getByText('New → Investigation → Closed')).toBeInTheDocument();
    expect(screen.getAllByText('Needed before publishing')).toHaveLength(2);
    // The editors of the form's own workflow are gone; the team that sees its records stays.
    expect(screen.queryByRole('tab', { name: 'Process' })).not.toBeInTheDocument();

    // Only email fields are offered for an email.
    await user.click(screen.getByRole('combobox', { name: "Requester's email" }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Contact email', "Manager's email"]);
    await user.click(screen.getByRole('option', { name: 'Contact email' }));
    await user.click(screen.getByRole('combobox', { name: 'Severity' }));
    await user.click(await screen.findByRole('option', { name: 'How bad is it' }));
    expect(spy.mock.lastCall![0].workflowRef).toEqual({ id: 'wf1', map: { email: 'contactEmail', severity: 'urgency' } });
    expect(screen.queryByText('Needed before publishing')).not.toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Reference prefix' }), 'ret');
    expect(spy.mock.lastCall![0].workflowRef.refPrefix).toBe('RET');
  });

  it('fields with the same names are matched without asking', async () => {
    render(<Harness initial={form({ fields: fields('email', 'severity'), workflowRef: { id: 'wf1' } })} spy={vi.fn()} />);
    expect(await screen.findAllByText('Matched by name')).toHaveLength(2);
    expect(screen.getByText(/All matched/)).toBeInTheDocument();
  });

  it('can be copied into the form to change it there, in the form\'s own field names', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={form({ workflowRef: { id: 'wf1', map: { email: 'contactEmail', severity: 'urgency' } } })} spy={spy} />);
    await user.click(await screen.findByRole('button', { name: 'Copy into this form to change it' }));
    const next = spy.mock.lastCall![0] as FormDefinition;
    expect(next.workflowRef).toBeUndefined();
    expect(next.workflow?.contactEmailField).toBe('contactEmail');
    expect(next.workflow?.priority?.rules?.[0].if).toMatchObject({ field: 'urgency' });
    expect(screen.getByRole('tab', { name: 'Process' })).toBeInTheDocument();
  });

  it('says so when the workflow has been removed from the library', async () => {
    render(<Harness initial={form({ workflowRef: { id: 'gone' } })} spy={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This workflow is no longer in the library');
  });

  it('an admin saves a form\'s own workflow to the library in one step; the form then uses it from there', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const own = handling();
    seedLocalWorkflows([]);
    const start = form({ fields: fields('email', 'severity'), workflow: { ...own.workflow, refPrefix: 'RET' }, automations: own.automations });
    const { unmount } = render(<Harness initial={start} spy={spy} />);
    expect(screen.queryByRole('button', { name: 'Save to library' })).not.toBeInTheDocument();
    unmount();

    render(<Harness initial={start} spy={spy} canManageLibrary />);
    await user.click(await screen.findByRole('button', { name: 'Save to library' }));
    const name = screen.getByRole('textbox', { name: 'Name in the library' });
    expect(name).toHaveValue('Return request workflow');
    await user.clear(name);
    await user.type(name, 'Returns');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('New → Investigation → Closed')).toBeInTheDocument();
    expect(spy.mock.lastCall![0].workflowRef).toEqual({ id: 'wf_1', refPrefix: 'RET' });
    expect(await screen.findAllByText('Matched by name')).toHaveLength(2);
  });
});

describe('Publish checks with a shared workflow', () => {
  const library = [handling()];
  it('lists the answers still to be matched, in words', () => {
    expect(publishIssues(form({ workflowRef: { id: 'wf1' } }), library).map((i) => i.message)).toEqual([
      '"Complaint handling" needs "Severity". Choose which of this form\'s fields that is.',
      '"Complaint handling" needs "Requester\'s email". Choose which of this form\'s fields that is.',
    ]);
    expect(publishIssues(form({ workflowRef: { id: 'wf1', map: { email: 'contactEmail', severity: 'urgency' } } }), library)).toEqual([]);
  });
  it('a removed workflow is one clear problem; the form\'s unused own workflow raises none', () => {
    expect(publishIssues(form({ workflowRef: { id: 'gone' } }), library)).toEqual([expect.objectContaining({ fieldLabel: 'Workflow', message: expect.stringContaining('no longer in the library') })]);
    const broken = { enabled: true, statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' as const }] };
    expect(publishIssues(form({ workflow: broken })).length).toBeGreaterThan(0);
    expect(publishIssues(form({ fields: fields('email', 'severity'), workflow: broken, workflowRef: { id: 'wf1' } }), library)).toEqual([]);
    // Before the library has loaded nothing is claimed either way.
    expect(publishIssues(form({ workflow: broken, workflowRef: { id: 'wf1' } }))).toEqual([]);
  });
});

describe('The workflow library', () => {
  const page = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WorkflowsPage />
      </QueryClientProvider>,
    );

  it('names an answer after what it is called', () => {
    expect(answerName("Requester's email", new Set())).toBe('requestersEmail');
    expect(answerName('Email', new Set(['email']))).toBe('email2');
    expect(answerName('2nd approver', new Set())).toBe('ndApprover');
    expect(answerName('', new Set())).toBe('answer');
  });

  it('an admin builds a workflow: name, the answers it reads, then the usual editors', async () => {
    const user = userEvent.setup();
    seedLocalWorkflows([]);
    page();
    expect(await screen.findByText(/No shared workflows yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New workflow' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save workflow' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Give the workflow a name');

    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Leave approval');
    await user.click(within(dialog).getByRole('button', { name: 'Add an answer' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Answer 1' }), 'Employee email');
    expect(within(dialog).getByText('Matches a form field named employeeEmail')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('combobox', { name: 'Kind of answer 1' }));
    await user.click(await screen.findByRole('option', { name: 'Email address' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add an answer' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Answer 2' }), 'Leave type');
    await user.click(within(dialog).getByRole('combobox', { name: 'Kind of answer 2' }));
    await user.click(await screen.findByRole('option', { name: 'One choice from a list' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Choices of answer 2' }), 'Sick, Annual');

    // The editors are the form's own, offering exactly these answers; record numbers belong to each form.
    await user.click(within(dialog).getByRole('tab', { name: 'Process' }));
    expect(within(dialog).getByRole('switch', { name: 'Track submissions as records' })).toBeChecked();
    expect(within(dialog).queryByRole('textbox', { name: 'Reference prefix' })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Save workflow' }));
    const row = (await screen.findByText('Leave approval')).closest('tr')!;
    expect(row).toHaveTextContent('New → In progress → Closed');
    expect(row).toHaveTextContent('Employee email, Leave type');
    expect(row).toHaveTextContent('No form yet');
  });

  it('a workflow in use says which forms use it and is not deleted; an unused one is', async () => {
    const user = userEvent.setup();
    seedLocalWorkflows([
      { ...handling(), usedBy: [{ formId: 'f1', code: 'COMPLAINT', name: 'Complaint', version: 2, status: 'PUBLISHED' }] },
      { ...handling(), id: 'wf2', name: 'Spare' },
    ]);
    page();
    expect((await screen.findByText('Complaint handling')).closest('tr')).toHaveTextContent('Complaint');
    await user.click(screen.getByRole('button', { name: 'Delete Complaint handling' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete Spare' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Complaint handling')).toBeInTheDocument();
    expect(screen.queryByText('Spare')).not.toBeInTheDocument();
  });

  it('someone who is not an admin can look but not change', async () => {
    const user = userEvent.setup();
    admin.value = false;
    page();
    await user.click(await screen.findByRole('button', { name: 'View Complaint handling' }));
    expect(screen.queryByRole('button', { name: 'New workflow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete Complaint handling' })).not.toBeInTheDocument();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Save workflow' })).not.toBeInTheDocument();
  });
});
