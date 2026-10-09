import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition } from '../types';
import { seedLocalExtensions, type ExtensionInfo } from '../adapters/extensions';
import { FormSettingsPanel } from '../builder/components/FormSettingsPanel';
import ExtensionsPage from './ExtensionsPage';

const admin = { value: true };
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ me: { user: { id: 'u1', name: 'Asha', email: 'a@x.test' } }, can: () => admin.value }) }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const acme: ExtensionInfo = {
  id: 'e1',
  ref: 'abcd1234',
  name: 'Acme rules',
  status: 'OK',
  lastSyncedAt: '2026-10-09T03:00:00.000Z',
  lastError: '',
  steps: [{ key: 'credit-check', label: 'Check credit', description: 'Asks the credit bureau', outputs: ['score', 'verdict'] }],
  lists: [{ key: 'branches', label: 'Branches', params: ['city'] }],
  checks: [{ key: 'one-claim', label: 'One claim per invoice' }],
};
const CHECK = 'x-abcd1234-one-claim';

const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

beforeEach(() => {
  admin.value = true;
  seedLocalExtensions([acme], [{ key: CHECK, label: 'Acme rules: One claim per invoice' }]);
});

describe('The Extensions page', () => {
  it('shows what the organisation\'s code offers, and where each thing is used', async () => {
    wrap(<ExtensionsPage />);
    const card = await screen.findByRole('region', { name: 'Acme rules' });
    expect(within(card).getByText('Running')).toBeInTheDocument();
    expect(card).toHaveTextContent('Check credit — Asks the credit bureau · returns score, verdict');
    expect(card).toHaveTextContent('Branches · filtered by city');
    expect(card).toHaveTextContent('One claim per invoice');
    expect(card).toHaveTextContent('add a step and choose Custom API');
  });

  it('reads it again after a new version, on request', async () => {
    const user = userEvent.setup();
    wrap(<ExtensionsPage />);
    await user.click(await screen.findByRole('button', { name: 'Read again' }));
    expect(await screen.findByRole('region', { name: 'Acme rules' })).toBeInTheDocument();
  });

  it('says plainly when it is not answering, and what that means for forms', async () => {
    seedLocalExtensions([{ ...acme, status: 'UNREACHABLE', lastError: 'The extension could not be reached' }]);
    wrap(<ExtensionsPage />);
    expect(await screen.findByText('Not answering')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The extension could not be reached. Forms that depend on it cannot take submissions until it answers again.');
  });

  it('explains how to get one when there is none, and is for admins only', async () => {
    seedLocalExtensions([]);
    const first = wrap(<ExtensionsPage />);
    expect(await screen.findByText(/No extension is set up for your organisation/)).toBeInTheDocument();
    first.unmount();
    admin.value = false;
    wrap(<ExtensionsPage />);
    expect(screen.getByText(/managed by your organisation's administrators/)).toBeInTheDocument();
  });
});

describe('Checks from the extension, in a form\'s settings', () => {
  const form = (over: Partial<FormDefinition> = {}): FormDefinition => ({
    id: 'f1',
    orgId: 'o1',
    businessId: '',
    name: 'Claim',
    code: 'CLAIM',
    version: 1,
    status: 'DRAFT',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [{ id: 'a', type: 'TEXT', name: 'invoice', label: 'Invoice' }],
    createdBy: 'u1',
    updatedBy: 'u1',
    ...over,
  });
  function Panel({ initial, spy }: { initial: FormDefinition; spy: (f: FormDefinition) => void }) {
    const [current, setCurrent] = useState(initial);
    return (
      <FormSettingsPanel
        form={current}
        readOnly={false}
        codeLocked={false}
        onChange={(changes) =>
          setCurrent((f) => {
            const next = { ...f, ...changes };
            spy(next);
            return next;
          })
        }
      />
    );
  }

  it('a designer ticks a check to run it on the form, and unticks it to stop', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    wrap(<Panel initial={form()} spy={spy} />);
    const group = await screen.findByRole('group', { name: 'Checks from your extension' });
    await user.click(within(group).getByRole('checkbox', { name: /One claim per invoice/ }));
    expect(spy.mock.lastCall![0].submitChecks).toEqual([CHECK]);
    await user.click(within(group).getByRole('checkbox', { name: /One claim per invoice/ }));
    expect(spy.mock.lastCall![0].submitChecks).toBeUndefined();
  });

  it('nothing is shown when the organisation has no checks', async () => {
    seedLocalExtensions([], []);
    wrap(<Panel initial={form()} spy={vi.fn()} />);
    expect(await screen.findByText('Let people save and continue later')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Checks from your extension' })).not.toBeInTheDocument();
  });

  it('a check the form names that is no longer offered can be seen and removed', async () => {
    const user = userEvent.setup();
    const spy = vi.fn();
    wrap(<Panel initial={form({ submitChecks: ['x-abcd1234-old-check'] })} spy={spy} />);
    const group = await screen.findByRole('group', { name: 'Checks from your extension' });
    await user.click(await within(group).findByRole('checkbox', { name: /no longer offered/ }));
    expect(spy.mock.lastCall![0].submitChecks).toBeUndefined();
  });
});
