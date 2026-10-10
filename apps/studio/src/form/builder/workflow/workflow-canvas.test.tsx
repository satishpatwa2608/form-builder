import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition, WorkflowConfig } from '../../types';
import { fixtureDefinitions } from '../../fixtures';
import { WorkflowMap } from './WorkflowMap';
import { connectStatuses, disconnectStatuses, removeStatus, renameStatus, setRestricted, STARTER_WORKFLOW } from './workflow-edits';

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

/** The picture on a draft: what it changes is kept, as the builder keeps it. */
function Canvas({ initial, spy, published = new Set<string>() }: { initial: FormDefinition; spy: (f: FormDefinition) => void; published?: Set<string> }) {
  const [form, setForm] = useState(initial);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <WorkflowMap
        form={form}
        onOpen={() => {}}
        edit={{
          people: [],
          customWorkflows: [],
          publishedKeys: published,
          onChange: (changes) =>
            setForm((f) => {
              const next = { ...f, ...changes };
              spy(next);
              return next;
            }),
        }}
      />
    </QueryClientProvider>
  );
}

const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.lastCall![0] as FormDefinition;

describe('joining statuses', () => {
  it('the first arrow on a free workflow makes a button; another from elsewhere to the same place widens it', () => {
    const one = connectStatuses(STARTER_WORKFLOW, 'NEW', 'IN_PROGRESS');
    expect(one.action).toBe(0);
    expect(one.wf.actions).toEqual([{ key: 'move_to_in_progress', label: 'Move to In progress', from: ['NEW'], to: 'IN_PROGRESS' }]);
    const two = connectStatuses(one.wf, 'CLOSED', 'IN_PROGRESS');
    expect(two.action).toBe(0);
    expect(two.wf.actions![0]!.from).toEqual(['NEW', 'CLOSED']);
    // Drawn twice, it is still one arrow; onto itself, nothing.
    expect(connectStatuses(two.wf, 'NEW', 'IN_PROGRESS').wf).toBe(two.wf);
    expect(connectStatuses(two.wf, 'NEW', 'NEW').wf).toBe(two.wf);
  });

  it('a workflow that lists its allowed moves gets a tick, not a button', () => {
    const listed = { ...setRestricted(STARTER_WORKFLOW, true), transitions: { NEW: [], IN_PROGRESS: [], CLOSED: [] } };
    const made = connectStatuses(listed, 'NEW', 'CLOSED');
    expect(made.action).toBeUndefined();
    expect(made.wf.transitions!.NEW).toEqual(['CLOSED']);
    expect(made.wf.actions).toBeUndefined();
  });

  it('taking an arrow away narrows the button, and the last one removes it', () => {
    const wf = connectStatuses(connectStatuses(STARTER_WORKFLOW, 'NEW', 'CLOSED').wf, 'IN_PROGRESS', 'CLOSED').wf;
    const narrowed = disconnectStatuses(wf, 0, 'NEW');
    expect(narrowed.actions![0]!.from).toEqual(['IN_PROGRESS']);
    expect(disconnectStatuses(narrowed, 0, 'IN_PROGRESS').actions).toBeUndefined();
    // A button shown everywhere, taken off one status, is then shown in the others by name.
    const everywhere: WorkflowConfig = { ...STARTER_WORKFLOW, actions: [{ key: 'cancel', label: 'Cancel', to: 'CLOSED' }] };
    expect(disconnectStatuses(everywhere, 0, 'NEW').actions![0]!.from).toEqual(['IN_PROGRESS']);
  });

  it('renaming or removing a status keeps buttons, reopening and "request information" pointing at the right place', () => {
    const wf: WorkflowConfig = {
      ...STARTER_WORKFLOW,
      actions: [
        { key: 'start', label: 'Start', from: ['NEW'], to: 'IN_PROGRESS' },
        { key: 'resolve', label: 'Resolve', from: ['IN_PROGRESS'], to: 'CLOSED', approval: { to: [{ kind: 'MANAGER' }], onReject: 'IN_PROGRESS' } },
        { key: 'cancel', label: 'Cancel', from: ['NEW', 'IN_PROGRESS'], to: 'CLOSED' },
      ],
      reopen: { to: 'IN_PROGRESS', withinDays: 30 },
      requestInfoStatus: 'IN_PROGRESS',
    };
    const renamed = renameStatus(wf, 1, 'Assessing', new Set());
    expect(renamed.actions!.map((a) => [a.from, a.to, a.approval?.onReject])).toEqual([[['NEW'], 'ASSESSING', undefined], [['ASSESSING'], 'CLOSED', 'ASSESSING'], [['NEW', 'ASSESSING'], 'CLOSED', undefined]]);
    expect(renamed.reopen!.to).toBe('ASSESSING');
    expect(renamed.requestInfoStatus).toBe('ASSESSING');

    const removed = removeStatus(wf, 1);
    // The button that led there, and the one that could only be pressed there, go; the third is pressed where it still can be.
    expect(removed.actions).toEqual([{ key: 'cancel', label: 'Cancel', from: ['NEW'], to: 'CLOSED' }]);
    expect(removed.reopen).toBeUndefined();
    expect(removed.requestInfoStatus).toBeUndefined();
  });
});

describe('the picture as the place a workflow is built', () => {
  it('starts tracking from the picture, then adds a status and names it there', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Canvas initial={basic} spy={spy} />);
    await user.click(screen.getByRole('button', { name: 'Start tracking responses' }));
    expect(last(spy).workflow!.statuses.map((s) => s.label)).toEqual(['New', 'In progress', 'Closed']);

    await user.click(screen.getByRole('button', { name: 'Add a status' }));
    // What was added is selected, and its settings are beside the picture.
    const panel = screen.getByRole('complementary', { name: 'Status' });
    const name = within(panel).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'With the customer');
    const statuses = last(spy).workflow!.statuses;
    // Before the status that closes a record, with a key that followed the name.
    expect(statuses.map((s) => [s.key, s.label])).toEqual([['NEW', 'New'], ['IN_PROGRESS', 'In progress'], ['WITH_THE_CUSTOMER', 'With the customer'], ['CLOSED', 'Closed']]);
    expect(screen.getByRole('button', { name: 'Status With the customer' })).toHaveAttribute('aria-pressed', 'true');

    await user.type(within(panel).getByRole('spinbutton', { name: 'Hours allowed here' }), '48');
    expect(last(spy).workflow!.statuses[2]!.slaHours).toBe(48);
    await user.click(within(panel).getByRole('button', { name: /Earlier/ }));
    expect(last(spy).workflow!.statuses.map((s) => s.label)).toEqual(['New', 'With the customer', 'In progress', 'Closed']);
  });

  it('adds a move from the panel, names its button there, and takes the arrow away again', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Canvas initial={{ ...basic, workflow: STARTER_WORKFLOW }} spy={spy} />);
    await user.click(screen.getByRole('button', { name: 'Status New' }));
    const status = screen.getByRole('complementary', { name: 'Status' });
    expect(within(status).getByText('None yet.')).toBeInTheDocument();
    await user.click(within(status).getByRole('combobox', { name: 'Add a move to' }));
    await user.click(await screen.findByRole('option', { name: 'In progress' }));

    // The move that was made is open, ready to be named.
    const move = screen.getByRole('complementary', { name: 'Move' });
    const label = within(move).getByRole('textbox', { name: 'Button label' });
    await user.clear(label);
    await user.type(label, 'Start work');
    expect(last(spy).workflow!.actions).toEqual([{ key: 'start_work', label: 'Start work', from: ['NEW'], to: 'IN_PROGRESS' }]);
    // It is drawn, and can be selected from the drawing.
    const arrow = screen.getByRole('button', { name: 'Move Start work: New to In progress' });
    expect(arrow).toHaveAttribute('aria-pressed', 'true');
    expect(within(screen.getByRole('list', { name: 'The process in words' })).getByRole('listitem').textContent).toBe('Start work: New to In progress');

    await user.click(within(move).getByRole('switch', { name: 'Needs approval' }));
    expect(last(spy).workflow!.actions![0]!.approval).toEqual({ to: [{ kind: 'MANAGER' }] });

    await user.click(screen.getByRole('button', { name: 'Status New' }));
    await user.click(within(screen.getByRole('complementary', { name: 'Status' })).getByRole('button', { name: /Start work → In progress/ }));
    await user.click(within(screen.getByRole('complementary', { name: 'Move' })).getByRole('button', { name: 'Remove this arrow' }));
    expect(last(spy).workflow!.actions).toBeUndefined();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('a status a published version uses cannot be deleted; another can, and its arrows go with it', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    const wf = connectStatuses(STARTER_WORKFLOW, 'NEW', 'IN_PROGRESS').wf;
    render(<Canvas initial={{ ...basic, workflow: wf }} spy={spy} published={new Set(['NEW'])} />);
    await user.click(screen.getByRole('button', { name: 'Status New' }));
    expect(within(screen.getByRole('complementary', { name: 'Status' })).getByRole('button', { name: 'Delete this status' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Status In progress' }));
    await user.click(within(screen.getByRole('complementary', { name: 'Status' })).getByRole('button', { name: 'Delete this status' }));
    expect(last(spy).workflow!.statuses.map((s) => s.key)).toEqual(['NEW', 'CLOSED']);
    expect(last(spy).workflow!.actions).toBeUndefined();
  });

  it('adds an automation and its steps on the picture, and changes a step beside it', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    render(<Canvas initial={{ ...basic, workflow: STARTER_WORKFLOW }} spy={spy} />);
    await user.click(screen.getByRole('button', { name: 'Add an automation' }));
    expect(screen.getByRole('complementary', { name: 'When it starts' })).toBeInTheDocument();
    const lane = screen.getByRole('group', { name: /^Automation / });
    await user.click(within(lane).getByRole('button', { name: /^Add a step to/ }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Send an email/ }));
    await user.click(within(lane).getByRole('button', { name: /^Add a step to/ }));
    await user.click(within(screen.getByRole('group', { name: 'Choose a step' })).getByRole('button', { name: /Change the status/ }));
    expect(last(spy).automations![0]!.actions.map((a) => a.type)).toEqual(['EMAIL', 'SET_STATUS']);

    // The step just added is the one open; move it first, then delete the other.
    const panel = screen.getByRole('complementary', { name: 'Step 2' });
    await user.click(within(panel).getByRole('button', { name: /Earlier/ }));
    expect(last(spy).automations![0]!.actions.map((a) => a.type)).toEqual(['SET_STATUS', 'EMAIL']);
    await user.click(within(lane).getByRole('button', { name: /step 2: Send an email/ }));
    await user.click(within(screen.getByRole('complementary', { name: 'Step 2' })).getByRole('button', { name: 'Delete this step' }));
    expect(last(spy).automations![0]!.actions.map((a) => a.type)).toEqual(['SET_STATUS']);
  });
});
