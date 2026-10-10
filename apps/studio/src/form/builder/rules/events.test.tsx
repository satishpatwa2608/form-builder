import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormDefinition, FormEvent } from '../../types';
import { validateFormDefinition } from '../../engine';
import { publishIssues } from '../publish-issues';
import { FormSettingsPanel } from '../components/FormSettingsPanel';
import { RulesDialog } from './RulesDialog';
import { eventActionOf, eventProblems, newEvent, watchableFields, withTrigger } from './rule-edits';

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

const form = (events?: FormEvent[]): FormDefinition => ({
  id: 'visit-v1',
  orgId: 'org',
  businessId: '',
  name: 'Visit',
  code: 'VISIT',
  version: 1,
  status: 'DRAFT',
  access: 'PUBLIC',
  layout: { mode: 'steps' },
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 's1', type: 'SECTION', name: 'about', label: 'About you' },
    { id: 'f1', type: 'EMAIL', name: 'email', label: 'Email', parentId: 's1' },
    { id: 'f2', type: 'BUTTON', name: 'find', label: 'Find me', parentId: 's1' },
    { id: 's2', type: 'SECTION', name: 'visit', label: 'Your visit' },
    { id: 'f3', type: 'DATE', name: 'visitOn', label: 'Visit on', parentId: 's2' },
    { id: 'f4', type: 'NUMBER', name: 'amount', label: 'Amount', parentId: 's2' },
  ],
  events,
  createdBy: 'u',
  updatedBy: 'u',
});

describe('event edits', () => {
  const { fields } = form();

  it('a new event ends a successful submit with a message', () => {
    expect(newEvent([], fields)).toEqual({ id: 'event_1', name: '', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'SHOW_MESSAGE', message: '' }] });
    expect(newEvent([{ ...newEvent([], fields), id: 'event_2' }], fields).id).toBe('event_3');
  });

  it('changing when it happens keeps the actions that still fit', () => {
    const event: FormEvent = { id: 'e', on: { type: 'CLICK', field: 'find' }, do: [eventActionOf('GO_TO_STEP', fields), eventActionOf('SET_VALUE', fields)] };
    expect(withTrigger(event, 'LOAD', fields)).toEqual({ id: 'e', on: { type: 'LOAD' }, do: [{ type: 'SET_VALUE', target: 'email', value: '' }] });
    expect(withTrigger(event, 'SUBMIT_ERROR', fields).do).toEqual([{ type: 'SHOW_MESSAGE', message: '' }]);
    expect(withTrigger({ ...event, on: { type: 'LOAD' } }, 'CLICK', fields).on).toEqual({ type: 'CLICK', field: 'find' });
  });

  it('"When an answer changes" waits on a question a person answers, and may not change that same answer', () => {
    const made = withTrigger(newEvent([], fields), 'CHANGE', fields);
    expect(made.on).toEqual({ type: 'CHANGE', field: watchableFields(fields)[0]!.name });
    expect(made.do[0]!.type).toBe('FETCH');
    // Buttons and hidden fields are not answers to wait on.
    expect(watchableFields(fields).some((f) => f.type === 'BUTTON' || f.type === 'HIDDEN')).toBe(false);
    const watched = made.on.type === 'CHANGE' ? made.on.field : '';
    const round = { ...made, do: [{ type: 'SET_VALUE' as const, target: watched, value: '1' }] };
    const result = validateFormDefinition({ ...form(), events: [round] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? '' : result.issues)).toContain('the very answer it waits on');
  });

  it('a look-up may fill the rows of a repeating section, and only with that section\'s own questions', () => {
    const base = form();
    const withRows = {
      ...base,
      fields: [
        ...base.fields,
        { id: 'rr', type: 'REPEAT' as const, name: 'lines', label: 'Lines' },
        { id: 'ri', type: 'TEXT' as const, name: 'item', label: 'Item', parentId: 'rr' },
      ],
    };
    const lookup = (rows: { into: string; set: Record<string, string> }): FormEvent => ({ id: 'e', on: { type: 'LOAD' }, do: [{ type: 'FETCH', source: { url: 'orders', method: 'GET' }, set: {}, rows }] });
    const said = (rows: { into: string; set: Record<string, string> }) => {
      const result = validateFormDefinition({ ...withRows, events: [lookup(rows)] });
      return result.success ? '' : JSON.stringify(result.issues);
    };
    // Rows alone are enough: no single field need be filled as well.
    expect(said({ into: 'lines', set: { item: 'name' } })).toBe('');
    expect(said({ into: 'lines', set: {} })).toContain('Choose at least one question of \\"Lines\\" to fill in');
    expect(said({ into: 'lines', set: { email: 'x' } })).toContain('is not a question of');
    expect(said({ into: 'email', set: { item: 'x' } })).toContain('is not a repeating section');
  });

  it('a button may put the cursor somewhere, send the form or start it again; an ending may not', () => {
    const click = (action: FormEvent['do'][number]): FormEvent => ({ id: 'e', on: { type: 'CLICK', field: 'find' }, do: [action] });
    const said = (event: FormEvent) => {
      const result = validateFormDefinition({ ...form(), events: [event] });
      return result.success ? '' : JSON.stringify(result.issues);
    };
    expect(eventActionOf('SUBMIT', fields)).toEqual({ type: 'SUBMIT' });
    expect(eventActionOf('FOCUS', fields)).toEqual({ type: 'FOCUS', target: watchableFields(fields)[0]!.name });
    for (const action of [{ type: 'SUBMIT' as const }, { type: 'RESET' as const }, eventActionOf('FOCUS', fields)]) expect(said(click(action))).toBe('');
    // The cursor goes in a question, not in a button.
    expect(said(click({ type: 'FOCUS', target: 'find' }))).toContain('is not a question the cursor can be put in');
    expect(said({ id: 'e', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'RESET' }] })).toContain('This action does not fit when the event happens');
    // Opening the form may point at a question, and nothing more drastic.
    expect(said({ id: 'e', on: { type: 'LOAD' }, do: [eventActionOf('FOCUS', fields)] })).toBe('');
    expect(said({ id: 'e', on: { type: 'LOAD' }, do: [{ type: 'SUBMIT' }] })).toContain('This action does not fit when the event happens');
  });

  it('reports what stops an event from publishing, per event and in the issues list', () => {
    const def = form([
      { id: 'a', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'REDIRECT', url: 'javascript:alert(1)' }] },
      { id: 'b', on: { type: 'LOAD' }, do: [{ type: 'SET_VALUE', target: 'visitOn', value: 'today()' }] },
    ]);
    expect(eventProblems(def)).toEqual(new Map([[0, ['The address must start with https:// or be a path on this site (/…)']]]));
    expect(publishIssues(def).filter((i) => i.fieldLabel === 'Rules')).toHaveLength(1);
  });
});

function Harness({ initial, readOnly = false, spy }: { initial: FormDefinition; readOnly?: boolean; spy: (f: FormDefinition) => void }) {
  const [def, setDef] = useState(initial);
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RulesDialog
        form={def}
        readOnly={readOnly}
        open
        onOpenChange={() => {}}
        onChange={(changes) =>
          setDef((f) => {
            const next = { ...f, ...changes };
            spy(next);
            return next;
          })
        }
      />
    </QueryClientProvider>
  );
}

const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)![0] as FormDefinition;

async function choose(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, select: string, option: string) {
  await user.click(within(scope).getByRole('combobox', { name: select }));
  await user.click(await screen.findByRole('option', { name: option }));
}

async function openEvents(initial: FormDefinition, readOnly = false) {
  const spy = vi.fn();
  const user = userEvent.setup();
  render(<Harness initial={initial} readOnly={readOnly} spy={spy} />);
  await user.click(screen.getByRole('tab', { name: /Events/ }));
  return { spy, user };
}

describe('RulesDialog — events', () => {
  it('builds a conditional ending for a successful submit', async () => {
    const { spy, user } = await openEvents(form());
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add event/ }));
    const card = screen.getByRole('region', { name: 'Event 1' });
    await user.type(within(card).getByLabelText('Event name'), 'Large claims');
    await choose(user, card, 'Runs', 'Only when a formula is true');
    await user.type(within(card).getByLabelText('Condition formula'), 'amount > 5000');
    await user.type(within(card).getByLabelText('Message'), 'A manager will call you.');

    expect(last(spy).events).toEqual([
      { id: 'event_1', name: 'Large claims', on: { type: 'SUBMIT_SUCCESS' }, when: { expr: 'amount > 5000' }, do: [{ type: 'SHOW_MESSAGE', message: 'A manager will call you.' }] },
    ]);
    expect(validateFormDefinition(last(spy)).success).toBe(true);
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('builds a button that fills a date and opens a step', async () => {
    const { spy, user } = await openEvents(form());
    await user.click(screen.getByRole('button', { name: /Add event/ }));
    const card = screen.getByRole('region', { name: 'Event 1' });
    await choose(user, card, 'Happens', 'When a button is clicked');
    expect(within(card).getByRole('combobox', { name: 'Button' })).toHaveTextContent('Find me');
    await choose(user, card, 'Field', 'Visit on');
    await user.type(within(card).getByLabelText('Formula'), 'today()');
    await user.click(within(card).getByRole('button', { name: /Add action/ }));
    await user.click(within(card).getAllByRole('combobox', { name: 'Action' })[1]);
    await user.click(await screen.findByRole('option', { name: 'Go to step' }));
    await choose(user, card, 'Step', 'Your visit');

    expect(last(spy).events).toEqual([
      {
        id: 'event_1',
        name: '',
        on: { type: 'CLICK', field: 'find' },
        do: [
          { type: 'SET_VALUE', target: 'visitOn', value: 'today()' },
          { type: 'GO_TO_STEP', step: 'visit' },
        ],
      },
    ]);
    expect(validateFormDefinition(last(spy)).success).toBe(true);
  });

  it('edits what a look-up sends and which fields it fills', async () => {
    const lookup: FormEvent = { id: 'e', name: 'Find', on: { type: 'CLICK', field: 'find' }, do: [{ type: 'FETCH', source: { url: 'customers', method: 'GET' }, set: {} }] };
    const { spy, user } = await openEvents(form([lookup]));
    const card = screen.getByRole('region', { name: 'Find' });
    expect(within(card).getByRole('alert')).toHaveTextContent('Choose at least one field to fill in');

    const send = within(card).getByRole('group', { name: 'Send' });
    await user.click(within(send).getByRole('button', { name: /Add/ }));
    await user.type(within(send).getByLabelText('Parameter'), 'email');
    await user.type(within(send).getByLabelText('{{fieldName}} or a fixed value'), '{{{{email}}');
    await choose(user, card, 'Add a field to fill in', 'Amount');
    await user.type(within(card).getByLabelText('Property for amount'), 'balance.due');

    expect(last(spy).events![0].do).toEqual([
      { type: 'FETCH', source: { url: 'customers', method: 'GET', params: { email: '{{email}}' } }, set: { amount: 'balance.due' } },
    ]);
    expect(validateFormDefinition(last(spy)).success).toBe(true);
  });

  it('switches an event off and deletes it; a published form cannot change them', async () => {
    const event: FormEvent = { id: 'e', name: 'Thanks', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'SHOW_MESSAGE', message: 'Bye' }] };
    const { spy, user } = await openEvents(form([event]));
    await user.click(screen.getByRole('switch', { name: 'Event is on' }));
    expect(last(spy).events![0].disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Delete Thanks' }));
    expect(last(spy).events).toEqual([]);
  });

  it('is read-only on a published form', async () => {
    const event: FormEvent = { id: 'e', name: 'Thanks', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'SHOW_MESSAGE', message: 'Bye' }] };
    await openEvents(form([event]), true);
    expect(screen.getByLabelText('Message')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Add event/ })).not.toBeInTheDocument();
  });
});

describe('form settings — time zone', () => {
  it('sets, warns about and clears the zone', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    function Panel() {
      const [def, setDef] = useState(form());
      return (
        <FormSettingsPanel
          form={def}
          readOnly={false}
          codeLocked={false}
          onChange={(changes) =>
            setDef((f) => {
              const next = { ...f, ...changes };
              spy(next);
              return next;
            })
          }
        />
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Panel />
      </QueryClientProvider>,
    );
    const zone = screen.getByLabelText('Time zone');
    await user.type(zone, 'Asia/Kolk');
    expect(screen.getByText(/Not a time zone yet/)).toBeInTheDocument();
    await user.type(zone, 'ata');
    expect(last(spy).timeZone).toBe('Asia/Kolkata');
    expect(screen.queryByText(/Not a time zone yet/)).not.toBeInTheDocument();
    await user.clear(zone);
    expect(last(spy).timeZone).toBeUndefined();
  });
});

describe('form settings — look and feel', () => {
  it('corners and room between questions are chosen from a list, and choosing the default takes the choice away', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    function Panel() {
      const [def, setDef] = useState(form());
      return (
        <FormSettingsPanel
          form={def}
          readOnly={false}
          codeLocked={false}
          onChange={(changes) =>
            setDef((f) => {
              const next = { ...f, ...changes };
              spy(next);
              return next;
            })
          }
        />
      );
    }
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Panel />
      </QueryClientProvider>,
    );
    const theme = () => (spy.mock.calls.at(-1)![0] as FormDefinition).theme;
    await user.click(screen.getByRole('combobox', { name: 'Corners' }));
    await user.click(await screen.findByRole('option', { name: 'Very round' }));
    expect(theme()).toMatchObject({ corners: 'pill' });
    await user.click(screen.getByRole('combobox', { name: 'Room between questions' }));
    await user.click(await screen.findByRole('option', { name: 'Compact' }));
    expect(theme()).toMatchObject({ corners: 'pill', spacing: 'compact' });
    expect(validateFormDefinition(spy.mock.calls.at(-1)![0]).success).toBe(true);
    await user.click(screen.getByRole('combobox', { name: 'Corners' }));
    await user.click(await screen.findByRole('option', { name: 'Form Builder default' }));
    expect(theme()?.corners).toBeUndefined();
  });
});
