import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition } from '../types';
import { seedLocalDeploy, seedLocalExtensions, type DeployStatus, type ExtensionInfo } from '../adapters/extensions';
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
  seedLocalDeploy();
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

describe('Extensions page: deploying your own code', () => {
  const login = { registry: 'store.test', image: 'store.test/fb-ext/org-1', username: 'AWS', password: 'pw-secret-123', expiresAt: '2026-10-09T10:30:00.000Z', platform: 'linux/arm64' };
  const images = [
    { tag: 'v2', pushedAt: '2026-10-09T09:00:00.000Z', sizeMb: 61.4 },
    { tag: 'v1', pushedAt: '2026-10-08T09:00:00.000Z', sizeMb: 61.2 },
  ];
  const on = (over: Partial<DeployStatus> = {}) => seedLocalDeploy({ status: { available: true, included: true, platform: 'linux/arm64', deploys: [], ...over }, login, images })!;

  it('is not offered where the installation does not have it', async () => {
    wrap(<ExtensionsPage />);
    expect(await screen.findByRole('heading', { name: 'Acme rules' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Deploy your own code' })).not.toBeInTheDocument();
  });

  it('shows the push commands for the organisation\'s own space, with the password kept off the screen', async () => {
    on();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    wrap(<ExtensionsPage />);
    const area = await screen.findByRole('region', { name: 'Deploy your own code' });
    await userEvent.click(within(area).getByRole('button', { name: 'Show the push commands' }));
    expect(await within(area).findByLabelText('Build')).toHaveTextContent('docker build --platform linux/arm64 -t store.test/fb-ext/org-1:v1 .');
    expect(within(area).getByLabelText('Push')).toHaveTextContent('docker push store.test/fb-ext/org-1:v1');
    expect(within(area).getByLabelText('Sign in to your image space')).toHaveTextContent('docker login store.test -u AWS -p ••••••••');
    expect(area).not.toHaveTextContent('pw-secret-123');
    await userEvent.click(within(area).getByRole('button', { name: 'Copy: Sign in to your image space' }));
    expect(writeText).toHaveBeenCalledWith('docker login store.test -u AWS -p pw-secret-123');
  });

  it('deploys the chosen version and shows it under way; nothing else can be asked meanwhile', async () => {
    const seeded = on();
    wrap(<ExtensionsPage />);
    const area = await screen.findByRole('region', { name: 'Deploy your own code' });
    const version = await within(area).findByLabelText('Version');
    await within(area).findByRole('option', { name: /^v1 · pushed/ });
    expect(version).toHaveValue('v2');
    await userEvent.selectOptions(version, 'v1');
    await userEvent.click(within(area).getByRole('button', { name: 'Deploy' }));
    expect(seeded.asked).toEqual(['v1']);
    const latest = await within(area).findByRole('status', { name: 'Latest deployment' });
    expect(latest).toHaveTextContent('Waiting to start · version v1');
    expect(within(area).getByRole('button', { name: 'Deploy' })).toBeDisabled();
    expect(within(area).getByRole('button', { name: 'Remove the extension' })).toBeDisabled();
  });

  it('a version that did not start says why and shows what the code printed', async () => {
    on({ deploys: [{ id: 'd1', kind: 'DEPLOY', tag: 'v2', status: 'FAILED', message: 'Version v2 did not start; the previous one is running again.', output: "Error: Cannot find module './steps'", at: '2026-10-09T09:05:00.000Z', finishedAt: '2026-10-09T09:06:00.000Z' }] });
    wrap(<ExtensionsPage />);
    const latest = await screen.findByRole('status', { name: 'Latest deployment' });
    expect(latest).toHaveTextContent('Failed · version v2');
    expect(latest).toHaveTextContent('Version v2 did not start; the previous one is running again.');
    expect(latest).toHaveTextContent("Error: Cannot find module './steps'");
  });

  it('removes the extension only after being asked twice', async () => {
    const seeded = on();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    wrap(<ExtensionsPage />);
    const area = await screen.findByRole('region', { name: 'Deploy your own code' });
    const remove = await within(area).findByRole('button', { name: 'Remove the extension' });
    await userEvent.click(remove);
    expect(seeded.asked).toEqual([]);
    await userEvent.click(remove);
    expect(seeded.asked).toEqual(['REMOVE']);
    confirm.mockRestore();
  });

  it('a plan without extensions is told so, and offered nothing to press', async () => {
    on({ included: false });
    seedLocalExtensions([]);
    wrap(<ExtensionsPage />);
    const area = await screen.findByRole('region', { name: 'Deploy your own code' });
    expect(area).toHaveTextContent('Your plan does not include extensions.');
    expect(within(area).queryByRole('button')).not.toBeInTheDocument();
  });
});
