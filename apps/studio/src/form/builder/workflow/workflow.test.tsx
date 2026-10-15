import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition, WorkflowConfig } from '../../types';
import { fixtureDefinitions } from '../../fixtures';
import { WorkflowDialog } from './WorkflowDialog';
import { renameStatus, removeStatus, statusKeyFrom, STARTER_WORKFLOW, toggleMove, setRestricted } from './workflow-edits';

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

const basic = fixtureDefinitions.find((d) => d.code === 'CUSTOMER_COMPLAINT_BASIC')!;

import { describeMoves, workflowMoves } from './workflow-map';
import { branchEnd, branchOf, decisionIf, flowBlocks } from './workflow-edits';

describe('workflow edits', () => {
  it('status keys follow the name until a published version uses them', () => {
    expect(statusKeyFrom('Waiting for customer!')).toBe('WAITING_FOR_CUSTOMER');
    expect(statusKeyFrom('1st review')).toBe('ST_REVIEW');
    const wf = setRestricted(STARTER_WORKFLOW, true);
    const renamed = renameStatus(wf, 1, 'Investigating', new Set());
    expect(renamed.statuses[1]).toMatchObject({ key: 'INVESTIGATING', label: 'Investigating' });
    expect(renamed.transitions?.NEW).toContain('INVESTIGATING');
    expect(renameStatus(wf, 1, 'Investigating', new Set(['IN_PROGRESS'])).statuses[1].key).toBe('IN_PROGRESS');
  });

  it('removing a status cleans up allowed moves; moves keep the status order', () => {
    const wf = setRestricted(STARTER_WORKFLOW, true);
    expect(removeStatus(wf, 1).transitions).toEqual({ NEW: ['CLOSED'], CLOSED: ['NEW'] });
    const narrowed = toggleMove(toggleMove(wf, 'NEW', 'IN_PROGRESS', false), 'NEW', 'IN_PROGRESS', true);
    expect(narrowed.transitions?.NEW).toEqual(['IN_PROGRESS', 'CLOSED']);
  });
});

function Harness({ initial, readOnly = false, spy }: { initial: FormDefinition; readOnly?: boolean; spy: (f: FormDefinition) => void }) {
  const [form, setForm] = useState(initial);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <WorkflowDialog
        form={form}
        versions={[]}
        readOnly={readOnly}
        open
        onOpenChange={() => {}}
        onChange={(changes) =>
          setForm((f) => {
            const next = { ...f, ...changes };
            spy(next);
            return next;
          })
        }
      />
    </QueryClientProvider>
  );
}

describe('Workflow dialog', () => {
  it('switching tracking on starts from New / In progress / Closed', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={basic} spy={spy} />);
    await user.click(screen.getByRole('switch', { name: 'Track submissions as records' }));
    const wf = spy.mock.lastCall![0].workflow as WorkflowConfig;
    expect(wf.statuses.map((s) => s.key)).toEqual(['NEW', 'IN_PROGRESS', 'CLOSED']);
    expect(screen.getByRole('textbox', { name: 'Reference prefix' })).toHaveAttribute('placeholder', 'CCB');
  });

  it('flow: add steps with + between nodes, top to bottom, and pick a custom API', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={basic} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    await user.click(screen.getByRole('button', { name: /New automation/ }));

    await user.click(screen.getByRole('button', { name: 'Add a step at the start' }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Run a custom API/ }));
    await user.click(screen.getByRole('combobox', { name: 'Custom API' }));
    await user.click(await screen.findByRole('option', { name: 'Example: log the submission' }));

    // Insert an email after it; it sees the custom API's declared outputs.
    await user.click(screen.getByRole('button', { name: 'Add a step after step 1' }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Send an email/ }));
    expect(screen.getByText('{{$steps.api.loggedAt}}')).toBeInTheDocument();

    const flow = spy.mock.lastCall![0].automations[0];
    expect(flow.actions.map((a: { id: string; type: string }) => [a.id, a.type])).toEqual([
      ['api', 'HANDLER'],
      ['email', 'EMAIL'],
    ]);
    expect(flow.actions[0]).toMatchObject({ key: 'example-log-submission' });
    const diagram = screen.getByLabelText('Automation 1 flow');
    expect(within(diagram).getByText('1. Run a custom API')).toBeInTheDocument();
    expect(within(diagram).getByText('2. Send an email')).toBeInTheDocument();

    // Reorder and "continue on error".
    await user.click(screen.getByRole('button', { name: 'Move step 2 up' }));
    expect(spy.mock.lastCall![0].automations[0].actions.map((a: { id: string }) => a.id)).toEqual(['email', 'api']);
  });

  it('approval step: later steps branch on its decision (Approved / Rejected)', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={{ ...basic, automations: [{ id: 'a', name: 'A', enabled: true, when: 'SUBMITTED', actions: [] }] }} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    await user.click(screen.getByRole('button', { name: 'Add a step at the start' }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Wait for approval/ }));
    await user.click(screen.getByRole('button', { name: 'Add a step after step 1' }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Send an email/ }));
    await user.click(screen.getByRole('switch', { name: 'Run only if...' }));
    await user.click(screen.getByRole('combobox', { name: 'When field' }));
    await user.click(await screen.findByRole('option', { name: 'Wait for approval → decision' }));
    await user.click(screen.getByRole('combobox', { name: 'Value' }));
    await user.click(await screen.findByRole('option', { name: 'Rejected' }));
    const steps = spy.mock.lastCall![0].automations[0].actions;
    expect(steps[0]).toMatchObject({ id: 'approval', type: 'APPROVAL', dueInHours: 48 });
    expect(steps[1].if).toEqual({ field: '$steps.approval.decision', operator: 'equals', value: 'REJECTED' });
  });

  it('signature step: starts with the form\'s email field as signer; later steps branch on how it ended', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={{ ...basic, automations: [{ id: 'a', name: 'A', enabled: true, when: 'SUBMITTED', actions: [] }] }} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    await user.click(screen.getByRole('button', { name: 'Add a step at the start' }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Send for signature/ }));
    await user.click(screen.getByRole('combobox', { name: 'When there are several signers' }));
    await user.click(await screen.findByRole('option', { name: 'All at once' }));
    await user.click(screen.getByRole('button', { name: 'Add a step after step 1' }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Send an email/ }));
    await user.click(screen.getByRole('switch', { name: 'Run only if...' }));
    await user.click(screen.getByRole('combobox', { name: 'When field' }));
    await user.click(await screen.findByRole('option', { name: 'Send for signature → status' }));
    await user.click(screen.getByRole('combobox', { name: 'Value' }));
    await user.click(await screen.findByRole('option', { name: 'Declined' }));
    const steps = spy.mock.lastCall![0].automations[0].actions;
    expect(steps[0]).toMatchObject({ id: 'sign', type: 'SIGN', order: 'PARALLEL', expiresInDays: 14 });
    expect(steps[0].to).toEqual([{ kind: 'FIELD', field: expect.any(String) }]);
    expect(steps[0].title).toContain(basic.name);
    expect(steps[1].if).toEqual({ field: '$steps.sign.status', operator: 'equals', value: 'DECLINED' });
  });

  it('automation tool step: pick the tool, paste the flow\'s address; a wrong one is said at once and the address never shows in the diagram', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={{ ...basic, automations: [{ id: 'a', name: 'A', enabled: true, when: 'SUBMITTED', actions: [] }] }} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    await user.click(screen.getByRole('button', { name: 'Add a step at the start' }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Send to an automation tool/ }));
    // Starts on Power Automate, with where to find the address.
    expect(screen.getByText(/When an HTTP request is received/)).toBeInTheDocument();
    const box = screen.getByLabelText("The flow's address");
    await user.click(box);
    await user.paste('https://hooks.zapier.com/hooks/catch/1/abc/');
    expect(screen.getByText(/That is not a Power Automate address/)).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Which tool' }));
    await user.click(await screen.findByRole('option', { name: 'Zapier' }));
    expect(screen.queryByText(/That is not a/)).toBeNull();
    expect(spy.mock.lastCall![0].automations[0].actions[0]).toEqual({ id: 'flow', type: 'FLOW', service: 'ZAPIER', url: 'https://hooks.zapier.com/hooks/catch/1/abc/' });
    const diagram = screen.getByLabelText('A flow');
    expect(within(diagram).getByText('To Zapier')).toBeInTheDocument();
    expect(within(diagram).queryByText(/hooks\/catch/)).toBeNull();
  });

  it('a step that writes to another system shows which answer fills each field, matched by name, and lets one be changed', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={{ ...basic, automations: [{ id: 'a', name: 'A', enabled: true, when: 'SUBMITTED', actions: [] }] }} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    await user.click(screen.getByRole('button', { name: 'Add a step at the start' }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Run a custom API/ }));
    await user.click(screen.getByRole('combobox', { name: 'Custom API' }));
    await user.click(await screen.findByRole('option', { name: 'Example CRM: insert Leads' }));

    const fields = screen.getByRole('group', { name: 'What goes into each field' });
    // The form has "email", "description" and "phone": matched to Email, Description and Phone with nobody choosing.
    expect(within(fields).getByRole('combobox', { name: 'Email' })).toHaveTextContent(/\(matched by name\)/);
    expect(within(fields).getByRole('combobox', { name: 'Phone' })).toHaveTextContent(/\(matched by name\)/);
    // Nothing in the form is called LastName.
    expect(within(fields).getByRole('combobox', { name: 'LastName' })).toHaveTextContent('Nothing matches: left empty');
    // Matches are not stored: they keep working if a field is renamed to something that still matches.
    expect(spy.mock.lastCall![0].automations[0].actions[0].map).toBeUndefined();

    await user.click(within(fields).getByRole('combobox', { name: 'LastName' }));
    await user.click(await screen.findByRole('option', { name: basic.fields.find((f) => f.name === 'name')!.label! }));
    expect(spy.mock.lastCall![0].automations[0].actions[0]).toMatchObject({ type: 'HANDLER', key: 'c-example1-0a1b2c3d', map: { LastName: 'name' } });

    await user.click(within(fields).getByRole('combobox', { name: 'Phone' }));
    await user.click(await screen.findByRole('option', { name: 'Leave empty' }));
    expect(spy.mock.lastCall![0].automations[0].actions[0].map).toEqual({ LastName: 'name', Phone: '' });
    // Choosing the match again forgets the choice.
    await user.click(within(fields).getByRole('combobox', { name: 'Phone' }));
    await user.click(await screen.findByRole('option', { name: /\(matched by name\)/ }));
    expect(spy.mock.lastCall![0].automations[0].actions[0].map).toEqual({ LastName: 'name' });
  });

  it('who works the records: switch to a team of people and departments', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={basic} spy={spy} />);
    await user.click(screen.getByRole('combobox', { name: 'Records of this form are for' }));
    await user.click(await screen.findByRole('option', { name: /A team/ }));
    await user.type(screen.getByRole('combobox', { name: 'Departments' }), 'Quality{Enter}');
    expect(spy.mock.lastCall![0].recordAccess).toEqual({ mode: 'TEAM', userIds: [], departments: ['Quality'] });
    await user.click(screen.getByRole('button', { name: 'Remove Quality' }));
    expect(spy.mock.lastCall![0].recordAccess.departments).toEqual([]);
  });

  it('work fields, actions and priority rules (WM-1)', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Harness initial={{ ...basic, workflow: STARTER_WORKFLOW }} spy={spy} />);

    await user.click(screen.getByRole('tab', { name: /Work fields/ }));
    await user.click(screen.getByRole('button', { name: /Add resolution section/ }));
    await user.click(within(screen.getByRole('group', { name: 'Add a work field' })).getByRole('button', { name: /Yes \/ no/ }));
    let wf = spy.mock.lastCall![0].workflow;
    expect(wf.workFields.map((f: { name: string; type: string }) => [f.name, f.type])).toEqual([
      ['rootCause', 'TEXTAREA'],
      ['correctiveAction', 'TEXTAREA'],
      ['preventiveAction', 'TEXTAREA'],
      ['resolutionSummary', 'TEXTAREA'],
      ['checkboxField', 'CHECKBOX'],
    ]);

    await user.click(screen.getByRole('tab', { name: 'Process' }));
    await user.click(screen.getByRole('button', { name: /Add action/ }));
    const action = screen.getByLabelText('Action New action');
    await user.clear(within(action).getByRole('textbox', { name: 'Button label' }));
    await user.type(within(action).getByRole('textbox', { name: 'Button label' }), 'Resolve');
    await user.click(within(action).getByRole('checkbox', { name: 'Root cause' }));
    await user.click(within(action).getByRole('switch', { name: 'Ask for a comment' }));
    wf = spy.mock.lastCall![0].workflow;
    expect(wf.actions).toEqual([{ key: 'resolve', label: 'Resolve', to: 'CLOSED', requireFields: ['rootCause'], requireComment: true }]);

    // Evidence before the move: two pictures, only for some records.
    await user.click(within(action).getByRole('switch', { name: 'A file must be added first' }));
    expect(spy.mock.lastCall![0].workflow.actions[0].requireFiles).toEqual({});
    await user.click(within(action).getByRole('combobox', { name: 'How many' }));
    await user.click(await screen.findByRole('option', { name: '2' }));
    await user.click(within(action).getByRole('switch', { name: 'Pictures only' }));
    await user.click(within(action).getByRole('switch', { name: 'Only when… (files)' }));
    expect(spy.mock.lastCall![0].workflow.actions[0].requireFiles).toMatchObject({ count: 2, picturesOnly: true, if: { field: expect.any(String) } });
    await user.click(within(action).getByRole('switch', { name: 'A file must be added first' }));
    expect(spy.mock.lastCall![0].workflow.actions[0].requireFiles).toBeUndefined();

    await user.click(screen.getByRole('button', { name: /Add priority rule/ }));
    expect(spy.mock.lastCall![0].workflow.priority).toMatchObject({ default: 'MEDIUM', rules: [{ priority: 'HIGH' }] });

    // A flow can start when a work field changes, and test $work / $priority.
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    await user.click(screen.getByRole('button', { name: /New automation/ }));
    await user.click(screen.getByRole('combobox', { name: 'Starts when' }));
    await user.click(await screen.findByRole('option', { name: 'A work field changes' }));
    await user.click(screen.getByRole('combobox', { name: 'Which field' }));
    await user.click(await screen.findByRole('option', { name: 'Root cause' }));
    expect(spy.mock.lastCall![0].automations[0]).toMatchObject({ when: 'FIELD_UPDATED', field: 'rootCause' });
    await user.click(screen.getByRole('switch', { name: 'Only if...' }));
    await user.click(screen.getByRole('combobox', { name: 'When field' }));
    expect(await screen.findByRole('option', { name: 'Priority' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Work: Root cause' })).toBeInTheDocument();
  });

  it('an approval says who must approve, how long they have, and what happens when nobody answers', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const wf = { ...STARTER_WORKFLOW, actions: [{ key: 'resolve', label: 'Resolve', to: 'CLOSED', approval: { to: [{ kind: 'MANAGER' as const }] } }] };
    render(<Harness initial={{ ...basic, workflow: wf }} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: 'Process' }));
    const action = screen.getByLabelText('Action Resolve');
    const approval = () => spy.mock.lastCall![0].workflow.actions[0].approval;

    // Nothing is asked about lateness until there is a time to be late for.
    expect(within(action).queryByRole('combobox', { name: 'If nobody answers in time' })).not.toBeInTheDocument();
    await user.click(within(action).getByRole('combobox', { name: 'Who must approve' }));
    await user.click(await screen.findByRole('option', { name: 'Every one of them' }));
    expect(approval()).toMatchObject({ need: 'ALL' });
    expect(within(action).getByText(/One rejection refuses it/)).toBeInTheDocument();

    await user.type(within(action).getByRole('spinbutton', { name: 'Time to answer (hours)' }), '8');
    expect(approval()).toMatchObject({ dueInHours: 8 });
    await user.click(within(action).getByRole('combobox', { name: 'If nobody answers in time' }));
    await user.click(await screen.findByRole('option', { name: 'Ask their manager instead' }));
    expect(approval()).toEqual({ to: [{ kind: 'MANAGER' }], need: 'ALL', dueInHours: 8, whenLate: 'MANAGER' });

    // Taking the time away takes its consequence away too.
    await user.clear(within(action).getByRole('spinbutton', { name: 'Time to answer (hours)' }));
    expect(approval().whenLate).toBeUndefined();
  });

  it('SLA targets, escalation, approval on an action and email templates (WM-2/3)', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const wf = { ...STARTER_WORKFLOW, actions: [{ key: 'resolve', label: 'Resolve', to: 'CLOSED' }] };
    render(<Harness initial={{ ...basic, workflow: wf }} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: 'Process' }));

    const action = screen.getByLabelText('Action Resolve');
    await user.click(within(action).getByRole('switch', { name: 'Needs approval' }));
    expect(spy.mock.lastCall![0].workflow.actions[0].approval).toEqual({ to: [{ kind: 'MANAGER' }] });
    expect(within(action).getByText("The assignee's manager")).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Closed items can be reopened' }));
    expect(spy.mock.lastCall![0].workflow.reopen).toEqual({ to: 'NEW', withinDays: 30 });

    await user.click(screen.getByRole('tab', { name: 'SLA' }));
    await user.type(screen.getByRole('spinbutton', { name: 'Default resolution hours' }), '24');
    await user.type(screen.getByRole('spinbutton', { name: 'Critical resolution hours' }), '4');
    await user.click(screen.getByRole('checkbox', { name: 'In progress' }));
    await user.click(screen.getByRole('button', { name: /Add escalation level/ }));
    let sla = spy.mock.lastCall![0].workflow;
    expect(sla.sla).toEqual({ resolutionHours: 24, byPriority: { CRITICAL: { resolutionHours: 4 } }, pauseIn: ['IN_PROGRESS'] });
    expect(sla.escalation).toEqual({ levels: [{ afterHours: 0, notify: [{ kind: 'MANAGER' }] }] });
    await user.click(screen.getByRole('combobox', { name: 'Count time' }));
    await user.click(await screen.findByRole('option', { name: /Working hours only/ }));
    expect(spy.mock.lastCall![0].workflow.sla.calendar).toBe('WORKING');

    await user.click(screen.getByRole('tab', { name: /Emails/ }));
    await user.click(screen.getByRole('button', { name: /Add email template/ }));
    sla = spy.mock.lastCall![0].workflow;
    expect(sla.emailTemplates).toEqual([{ key: 'template_1', name: 'Request information', subject: 'About your request {{$record.ref}}', body: 'Hello,\n\nCould you send us ...' }]);
    const tpl = screen.getByLabelText('Template Request information');
    await user.clear(within(tpl).getByRole('textbox', { name: 'Template name' }));
    await user.type(within(tpl).getByRole('textbox', { name: 'Template name' }), 'Ask for lot');
    expect(spy.mock.lastCall![0].workflow.emailTemplates[0]).toMatchObject({ key: 'ask_for_lot', name: 'Ask for lot' });
  });

  it('status-based steps only appear once the form tracks records', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...basic, automations: [{ id: 'a', name: 'A', enabled: true, when: 'SUBMITTED', actions: [] }] }} spy={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    await user.click(screen.getByRole('button', { name: 'Add a step at the start' }));
    const picker = screen.getByRole('group', { name: 'Choose a step' });
    expect(within(picker).queryByRole('button', { name: /Change the status/ })).not.toBeInTheDocument();
    expect(within(picker).getByRole('button', { name: /Send an email/ })).toBeInTheDocument();
  });

  it('the picture: statuses in order, an arrow for every button, approvals and rejections marked, and each automation as a row', async () => {
    const user = userEvent.setup();
    const wf = {
      ...STARTER_WORKFLOW,
      actions: [
        { key: 'start', label: 'Start', from: ['NEW'], to: 'IN_PROGRESS' },
        { key: 'resolve', label: 'Resolve', from: ['IN_PROGRESS'], to: 'CLOSED', approval: { to: [{ kind: 'MANAGER' as const }], onReject: 'NEW' } },
      ],
    };
    const automations = [
      { id: 'a1', name: 'Tell the customer', enabled: true, when: 'STATUS_CHANGED' as const, toStatus: 'CLOSED', actions: [{ id: 'e', type: 'EMAIL' as const, to: [], subject: 's', body: 'b' }, { id: 'n', type: 'NOTIFY' as const, to: [], message: 'm', if: { field: 'email', operator: 'equals' as const, value: 'x' } }] },
      { id: 'a2', name: 'Old one', enabled: false, when: 'SUBMITTED' as const, actions: [] },
    ];
    // A published form: the picture only shows, and clicking a part leads to the tab it is on.
    render(<Harness readOnly initial={{ ...basic, workflow: wf, automations }} spy={vi.fn()} />);

    // It is the first thing shown, and it says in words what it draws.
    const words = within(screen.getByRole('list', { name: 'The process in words' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(words).toEqual(['Start: New to In progress', 'Resolve: In progress to Closed, once approved (if rejected: New)']);
    const picture = screen.getByRole('img', { name: /The process: New, then In progress, then Closed/ });
    expect(picture.querySelectorAll('.fb-map__status')).toHaveLength(3);
    // Two buttons and one way back for a rejection.
    expect(picture.querySelectorAll('.fb-map__move')).toHaveLength(3);
    expect(picture.querySelectorAll('.fb-map__move--dashed')).toHaveLength(1);
    expect(picture.textContent).toContain('Resolve ✓');
    expect(picture.textContent).toContain('starts here');

    const lanes = screen.getByRole('group', { name: 'What happens by itself' });
    const first = within(lanes).getByRole('button', { name: 'Open the automation Tell the customer' });
    expect(first.textContent).toContain('When the status becomes Closed');
    expect(first.textContent).toContain('Send an email');
    expect(first.textContent).toContain('only if…');
    expect(within(lanes).getByRole('button', { name: 'Open the automation Old one' }).textContent).toContain('Off');

    // Clicking a row opens that automation where it is edited.
    await user.click(within(lanes).getByRole('button', { name: 'Open the automation Old one' }));
    expect(screen.getByRole('tab', { name: /Automations/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Old one/ })).toHaveAttribute('aria-selected', 'true');
    // And a status opens the process.
    await user.click(screen.getByRole('tab', { name: 'Picture' }));
    await user.click(screen.getByRole('button', { name: 'Change the process' }));
    expect(screen.getByRole('tab', { name: 'Process' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the picture: a button usable from many statuses is one arrow "from any status"; with no buttons it says moves are free', () => {
    const many = { ...STARTER_WORKFLOW, statuses: [...STARTER_WORKFLOW.statuses, { key: 'HOLD', label: 'On hold', category: 'OPEN' as const }, { key: 'LEGAL', label: 'With legal', category: 'OPEN' as const }], actions: [{ key: 'cancel', label: 'Cancel', to: 'CLOSED' }] };
    expect(workflowMoves(many).moves[0]).toMatchObject({ any: true, to: 'CLOSED' });
    expect(describeMoves(many)).toEqual(['Cancel: any other status to Closed']);
    const first = render(<Harness readOnly initial={{ ...basic, workflow: many }} spy={vi.fn()} />);
    expect(screen.getByRole('img', { name: /The process/ }).textContent).toContain('Cancel (from any status)');
    first.unmount();
    expect(describeMoves(STARTER_WORKFLOW)).toEqual(['Staff can move a record to any status.']);
  });

  it('an approval\'s outcomes are drawn as two branches, and a step added to a branch runs only that way', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const steps = [
      { id: 'ask', type: 'APPROVAL' as const, to: [{ kind: 'MANAGER' as const }], title: 'Refund?' },
      { id: 'yes', type: 'NOTIFY' as const, to: [], message: 'Approved', if: decisionIf('ask', 'APPROVED') },
      { id: 'no', type: 'NOTIFY' as const, to: [], message: 'Rejected', if: decisionIf('ask', 'REJECTED') },
      { id: 'after', type: 'NOTIFY' as const, to: [], message: 'Either way' },
    ];
    // In the list they are one after another; in the picture the two conditional ones sit under the approval.
    expect(flowBlocks(steps)).toEqual([{ index: 0, branches: { APPROVED: [1], REJECTED: [2] } }, { index: 3 }]);
    expect(branchEnd(steps, 0)).toBe(3);
    expect(branchOf(steps[1]!)).toEqual({ approvalKey: 'ask', decision: 'APPROVED' });
    expect(branchOf(steps[3]!)).toBeUndefined();

    render(<Harness initial={{ ...basic, workflow: STARTER_WORKFLOW, automations: [{ id: 'a', name: 'Refunds', enabled: true, when: 'SUBMITTED', actions: steps }] }} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    const approved = screen.getByRole('group', { name: 'If approved, after step 1' });
    const rejected = screen.getByRole('group', { name: 'If rejected, after step 1' });
    expect(within(approved).getByText(/^2\. /)).toBeInTheDocument();
    expect(within(rejected).getByText(/^3\. /)).toBeInTheDocument();
    expect(within(approved).queryByText(/^4\. /)).not.toBeInTheDocument();

    // A step added on the rejected side goes after the steps already on the branches, and carries its condition.
    await user.click(within(rejected).getByRole('button', { name: /Add a step when rejected/ }));
    await user.click(within(within(rejected).getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Send an email/ }));
    const made = spy.mock.lastCall![0].automations[0].actions;
    expect(made.map((a: { id: string }) => a.id).slice(0, 3)).toEqual(['ask', 'yes', 'no']);
    expect(made[3]).toMatchObject({ type: 'EMAIL', if: { field: '$steps.ask.decision', operator: 'equals', value: 'REJECTED' } });
    expect(made[4].id).toBe('after');
    expect(within(screen.getByRole('group', { name: 'If rejected, after step 1' })).getByText(/^4\. /)).toBeInTheDocument();
  });

  it('an approval step can ask others at the same time, each with their own people and their own question', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const steps = [{ id: 'ask', type: 'APPROVAL' as const, to: [{ kind: 'MANAGER' as const }], title: 'Legal' }];
    render(<Harness initial={{ ...basic, workflow: STARTER_WORKFLOW, automations: [{ id: 'a', name: 'Sign-off', enabled: true, when: 'SUBMITTED', actions: steps }] }} spy={spy} />);
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    await user.click(screen.getByRole('button', { name: /^1\. / }));
    await user.click(screen.getByRole('button', { name: '+ Add an approval asked at the same time' }));
    const part = screen.getByRole('group', { name: 'Approval 2 at the same time' });
    await user.type(within(part).getByRole('textbox', { name: 'What to approve' }), 'Finance');
    const step = () => spy.mock.lastCall![0].automations[0].actions[0];
    expect(step().together).toEqual([{ to: [], title: 'Finance' }]);
    // The step's box says so, so the flow reads right at a glance.
    expect(screen.getByRole('button', { name: /^1\. / })).toHaveTextContent('and 1 more at the same time');
    await user.click(within(part).getByRole('button', { name: 'Remove this approval' }));
    expect(step().together).toBeUndefined();
  });

  it('read-only: tabs work, editors are locked', async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...basic, workflow: STARTER_WORKFLOW }} readOnly spy={vi.fn()} />);
    // It opens on the picture, which can be looked at and clicked through even when nothing can be changed.
    expect(screen.getByRole('group', { name: 'The process' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Process' }));
    expect(screen.getByRole('switch', { name: 'Track submissions as records' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: /Automations/ }));
    expect(screen.getByRole('button', { name: /New automation/ })).toBeDisabled();
  });
});
