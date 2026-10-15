import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormDefinition } from '../types';
import { fixtureDefinitions } from '../fixtures';
import RecordsInboxPage from './RecordsInboxPage';

const form: FormDefinition = {
  ...fixtureDefinitions.find((d) => d.code === 'CUSTOMER_COMPLAINT_BASIC')!,
  id: 'form-v1',
  status: 'PUBLISHED',
  workflow: {
    enabled: true,
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN', slaHours: 24 },
      { key: 'WIP', label: 'Investigating', category: 'IN_PROGRESS' },
      { key: 'DONE', label: 'Resolved', category: 'DONE' },
    ],
    workFields: [
      { id: 'w1', type: 'TEXTAREA', name: 'rootCause', label: 'Root cause' },
      { id: 'w2', type: 'NUMBER', name: 'cost', label: 'Cost' },
    ],
  },
};

const record = {
  uuid: 'r1',
  ref: 'CCB-000001',
  formId: 'form-v1',
  formCode: form.code,
  formVersion: 1,
  status: 'NEW',
  priority: 'HIGH',
  source: 'PORTAL',
  work: { rootCause: 'Old lot' },
  assigneeId: 'u1',
  dueAt: '2000-01-01T00:00:00.000Z',
  slaBreachedAt: null,
  submittedBy: '',
  channel: 'WEB',
  payload: { name: 'Asha Rao', email: 'asha@x.test', category: 'DELIVERY' },
  createdAt: '2026-09-29T10:00:00.000Z',
};

const auth = vi.hoisted(() => ({ modules: ['FormPlatformAdminModule'] as string[] }));
vi.mock('../../lib/auth', () => ({
  // This product's auth: org-level permissions from the role (admins can do everything).
  useAuth: () => {
    const admin = auth.modules.some((m) => m === 'All' || m === 'FormPlatformAdminModule');
    const worker = admin || auth.modules.includes('FormPlatformRecordsModule');
    const perms = admin ? ['record.admin', 'record.work', 'org.manage', 'form.view', 'form.edit', 'form.publish'] : worker ? ['record.work'] : [];
    return { me: { user: { id: 'u1', name: 'Asha Rao', email: 'a@x.test' }, org: { id: 'o1', name: 'Acme', role: 'ADMIN', permissions: perms, require2fa: false }, session: { mfa: true }, orgs: [] }, can: (p: string) => perms.includes(p) };
  },
}));

/** The forms the Inbox knows about (was the local registry in Sangam). */
const registry = vi.hoisted(() => ({ forms: [] as unknown[] }));
vi.mock('../adapters/registry/useFormRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/registry/useFormRegistry')>()),
  useFormDefinitions: () => ({ data: registry.forms, isLoading: false }),
}));

const api = vi.hoisted(() => ({ rowExtra: {} as Record<string, unknown>, addFile: vi.fn(), fileLink: vi.fn(async () => 'https://files.test/letter.pdf'), bulk: vi.fn(), saveView: vi.fn(), mutate: vi.fn(), theme: 'classic', saveTheme: vi.fn(), filters: [] as unknown[], actions: [] as unknown[], extra: {} as Record<string, unknown>, record: {} as Record<string, unknown>, events: [] as unknown[] }));
vi.mock('../adapters/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/workflow')>();
  const people = [{ uuid: 'u1', name: 'Denim Head', email: 'd@x.test' }, { uuid: 'u2', name: 'Loom Lead', email: 'l@x.test', department: 'Weaving' }];
  return {
    ...actual,
    recordsAvailable: true,
    usePeople: () => ({ data: people }),
    useBulkRecords: () => ({ isPending: false, mutateAsync: api.bulk }),
    useAddRecordFile: () => ({ isPending: false, mutate: api.addFile }),
    recordFileLink: api.fileLink,
    useInbox: (filters: unknown) => {
      api.filters.push(filters);
      return {
        isLoading: false,
        data: { rows: [{ ...record, ...api.rowExtra }], total: 1, page: 1, limit: 20, forms: { 'form-v1': { name: form.name, code: form.code, statuses: form.workflow!.statuses } }, people: { u1: people[0] }, waitingOnMe: ['r1'] },
      };
    },
    useRecord: (id: string | undefined) => ({
      isLoading: false,
      data: id
        ? {
            record: { ...record, ...api.record },
            definition: form,
            canReopen: false,
            contactEmail: '',
            ...api.extra,
            people: { u1: people[0], u2: people[1] },
            next: api.actions.length ? [] : form.workflow!.statuses.slice(1, 2),
            actions: api.actions,
            approvals: [
              {
                runId: 'run9',
                status: 'WAITING',
                stepKey: 'approval',
                title: 'Compensation for Asha',
                instructions: 'Check lot 42',
                approvers: ['u1'],
                requestedAt: record.createdAt,
                dueAt: null,
                decision: null,
                decidedBy: '',
                comment: '',
                decidedAt: null,
                canDecide: true,
              },
            ],
            events: [
              { uuid: 'e1', type: 'CREATED', by: '', message: 'Submitted via WEB', data: {}, createdAt: record.createdAt },
              { uuid: 'e2', type: 'AUTOMATION', by: '', message: 'CRM: HANDLER failed - timeout', data: { ok: false }, createdAt: record.createdAt },
              { uuid: 'e3', type: 'AUTOMATION', by: '', message: 'Lead flow: looked up', data: { ok: true, runId: 'run1', stepIndex: 0 }, createdAt: record.createdAt },
              { uuid: 'e4', type: 'AUTOMATION', by: '', message: 'Lead flow: Custom API skipped (condition not met)', data: { ok: true, skipped: true, runId: 'run1', stepIndex: 1 }, createdAt: record.createdAt },
              ...api.events,
            ],
          }
        : undefined,
    }),
    useRecordAction: () => ({ isPending: false, mutateAsync: api.mutate }),
    useWorkViews: () => ({ data: [{ uuid: 'v1', name: 'Denim critical', shared: true, mine: true, ownerId: 'u1', filters: { priority: 'CRITICAL', open: 'true' } }] }),
    useSaveWorkView: () => ({ isPending: false, mutateAsync: api.saveView }),
    useDeleteWorkView: () => ({ isPending: false, mutateAsync: vi.fn() }),
    useWorkSettings: () => ({ data: { inboxTheme: api.theme } }),
    useSaveWorkSettings: () => ({
      isPending: false,
      mutate: (s: { inboxTheme: string }) => {
        api.saveTheme(s);
        api.theme = s.inboxTheme;
      },
    }),
  };
});

beforeEach(() => {
  auth.modules = ['FormPlatformAdminModule'];
  api.events = [];
  api.extra = {};
  api.theme = 'classic';
});

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

function Page() {
  const [open, setOpen] = useState<string | undefined>();
  return (
    <QueryClientProvider client={new QueryClient()}>
      <RecordsInboxPage recordId={open} onOpenRecord={setOpen} />
    </QueryClientProvider>
  );
}

describe('Records inbox', () => {
  it('lists my records with status, owner and overdue flag, and filters', async () => {
    Object.assign(registry, {
      forms: [form] });
    const user = userEvent.setup();
    render(<Page />);
    const row = screen.getByRole('button', { name: 'CCB-000001' }).closest('tr')!;
    expect(within(row).getByText('New')).toHaveClass('fb-status--OPEN');
    expect(within(row).getByText('Denim Head')).toBeInTheDocument();
    expect(await within(row).findByText('Asha Rao · asha@x.test')).toBeInTheDocument();
    expect(within(row).getByText(/ago$/)).toHaveClass('fb-overdue');
    expect(api.filters.at(-1)).toMatchObject({ assignee: 'me', open: true, page: 1 });

    await user.click(screen.getByRole('combobox', { name: 'Assigned to' }));
    await user.click(await screen.findByRole('option', { name: 'Everyone' }));
    expect(api.filters.at(-1)).toMatchObject({ assignee: '' });
    expect(within(row).getByText('Needs your approval')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Assigned to' }));
    await user.click(await screen.findByRole('option', { name: 'Waiting for my approval' }));
    expect(api.filters.at(-1)).toMatchObject({ waiting: true, assignee: '' });
  });

  it('an approver approves with a comment; the flow carries on on the server', async () => {
    Object.assign(registry, {
      forms: [form] });
    api.mutate.mockResolvedValue({});
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const card = within(await screen.findByRole('dialog')).getByLabelText('Approvals');
    expect(within(card).getByText('Compensation for Asha')).toBeInTheDocument();
    expect(within(card).getByText('Check lot 42')).toBeInTheDocument();
    await user.type(within(card).getByRole('textbox', { name: 'Approval comment' }), '10% credit');
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    expect(api.mutate).toHaveBeenLastCalledWith({ kind: 'decide', runId: 'run9', decision: 'APPROVED', comment: '10% credit' });
  });

  it('a record: answers with option labels, allowed moves, failed automations stand out', async () => {
    Object.assign(registry, {
      forms: [form] });
    api.mutate.mockResolvedValue({});
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Delivery')).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Resolved' })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Investigating' }));
    expect(api.mutate).toHaveBeenCalledWith({ kind: 'status', to: 'WIP' });
    expect(within(drawer).getByText('CRM: HANDLER failed - timeout').closest('li')).toHaveClass('fb-timeline__failed');
    // One run's steps are shown together, in order.
    const run = within(drawer).getByText('Lead flow').closest('li')!;
    expect(within(run).getByText(/1\. looked up/)).toBeInTheDocument();
    expect(within(run).getByText(/2\. Custom API skipped/).closest('li')).toHaveClass('fb-run__step--skipped');

    await user.type(within(drawer).getByRole('textbox', { name: 'Comment' }), 'Called back');
    await user.click(within(drawer).getByRole('button', { name: 'Comment' }));
    expect(api.mutate).toHaveBeenLastCalledWith({ kind: 'comment', message: 'Called back' });
  });

  it('a team filter: the teams people are in, and only that team\'s records', async () => {
    Object.assign(registry, { forms: [form] });
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('combobox', { name: 'Team' }));
    await user.click(await screen.findByRole('option', { name: 'Weaving' }));
    expect(api.filters.at(-1)).toMatchObject({ team: 'Weaving', page: 1 });
  });

  it('a flow that stopped on a failed step: a Forms admin runs it again from that step; others are not offered it', async () => {
    Object.assign(registry, { forms: [form] });
    api.mutate.mockResolvedValue({});
    api.events = [
      { uuid: 'e5', type: 'AUTOMATION', by: '', message: 'To CRM: WEBHOOK failed - crm.test answered 503', data: { ok: false, runId: 'run2', stepIndex: 1, automationId: 'a2' }, createdAt: record.createdAt },
      { uuid: 'e6', type: 'AUTOMATION', by: '', message: 'To CRM: stopped after step 2 failed', data: { ok: false, stopped: true, runId: 'run2', stepIndex: 1, automationId: 'a2' }, createdAt: record.createdAt },
    ];
    api.extra = { canRunAgain: true };
    const user = userEvent.setup();
    const { unmount } = render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');
    const run = within(drawer).getByText('To CRM').closest('li')!;
    // A run that finished is not offered it.
    expect(within(within(drawer).getByText('Lead flow').closest('li')!).queryByRole('button')).not.toBeInTheDocument();
    await user.click(within(run).getByRole('button', { name: 'Run again from step 2' }));
    expect(api.mutate).toHaveBeenLastCalledWith({ kind: 'again', runId: 'run2' });
    unmount();

    api.extra = { canRunAgain: false };
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    expect(within(await screen.findByRole('dialog')).queryByRole('button', { name: /Run again/ })).not.toBeInTheDocument();
  });

  it('a button that needs a file first says so before it is pressed, and shows why it was refused', async () => {
    Object.assign(registry, { forms: [form] });
    api.actions = [{ key: 'resolve', label: 'Resolve', to: 'DONE', requireFiles: { picturesOnly: true, if: { field: 'category', operator: 'equals', value: 'DELIVERY' } } }];
    const refusal = Object.assign(new Error('Complete these to Resolve'), { status: 400, fields: [{ field: 'files', message: 'Add a picture to the record before "Resolve"' }] });
    api.mutate.mockRejectedValueOnce(refusal);
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(within(drawer).getByRole('group', { name: 'Actions' })).getByRole('button', { name: 'Resolve' }));
    expect(within(drawer).getByText('Needs a picture added to the record while it is in this status, for items like this one. Add it under Files first.')).toBeInTheDocument();
    const confirm = within(drawer).getAllByRole('button', { name: 'Resolve' }).find((b) => !b.closest('[role="group"]'))!;
    await user.click(confirm);
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('Complete these to Resolve');
    api.actions = [];
  });

  it('work item: priority, named actions with a comment, work fields saved from the drawer', async () => {
    Object.assign(registry, {
      forms: [form] });
    api.actions = [{ key: 'resolve', label: 'Resolve', to: 'DONE', requireComment: true, requireFields: ['rootCause'] }];
    api.mutate.mockReset();
    api.mutate.mockResolvedValue({});
    const user = userEvent.setup();
    render(<Page />);
    const row = screen.getByRole('button', { name: 'CCB-000001' }).closest('tr')!;
    expect(within(row).getByText('High')).toHaveClass('fb-priority--HIGH');
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/from the Work portal/)).toBeInTheDocument();

    // Actions replace "Move to"
    expect(within(drawer).queryByText('Move to:')).not.toBeInTheDocument();
    await user.click(within(within(drawer).getByRole('group', { name: 'Actions' })).getByRole('button', { name: 'Resolve' }));
    await user.type(within(drawer).getByRole('textbox', { name: 'Resolve comment' }), 'Replaced');
    const confirm = within(drawer).getAllByRole('button', { name: 'Resolve' }).at(-1)!;
    await user.click(confirm);
    expect(api.mutate).toHaveBeenCalledWith({ kind: 'act', key: 'resolve', comment: 'Replaced' });

    // Work fields: prefilled from the record, saved as a whole (emptied fields as null)
    const work = within(drawer).getByLabelText('Work details');
    expect(within(work).getByLabelText(/^Root cause/)).toHaveValue('Old lot');
    await user.clear(within(work).getByLabelText(/^Root cause/));
    await user.type(within(work).getByLabelText(/^Root cause/), 'Wrong dye lot');
    await user.click(within(work).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(api.mutate).toHaveBeenCalledWith({ kind: 'work', values: { rootCause: 'Wrong dye lot', cost: null } }));

    // Priority
    await user.click(within(drawer).getByRole('combobox', { name: 'Priority' }));
    await user.click(await screen.findByRole('option', { name: 'Critical' }));
    expect(api.mutate).toHaveBeenLastCalledWith({ kind: 'priority', priority: 'CRITICAL' });
    api.actions = [];
  });

  it('hand over with a note: a colleague other than the owner, and what they need to know', async () => {
    Object.assign(registry, { forms: [form] });
    api.mutate.mockReset();
    api.mutate.mockResolvedValue({});
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Hand over with a note' }));
    const handOver = within(drawer).getByRole('group', { name: 'Hand over' });
    expect(within(handOver).getByRole('button', { name: 'Hand over' })).toBeDisabled();
    await user.click(within(handOver).getByRole('combobox', { name: 'Hand over to' }));
    // The person who has it now is not offered.
    expect(screen.queryByRole('option', { name: /Denim Head/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: /Loom Lead/ }));
    await user.type(within(handOver).getByRole('textbox', { name: 'Note for them' }), 'Customer is calling back at 4');
    await user.click(within(handOver).getByRole('button', { name: 'Hand over' }));
    expect(api.mutate).toHaveBeenCalledWith({ kind: 'assign', userId: 'u2', note: 'Customer is calling back at 4' });
  });

  it('files: what came with the form and what staff added are listed, can be downloaded, and more can be added', async () => {
    Object.assign(registry, { forms: [form] });
    api.record = {
      files: [
        { fieldName: '$staff', uploadId: 'up2', name: 'letter.pdf', size: 2_400_000, contentType: 'application/pdf', addedBy: 'u1', addedAt: '2026-10-10T09:00:00.000Z' },
        { fieldName: 'photo', uploadId: 'up1', name: 'damage.png', size: 51_200, contentType: 'image/png' },
      ],
    };
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('tab', { name: 'Files (2)' }));
    const files = within(drawer).getByRole('region', { name: 'Files' });
    expect(within(files).getByText(/2\.3 MB · Added by Denim Head on 10 Oct 2026/)).toBeInTheDocument();
    expect(within(files).getByText(/50 KB · Sent with the form/)).toBeInTheDocument();

    await user.click(within(files).getByRole('button', { name: 'Download letter.pdf' }));
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('https://files.test/letter.pdf', '_blank', 'noopener'));
    expect(api.fileLink).toHaveBeenCalledWith('r1', 'up2');

    const file = new File(['%PDF-1.4'], 'reply.pdf', { type: 'application/pdf' });
    await user.upload(within(files).getByLabelText('Add a file'), file);
    expect(api.addFile).toHaveBeenCalledWith(file, expect.anything());
    api.record = {};
    opened.mockRestore();
  });

  it('ask a colleague: a question is needed; someone asked sees it with a box for their answer', async () => {
    Object.assign(registry, { forms: [form] });
    api.mutate.mockReset();
    api.mutate.mockResolvedValue({});
    const user = userEvent.setup();
    const first = render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).queryByRole('group', { name: 'Your view is asked' })).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Ask a colleague' }));
    const ask = within(drawer).getByRole('group', { name: 'Ask a colleague' });
    await user.click(within(ask).getByRole('combobox', { name: 'Ask' }));
    await user.click(await screen.findByRole('option', { name: /Loom Lead/ }));
    // A colleague alone is not a question.
    expect(within(ask).getByRole('button', { name: 'Ask' })).toBeDisabled();
    await user.type(within(ask).getByRole('textbox', { name: 'Your question' }), 'Is lot 42 recalled?');
    await user.click(within(ask).getByRole('button', { name: 'Ask' }));
    expect(api.mutate).toHaveBeenCalledWith({ kind: 'ask', userId: 'u2', question: 'Is lot 42 recalled?' });
    first.unmount();

    api.extra = { askedOfMe: { id: 'a1', by: 'u1', to: 'me', question: 'Is lot 42 recalled?', askedAt: '2026-10-10T10:00:00.000Z', answer: '', answeredAt: null } };
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const asked = within(await screen.findByRole('dialog')).getByRole('group', { name: 'Your view is asked' });
    expect(within(asked).getByText('Denim Head asks for your view')).toBeInTheDocument();
    expect(within(asked).getByText('Is lot 42 recalled?')).toBeInTheDocument();
    await user.type(within(asked).getByRole('textbox', { name: 'Your answer' }), 'Yes, since Monday.');
    await user.click(within(asked).getByRole('button', { name: 'Send answer' }));
    expect(api.mutate).toHaveBeenCalledWith({ kind: 'answer', answer: 'Yes, since Monday.' });
    api.extra = {};
  });

  it('"Send it back" is offered to someone a colleague handed the record to, and names the colleague', async () => {
    Object.assign(registry, { forms: [form] });
    api.mutate.mockReset();
    api.mutate.mockResolvedValue({ gone: true });
    const user = userEvent.setup();
    const first = render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    expect(within(await screen.findByRole('dialog')).queryByRole('button', { name: /Send it back/ })).not.toBeInTheDocument();
    first.unmount();

    api.record = { handedOverBy: 'u2' };
    api.extra = { canSendBack: true };
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send it back to Loom Lead' }));
    expect(api.mutate).toHaveBeenCalledWith({ kind: 'send-back' });
    api.record = {};
    api.extra = {};
  });

  it('"Take it" is offered on work nobody holds, and only there', async () => {
    Object.assign(registry, { forms: [form] });
    api.mutate.mockReset();
    api.mutate.mockResolvedValue({});
    const user = userEvent.setup();
    const first = render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    expect(within(await screen.findByRole('dialog')).queryByRole('button', { name: 'Take it' })).not.toBeInTheDocument();
    first.unmount();

    api.record = { assigneeId: '' };
    api.extra = { canTake: true };
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Take it' }));
    expect(api.mutate).toHaveBeenCalledWith({ kind: 'take' });
    api.record = {};
    api.extra = {};
  });

  it('several at once: tick items, then give them to someone or approve them, and hear what could not be done', async () => {
    Object.assign(registry, { forms: [form] });
    api.bulk.mockReset();
    api.bulk.mockResolvedValue({ done: 1, failed: [] });
    const user = userEvent.setup();
    render(<Page />);
    // Nothing ticked, no bar.
    expect(screen.queryByRole('group', { name: 'Ticked items' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Tick CCB-000001' }));
    // A tick does not open the record.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const bar = screen.getByRole('group', { name: 'Ticked items' });
    expect(within(bar).getByText('1 ticked')).toBeInTheDocument();
    // This one is held by someone and waits on me: it can be approved, and there is nothing to take.
    expect(within(bar).queryByRole('button', { name: 'Take them' })).not.toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Approve' }));
    expect(api.bulk).toHaveBeenCalledWith({ ids: ['r1'], op: 'decide', decision: 'APPROVED' });
    // Done: the ticks are cleared.
    await vi.waitFor(() => expect(screen.queryByRole('group', { name: 'Ticked items' })).not.toBeInTheDocument());

    await user.click(screen.getByRole('checkbox', { name: 'Tick every item on this page' }));
    await user.click(within(screen.getByRole('group', { name: 'Ticked items' })).getByRole('combobox', { name: 'Give ticked items to' }));
    await user.click(await screen.findByRole('option', { name: 'Loom Lead' }));
    expect(api.bulk).toHaveBeenLastCalledWith({ ids: ['r1'], op: 'assign', userId: 'u2' });
  });

  it('calendar: the same view as a month, asked for all at once, with a record on the day it is due', async () => {
    Object.assign(registry, { forms: [form] });
    const due = new Date();
    due.setHours(15, 0, 0, 0);
    api.rowExtra = { resolutionDueAt: due.toISOString() };
    const user = userEvent.setup();
    render(<Page />);
    await user.click(within(screen.getByRole('group', { name: 'Layout' })).getByRole('button', { name: 'Calendar' }));
    const calendar = screen.getByRole('group', { name: 'Calendar of what is due' });
    // It asks for a stretch of time (the month on show) and more rows than a page of the list.
    expect(api.filters.at(-1)).toMatchObject({ limit: 300, sort: 'due', page: 1, dueFrom: expect.any(String), dueTo: expect.any(String) });
    const today = within(calendar).getByRole('gridcell', { name: new RegExp(`^${due.getDate()} ${due.toLocaleString('en', { month: 'long' })}: 1 due`) });
    expect(within(today).getByRole('button', { name: 'CCB-000001' })).toBeInTheDocument();
    // The list's paging has no place here.
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    const before = (api.filters.at(-1) as { dueFrom: string }).dueFrom;
    await user.click(within(calendar).getByRole('button', { name: 'Next month' }));
    expect((api.filters.at(-1) as { dueFrom: string }).dueFrom > before).toBe(true);
    await user.click(within(calendar).getByRole('button', { name: 'This month' }));
    // One click on a record opens it.
    await user.click(within(screen.getByRole('group', { name: 'Calendar of what is due' })).getByRole('button', { name: 'CCB-000001' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    api.rowExtra = {};
    window.localStorage.clear();
  });

  it('SLA summary, reopen and email requester (WM-2/3)', async () => {
    Object.assign(registry, {
      forms: [{ ...form, workflow: { ...form.workflow!, requestInfoStatus: 'WIP', emailTemplates: [{ key: 'ask', name: 'Ask for lot', subject: 'About {{$record.ref}}', body: 'Please send the lot.' }] } }],
    });
    api.record = { responseDueAt: '2000-01-01T00:00:00.000Z', resolutionDueAt: null, slaPausedAt: '2026-09-29T10:00:00.000Z', escalationStep: 2, reopenCount: 1 };
    api.extra = { canReopen: true, contactEmail: 'asha@x.test', definition: { ...form, workflow: { ...form.workflow!, requestInfoStatus: 'WIP', emailTemplates: [{ key: 'ask', name: 'Ask for lot', subject: 'About {{$record.ref}}', body: 'Please send the lot.' }] } } };
    api.mutate.mockReset();
    api.mutate.mockResolvedValue({});
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');

    const sla = within(drawer).getByLabelText('SLA');
    expect(within(sla).getByText(/^Overdue/)).toHaveClass('fb-overdue');
    expect(within(sla).getByText(/^Clock paused since/)).toBeInTheDocument();
    expect(within(sla).getByText('Level 1')).toBeInTheDocument();
    expect(within(sla).getByText('1 time')).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Reopen' }));
    await user.type(within(drawer).getByRole('textbox', { name: 'Why reopen' }), 'Back again');
    await user.click(within(drawer).getAllByRole('button', { name: 'Reopen' }).at(-1)!);
    expect(api.mutate).toHaveBeenCalledWith({ kind: 'reopen', comment: 'Back again' });

    await user.click(within(drawer).getByRole('button', { name: /Email requester/ }));
    const mail = within(drawer).getByLabelText('Email requester');
    expect(within(mail).getByText('asha@x.test')).toBeInTheDocument();
    await user.click(within(mail).getByRole('combobox', { name: 'Email template' }));
    await user.click(await screen.findByRole('option', { name: 'Ask for lot' }));
    expect(within(mail).getByRole('textbox', { name: 'Email subject' })).toHaveValue('About {{$record.ref}}');
    await user.click(within(mail).getByRole('checkbox', { name: /Request information/ }));
    await user.click(within(mail).getByRole('button', { name: 'Send' }));
    expect(api.mutate).toHaveBeenLastCalledWith({ kind: 'email', subject: 'About {{$record.ref}}', body: 'Please send the lot.', templateKey: 'ask', requestInfo: true });
    api.record = {};
    api.extra = {};
  });

  it('card view (remembered per viewer); an admin sets the theme for everyone', async () => {
    Object.assign(registry, {
      forms: [form] });
    const user = userEvent.setup();
    const { container, unmount } = render(<Page />);
    await user.click(within(screen.getByRole('group', { name: 'Layout' })).getByRole('button', { name: /Cards/ }));
    const card = screen.getByRole('article', { name: 'CCB-000001' });
    expect(within(card).getByText('New')).toHaveClass('fb-status--OPEN');
    expect(within(card).getByText('Needs your approval')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Midnight theme' }));
    expect(api.saveTheme).toHaveBeenCalledWith({ inboxTheme: 'midnight' });
    await user.click(card);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    unmount();
    const again = render(<Page />);
    expect(screen.getByRole('article', { name: 'CCB-000001' })).toBeInTheDocument();
    expect(again.container.querySelector('.wi')).toHaveAttribute('data-theme', 'midnight');
    expect(container).toBeDefined();
    localStorage.clear();
    api.theme = 'classic';
    again.unmount();
  });

  it('non-admins: no theme picker, no Save view, no Unassigned; a handed-off item closes the drawer', async () => {
    Object.assign(registry, {
      forms: [form] });
    auth.modules = ['FormPlatformRecordsModule'];
    api.theme = 'forest';
    api.mutate.mockReset();
    api.mutate.mockResolvedValue({ gone: true });
    const user = userEvent.setup();
    const { container } = render(<Page />);
    expect(container.querySelector('.wi')).toHaveAttribute('data-theme', 'forest');
    expect(screen.queryByRole('group', { name: 'Theme' })).not.toBeInTheDocument();
    const views = screen.getByRole('group', { name: 'Views' });
    expect(within(views).queryByRole('button', { name: /Save view/ })).not.toBeInTheDocument();
    expect(within(views).queryByRole('button', { name: 'Unassigned' })).not.toBeInTheDocument();
    // What nobody holds is, for them, their team's queue; and a manager has their people's work.
    await user.click(within(views).getByRole('button', { name: "My team's queue" }));
    expect(api.filters.at(-1)).toMatchObject({ assignee: 'unassigned', open: true });
    await user.click(within(views).getByRole('button', { name: "My team's work" }));
    expect(api.filters.at(-1)).toMatchObject({ assignee: 'reports', open: true });
    await user.click(screen.getByRole('combobox', { name: 'Assigned to' }));
    expect(screen.queryByRole('option', { name: 'Unassigned' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: "My team's queue" })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    // The API answers null when the change took the item away (e.g. reassigned): the drawer closes.
    await user.click(screen.getByRole('button', { name: 'CCB-000001' }));
    const drawer = await screen.findByRole('dialog');
    await user.click(await within(drawer).findByRole('button', { name: 'Investigating' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    auth.modules = ['FormPlatformAdminModule'];
    api.theme = 'classic';
  });

  it('views, text search, sort and field filters (WM-4)', async () => {
    Object.assign(registry, {
      forms: [form] });
    api.saveView.mockResolvedValue([]);
    const user = userEvent.setup();
    render(<Page />);
    const views = screen.getByRole('group', { name: 'Views' });
    expect(within(views).getByRole('button', { name: 'My open' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(views).getByRole('button', { name: 'Overdue' }));
    expect(api.filters.at(-1)).toMatchObject({ overdue: true, sort: 'due', assignee: '' });
    await user.click(within(views).getByRole('button', { name: 'Denim critical (shared)' }));
    expect(api.filters.at(-1)).toMatchObject({ priority: 'CRITICAL', open: true });

    await user.type(screen.getByRole('textbox', { name: 'Search' }), 'shade');
    expect(api.filters.at(-1)).toMatchObject({ q: 'shade' });
    await user.click(screen.getByRole('combobox', { name: 'Sort' }));
    await user.click(await screen.findByRole('option', { name: 'Highest priority' }));
    expect(api.filters.at(-1)).toMatchObject({ sort: 'priority' });

    // Field filters appear once a form is picked.
    await user.click(screen.getByRole('combobox', { name: 'Form' }));
    await user.click(await screen.findByRole('option', { name: form.name }));
    await user.click(screen.getByRole('button', { name: /Filter on a field/ }));
    await user.click(screen.getByRole('combobox', { name: 'Filter field' }));
    await user.click(await screen.findByRole('option', { name: 'Complaint Category' }));
    await user.click(screen.getByRole('combobox', { name: 'Filter value' }));
    await user.click(await screen.findByRole('option', { name: 'Delivery' }));
    await user.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(api.filters.at(-1)).toMatchObject({ formCode: form.code, ff: [{ field: 'category', op: 'eq', value: 'DELIVERY' }] });
    expect(screen.getByText('Complaint Category is Delivery')).toBeInTheDocument();

    await user.click(within(views).getByRole('button', { name: /Save view/ }));
    await user.type(screen.getByRole('textbox', { name: 'View name' }), 'Delivery issues');
    await user.click(screen.getByRole('checkbox', { name: 'Share with everyone' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.saveView).toHaveBeenCalledWith(expect.objectContaining({ id: 'new', name: 'Delivery issues', shared: true, filters: expect.objectContaining({ ff: [{ field: 'category', op: 'eq', value: 'DELIVERY' }] }) }));
  });
});
