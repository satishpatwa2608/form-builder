import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AutomationAction, FormDefinition } from '../../types';
import { ActionEditor } from './ActionEditor';

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
const people = [
  { uuid: 'u-nia', name: 'Nia', email: 'nia@acme.test' },
  { uuid: 'u-sam', name: 'Sam', email: 'sam@acme.test' },
];
const form = {
  id: 'f',
  orgId: 'o',
  businessId: '',
  name: 'Request',
  code: 'REQ',
  version: 1,
  status: 'DRAFT',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'r', type: 'DROPDOWN', name: 'region', label: 'Region', dataSource: { type: 'STATIC', options: [{ label: 'North', value: 'NORTH' }, { label: 'South', value: 'SOUTH' }] } },
    { id: 'e', type: 'EMAIL', name: 'ownerEmail', label: 'Account owner' },
    { id: 't', type: 'TEXT', name: 'note', label: 'Note' },
  ],
  createdBy: 'u',
  updatedBy: 'u',
} as FormDefinition;

function show() {
  const spy = vi.fn<(a: AutomationAction) => void>();
  function Editor() {
    const [action, setAction] = useState<AutomationAction>({ type: 'ASSIGN', userId: 'u-nia' });
    return (
      <ActionEditor
        form={form}
        action={action}
        people={people}
        customWorkflows={[]}
        onChange={(next) => {
          spy(next);
          setAction(next);
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Editor />
    </QueryClientProvider>,
  );
  return () => spy.mock.calls.at(-1)![0];
}
const choose = async (select: string, option: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: select }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

describe('The Assign step: who gets the record', () => {
  it('by an answer: asks which answer decides, then who gets each of its choices', async () => {
    const last = show();
    expect(screen.getByRole('combobox', { name: 'Who gets it' })).toHaveTextContent('A person I choose now');
    await choose('Who gets it', 'It depends on an answer');
    expect(last()).toEqual({ type: 'ASSIGN', userId: 'u-nia', by: 'ANSWER' });
    // Only fields with a fixed list of choices can decide.
    await userEvent.click(screen.getByRole('combobox', { name: 'Which answer decides' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Region']);
    await userEvent.click(screen.getByRole('option', { name: 'Region' }));
    expect(last()).toMatchObject({ by: 'ANSWER', field: 'region', map: {} });
    for (const label of ['North goes to', 'South goes to', 'Any other answer goes to']) expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('by an email: an email answer of the form, or what an earlier step returned', async () => {
    const last = show();
    await choose('Who gets it', 'The person an answer or an earlier step names');
    // The person chosen before is not carried into a way of choosing that does not use one.
    expect(last()).toEqual({ type: 'ASSIGN', userId: '', by: 'EMAIL' });
    await choose('Whose email it is', 'The answer to "Account owner"');
    expect(last()).toMatchObject({ by: 'EMAIL', from: '{{ownerEmail}}' });
    expect(screen.queryByLabelText('From the step')).toBeNull();
    await choose('Whose email it is', 'What an earlier step returned');
    expect(screen.getByLabelText('From the step')).toHaveValue('{{$steps.}}');
  });

  it('the manager, and back to a person chosen now, keep nothing that does not belong', async () => {
    const last = show();
    await choose('Who gets it', 'The manager of whoever has it');
    expect(last()).toEqual({ type: 'ASSIGN', userId: '', by: 'MANAGER' });
    expect(screen.getByText(/manager of the person it is with when this step runs/)).toBeInTheDocument();
    await choose('Who gets it', 'A person I choose now');
    expect(last()).toEqual({ type: 'ASSIGN', userId: '' });
  });
});
