import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition } from '@fb/engine';
import { fakeApi } from '../test/fake-api';
import type { FormSummary } from '../lib/types';
import { FormVersions } from './FormVersions';

const def = (id: string, version: number, status: string, label: string, extra: object[] = []): FormDefinition =>
  ({
    id,
    orgId: 'o1',
    businessId: '',
    name: 'Feedback',
    code: 'FEEDBACK',
    version,
    status,
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [{ id: 'a', type: 'TEXT', name: 'view', label }, ...extra],
    createdBy: 'u1',
    updatedBy: 'u1',
  }) as FormDefinition;

const versions = [
  { id: 'v3', version: 3, status: 'DRAFT', updatedAt: '2026-10-09T08:00:00.000Z', publishedAt: null },
  { id: 'v2', version: 2, status: 'PUBLISHED', updatedAt: '2026-10-08T08:00:00.000Z', publishedAt: '2026-10-08T09:00:00.000Z' },
  { id: 'v1', version: 1, status: 'ARCHIVED', updatedAt: '2026-10-01T08:00:00.000Z', publishedAt: '2026-10-01T09:00:00.000Z' },
];
const form: FormSummary = { id: 'v3', code: 'FEEDBACK', name: 'Feedback', folderId: 'f1', version: 3, status: 'DRAFT', publishedVersion: 2, updatedAt: '2026-10-09T08:00:00.000Z', permissions: ['form.view', 'form.edit'] };

const routes = {
  'GET /forms/v3/versions': () => ({ body: versions }),
  'GET /forms/v3': () => ({ body: { definition: def('v3', 3, 'DRAFT', 'Tell us what you think', [{ id: 'b', type: 'EMAIL', name: 'email', label: 'Email' }]) } }),
  'GET /forms/v2': () => ({ body: { definition: def('v2', 2, 'PUBLISHED', 'Your view') } }),
  'GET /forms/v1': () => ({ body: { definition: def('v1', 1, 'ARCHIVED', 'Your view') } }),
};

function renderPanel(canEdit = true) {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormVersions form={form} canEdit={canEdit} />
    </QueryClientProvider>,
  );
  return user;
}

afterEach(() => vi.unstubAllGlobals());

describe('versions of a form', () => {
  it('lists every version with when it was published', async () => {
    fakeApi(routes);
    renderPanel();
    expect(await screen.findByText('v3 · Draft')).toBeInTheDocument();
    expect(screen.getByText('v2 · Published')).toBeInTheDocument();
    expect(screen.getByText('v1 · Archived')).toBeInTheDocument();
    // The newest version is what the others are compared with, so it has neither button.
    expect(screen.queryByRole('button', { name: 'What changed since v3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore v3' })).not.toBeInTheDocument();
  });

  it('says in words what changed since an earlier version', async () => {
    fakeApi(routes);
    const user = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'What changed since v2' }));
    const changes = await screen.findByRole('region', { name: 'Changes from v2 to v3' });
    expect(changes).toHaveTextContent('Changed field Tell us what you think: label: was "Your view", now "Tell us what you think"');
    expect(changes).toHaveTextContent('Added field Email');
    // Pressing it again closes the comparison.
    await user.click(screen.getByRole('button', { name: 'What changed since v2' }));
    expect(screen.queryByRole('region', { name: 'Changes from v2 to v3' })).not.toBeInTheDocument();
  });

  it('restoring asks before replacing an open draft, and then does it', async () => {
    const { calls } = fakeApi({
      ...routes,
      'POST /forms/v1/restore': (body) =>
        (body as { replaceDraft?: boolean }).replaceDraft
          ? { body: { definition: { version: 3 } } }
          : { status: 409, body: { message: 'A draft (v3) is already open. Restoring v1 replaces what is in it.' } },
    });
    const user = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Restore v1' }));
    const warning = await screen.findByText(/A draft \(v3\) is already open/);
    expect(calls.filter((c) => c.path === '/forms/v1/restore').map((c) => c.body)).toEqual([{ replaceDraft: false }]);

    await user.click(within(warning.closest('[role="alert"], div')!.parentElement!).getByRole('button', { name: 'Replace the draft' }));
    expect(await screen.findByText('v1 is back as draft v3. Review and publish it when ready.')).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/forms/v1/restore').map((c) => c.body)).toEqual([{ replaceDraft: false }, { replaceDraft: true }]);
  });

  it('keeping the draft changes nothing', async () => {
    const { calls } = fakeApi({ ...routes, 'POST /forms/v1/restore': () => ({ status: 409, body: { message: 'A draft (v3) is already open. Restoring v1 replaces what is in it.' } }) });
    const user = renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Restore v1' }));
    await user.click(await screen.findByRole('button', { name: 'Keep the draft' }));
    expect(screen.queryByText(/already open/)).not.toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/forms/v1/restore')).toHaveLength(1);
  });

  it('someone who cannot edit can compare but not restore', async () => {
    fakeApi(routes);
    renderPanel(false);
    expect(await screen.findByRole('button', { name: 'What changed since v1' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore v1' })).not.toBeInTheDocument();
  });
});
