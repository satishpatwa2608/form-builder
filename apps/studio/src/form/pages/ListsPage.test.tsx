import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { seedLocalListSources } from '../adapters/data-source/data-source-adapter';
import { seedLocalLists, type SharedList } from '../adapters/lists';
import { DataSourceEditor } from '../builder/components/DataSourceEditor';
import type { DataSourceConfig, FormField } from '../types';
import ListsPage from './ListsPage';

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
const cities: SharedList = { id: 'l1', key: 'cities', name: 'Cities', description: 'Where we have offices', dependsOn: '', items: [{ value: 'PUNE', label: 'Pune' }, { value: 'MUMBAI', label: 'Mumbai' }, { value: 'OLD', label: 'Old town', retired: true }], usedBy: [{ formId: 'f1', name: 'Visit' }] };
beforeEach(() => {
  admin.value = true;
  seedLocalLists([]);
  seedLocalListSources([]);
});
const wrap = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

describe('Lists page', () => {
  it('makes a list from items typed one to a row, or pasted many at once', async () => {
    wrap(<ListsPage />);
    expect(await screen.findByText('No lists yet. Choose New list.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'New list' }));
    const dialog = await screen.findByRole('dialog');
    const add = within(dialog).getByRole('button', { name: 'Add to the library' });
    expect(add).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Cities');
    await userEvent.type(within(dialog).getByLabelText('Item 1'), 'Pune');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Paste many' }));
    await userEvent.type(within(dialog).getByLabelText('Items to add, one on each line'), 'Mumbai\nNagpur\n\npune\nMumbai');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add these' }));
    // Blank lines and repeats are dropped.
    expect(within(dialog).getAllByLabelText(/^Item \d+$/).map((i) => (i as HTMLInputElement).value)).toEqual(['Pune', 'Mumbai', 'Nagpur']);
    await userEvent.click(add);
    const row = await screen.findByRole('row', { name: /Cities/ });
    expect(row).toHaveTextContent('3: Pune, Mumbai, Nagpur');
    expect(row).toHaveTextContent('No form yet');
  });

  it('a list that depends on another asks which choice each item belongs to', async () => {
    seedLocalLists([cities]);
    wrap(<ListsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'New list' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Branches');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Depends on another list' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Yes: Cities' }));
    await userEvent.type(within(dialog).getByLabelText('Item 1'), 'Camp');
    const add = within(dialog).getByRole('button', { name: 'Add to the library' });
    expect(add).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Item 1 belongs to' }));
    // Only choices still offered in the other list; a retired one is not.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Pune', 'Mumbai']);
    await userEvent.click(screen.getByRole('option', { name: 'Pune' }));
    await userEvent.click(add);
    expect(await screen.findByRole('row', { name: /Branches/ })).toHaveTextContent('Cities');
  });

  it('shows where each list is used, hides retired items, and will not delete one in use', async () => {
    seedLocalLists([cities]);
    wrap(<ListsPage />);
    const row = await screen.findByRole('row', { name: /Cities/ });
    expect(row).toHaveTextContent('2: Pune, Mumbai');
    expect(row).toHaveTextContent('Visit');
    await userEvent.click(within(row).getByRole('button', { name: 'Delete Cities' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Change Cities' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByLabelText(/^Item \d+$/).map((i) => (i as HTMLInputElement).value)).toEqual(['Pune', 'Mumbai']);
    expect(dialog).toHaveTextContent('answers already given with it still read properly');
  });

  it('people who cannot manage the library can look only', async () => {
    admin.value = false;
    seedLocalLists([cities]);
    wrap(<ListsPage />);
    expect(await screen.findByRole('row', { name: /Cities/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New list' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change Cities' })).toBeNull();
  });
});

describe('A dropdown that reads a shared list', () => {
  const others: FormField[] = [
    { id: 'c', type: 'DROPDOWN', name: 'city', label: 'City' },
    { id: 't', type: 'TEXT', name: 'note', label: 'Note' },
  ];
  function Editor({ spy }: { spy: (d: DataSourceConfig) => void }) {
    const [ds, setDs] = useState<DataSourceConfig>({ type: 'STATIC', options: [{ label: 'A', value: 'A' }] });
    return (
      <DataSourceEditor
        field={{ id: 'b', type: 'DROPDOWN', name: 'branch', label: 'Branch', dataSource: ds }}
        others={others}
        onChange={(next) => {
          spy(next);
          setDs(next);
        }}
      />
    );
  }
  const choose = async (select: string, option: string) => {
    await userEvent.click(screen.getByRole('combobox', { name: select }));
    await userEvent.click(await screen.findByRole('option', { name: option }));
  };

  it('is picked by name, with nothing technical to fill in; a dependent list asks which field holds the choice', async () => {
    seedLocalListSources([
      { key: '/lists/cities', name: 'Cities', params: [], valueField: 'value', labelField: 'label', list: true, dependsOnName: '' },
      { key: '/lists/branches', name: 'Branches', params: ['parent'], valueField: 'value', labelField: 'label', list: true, dependsOnName: 'Cities', description: 'Our branches' },
    ]);
    const spy = vi.fn();
    wrap(<Editor spy={spy} />);
    await choose('Options come from', 'A shared list, or my systems');
    await choose('Which one', 'List: Branches');
    expect(spy.mock.calls.at(-1)![0]).toEqual({ type: 'API', api: expect.objectContaining({ url: '/lists/branches', valueField: 'value', labelField: 'label' }) });
    expect(screen.getByText(/Kept under Lists in the menu/)).toBeInTheDocument();
    // None of the settings a connector needs.
    for (const label of ['URL', 'Value property', 'Label property']) expect(screen.queryByLabelText(label)).toBeNull();
    // Only choice fields can hold the other list's answer.
    await userEvent.click(screen.getByRole('combobox', { name: 'Offer the items for the Cities chosen in' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['City']);
    await userEvent.click(screen.getByRole('option', { name: 'City' }));
    expect(spy.mock.calls.at(-1)![0].api.params).toEqual({ parent: '{{city}}' });
    expect(screen.getByText('The options change when that field changes.')).toBeInTheDocument();
  });
});
