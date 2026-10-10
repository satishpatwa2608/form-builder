import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { validateFormDefinition } from '../engine';
import { seedLocalFragments } from '../adapters/fragments';
import FragmentsPage from './FragmentsPage';
import { FRAGMENT_STARTERS } from './fragment-starters';

const admin = { value: true };
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ me: { user: { id: 'u1', name: 'Asha', email: 'a@x.test' } }, can: () => admin.value }) }));
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
beforeEach(() => {
  admin.value = true;
  seedLocalFragments([]);
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FragmentsPage />
    </QueryClientProvider>,
  );

describe('Fragments page', () => {
  it('every ready-made starting point is a section a form could hold', () => {
    for (const s of FRAGMENT_STARTERS) {
      const result = validateFormDefinition({ id: 'x', orgId: 'o', businessId: '', name: s.name, code: 'T', version: 1, status: 'DRAFT', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'd' }, fields: s.fields, createdBy: 'u', updatedBy: 'u' });
      expect(result.success ? [] : result.issues, s.name).toEqual([]);
    }
    expect(FRAGMENT_STARTERS.map((s) => s.name)).toEqual(['Address', 'Bank account', 'Contact person', 'Company details', 'Emergency contact', 'Identity document']);
  });

  it('says how a fragment is used and made, and adds one from a starting point', async () => {
    show();
    expect(screen.getByText(/in a form, open the palette and pick it under Fragments/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New fragment' }));
    const dialog = await screen.findByRole('dialog');
    // It says what the chosen starting point holds, and the name follows the choice.
    expect(dialog).toHaveTextContent('It will hold: House, street and area, City, State, PIN code.');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Start from' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Contact person' }));
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Contact person');
    expect(dialog).toHaveTextContent('It will hold: Name, Email, Phone.');
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Site contact');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add to the library' }));
    const row = await screen.findByRole('row', { name: /Site contact/ });
    expect(row).toHaveTextContent('Name, Email, Phone');
    expect(row).toHaveTextContent('No form yet');
  });

  it('does not make a second fragment of the same name', async () => {
    seedLocalFragments([{ id: 'f1', name: 'Address', description: '', fields: FRAGMENT_STARTERS[0]!.fields, usedBy: [] }]);
    show();
    await userEvent.click(await screen.findByRole('button', { name: 'New fragment' }));
    const dialog = await screen.findByRole('dialog');
    // The first one not yet in the library is offered.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Bank account');
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Address');
    expect(dialog).toHaveTextContent('The library already has a fragment of this name.');
    expect(within(dialog).getByRole('button', { name: 'Add to the library' })).toBeDisabled();
  });

  it('people who cannot manage the library can look, and are not offered the button', async () => {
    admin.value = false;
    show();
    expect(screen.queryByRole('button', { name: 'New fragment' })).toBeNull();
  });
});
