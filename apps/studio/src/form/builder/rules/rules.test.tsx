import { useState } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FormDefinition, FormRule } from '../../types';
import { computeFormState, validateFormDefinition } from '../../engine';
import { publishIssues } from '../publish-issues';
import { RulesDialog } from './RulesDialog';
import { actionOf, conditionMode, newRule, ruleProblems, targetsFor, withConditionMode } from './rule-edits';

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

const sizes = ['Small', 'Large'].map((label) => ({ label, value: label.toUpperCase() }));
const form = (rules?: FormRule[]): FormDefinition => ({
  id: 'expense-v1',
  orgId: 'org',
  businessId: '',
  name: 'Expense claim',
  code: 'EXPENSE',
  version: 1,
  status: 'DRAFT',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'f0', type: 'HIDDEN', name: 'orgRef', systemSource: 'ORG_ID' },
    { id: 'f1', type: 'NUMBER', name: 'quantity', label: 'Quantity' },
    { id: 'f2', type: 'NUMBER', name: 'unitPrice', label: 'Unit price' },
    { id: 'f3', type: 'NUMBER', name: 'total', label: 'Total' },
    { id: 'f4', type: 'SECTION', name: 'approval', label: 'Approval' },
    { id: 'f5', type: 'TEXT', name: 'approver', label: 'Approver', parentId: 'f4' },
    { id: 'f6', type: 'RADIO', name: 'size', label: 'Size', dataSource: { type: 'STATIC', options: sizes } },
    { id: 'f7', type: 'FILE', name: 'receipt', label: 'Receipt' },
  ],
  rules,
  createdBy: 'u',
  updatedBy: 'u',
});

describe('rule edits', () => {
  const { fields } = form();
  const names = (type: Parameters<typeof targetsFor>[0]) => targetsFor(type, fields).map((f) => f.name);

  it('offers only the fields each action can act on', () => {
    expect(names('SHOW')).toEqual(['quantity', 'unitPrice', 'total', 'approval', 'approver', 'size', 'receipt']);
    expect(names('REQUIRE')).toEqual(['quantity', 'unitPrice', 'total', 'approver', 'size', 'receipt']);
    expect(names('SET_VALUE')).toEqual(['quantity', 'unitPrice', 'total', 'approver', 'size']);
    expect(names('SET_OPTIONS')).toEqual(['size']);
  });

  it('keeps the target when the action type changes, if it still fits', () => {
    expect(actionOf('SET_VALUE', fields, 'total')).toEqual({ type: 'SET_VALUE', target: 'total', value: '' });
    expect(actionOf('SET_OPTIONS', fields, 'total')).toEqual({ type: 'SET_OPTIONS', target: 'size', values: [] });
    expect(actionOf('ERROR', fields, 'approval')).toEqual({ type: 'ERROR', target: 'quantity', message: '' });
  });

  it('new rules get a free id and a starting condition', () => {
    const first = newRule([], fields);
    expect(first).toMatchObject({ id: 'rule_1', then: [{ type: 'SHOW', target: 'quantity' }] });
    expect(newRule([first, { ...first, id: 'rule_3' }], fields).id).toBe('rule_4');
  });

  it('switching to "always" drops the condition and the otherwise branch', () => {
    const rule: FormRule = { id: 'r', when: { expr: 'total > 1' }, then: [{ type: 'SHOW', target: 'approver' }], else: [{ type: 'HIDE', target: 'size' }] };
    expect(conditionMode(rule)).toBe('formula');
    expect(withConditionMode(rule, 'always', fields)).toEqual({ id: 'r', then: rule.then });
    expect(conditionMode(withConditionMode(rule, 'conditions', fields))).toBe('conditions');
    expect(withConditionMode(rule, 'formula', fields)).toBe(rule);
  });

  it('reports what stops a rule from publishing, per rule, and in the builder issues list', () => {
    const def = form([
      { id: 'a', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity * price' }] },
      { id: 'b', then: [{ type: 'SET_VALUE', target: 'quantity', value: 'quantity + 1' }] },
    ]);
    const problems = ruleProblems(def);
    expect(problems.get(0)).toEqual(['Refers to unknown field "price"']);
    expect(problems.get(-1)).toEqual(['Calculations loop: quantity -> quantity']);
    expect(publishIssues(def).filter((i) => i.fieldLabel === 'Rules')).toHaveLength(2);
    expect(ruleProblems(form([{ id: 'a', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity * unitPrice' }] }])).size).toBe(0);
  });
});

function Harness({ initial, readOnly = false, spy }: { initial: FormDefinition; readOnly?: boolean; spy: (f: FormDefinition) => void }) {
  const [def, setDef] = useState(initial);
  return (
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
  );
}

const last = (spy: ReturnType<typeof vi.fn>) => (spy.mock.calls.at(-1)![0] as FormDefinition).rules!;

async function choose(user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, select: string, option: string) {
  await user.click(within(scope).getByRole('combobox', { name: select }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('RulesDialog', () => {
  it('builds a calculation that publishes', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={form()} spy={spy} />);
    expect(screen.getByText(/No rules yet/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Add rule/ }));
    const card = screen.getByRole('region', { name: 'Rule 1' });
    await user.type(within(card).getByLabelText('Rule name'), 'Line total');
    await choose(user, card, 'When', 'Always');
    await choose(user, card, 'Action', 'Set the value of');
    await choose(user, card, 'Field', 'Total');
    await user.type(within(card).getByLabelText('Formula'), 'quantity * unitPrice');

    expect(last(spy)).toEqual([{ id: 'rule_1', name: 'Line total', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity * unitPrice' }] }]);
    expect(validateFormDefinition(spy.mock.calls.at(-1)![0]).success).toBe(true);
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    // "Always" has nothing to fall back to.
    expect(within(card).queryByRole('group', { name: 'Otherwise' })).not.toBeInTheDocument();
  });

  it('"Clear the answer to" needs no formula, publishes, and really empties the answer while the rule holds', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={form()} spy={spy} />);
    await user.click(screen.getByRole('button', { name: /Add rule/ }));
    const card = screen.getByRole('region', { name: 'Rule 1' });
    await choose(user, card, 'When', 'Always');
    await choose(user, card, 'Action', 'Clear the answer to');
    await choose(user, card, 'Field', 'Approver');
    // Nothing to type: the choice says it all.
    expect(within(card).queryByLabelText('Formula')).not.toBeInTheDocument();
    expect(within(card).getByText(/Emptied for as long as this rule holds/)).toBeInTheDocument();
    expect(within(card).getByRole('combobox', { name: 'Action' })).toHaveTextContent('Clear the answer to');
    const made = spy.mock.calls.at(-1)![0] as FormDefinition;
    expect(made.rules![0]!.then).toEqual([{ type: 'SET_VALUE', target: 'approver', value: 'null' }]);
    expect(validateFormDefinition(made).success).toBe(true);
    expect(computeFormState(made, { approver: 'Asha', quantity: 2 }).values).toMatchObject({ approver: '', quantity: 2 });
  });

  it('builds a formula condition with then and otherwise actions', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={form()} spy={spy} />);
    await user.click(screen.getByRole('button', { name: /Add rule/ }));
    const card = screen.getByRole('region', { name: 'Rule 1' });
    await choose(user, card, 'When', 'When a formula is true');
    await user.type(within(card).getByLabelText('Condition formula'), 'total > 5000');
    const then = within(card).getByRole('group', { name: 'Then' });
    await choose(user, then, 'Field', 'Approval');
    await user.click(within(then).getByRole('button', { name: /Add action/ }));
    const second = within(then).getAllByRole('combobox', { name: 'Action' })[1];
    await user.click(second);
    await user.click(await screen.findByRole('option', { name: 'Show an error on' }));
    await user.type(within(then).getByLabelText('Error message'), 'Needs approval');

    const otherwise = within(card).getByRole('group', { name: 'Otherwise' });
    await user.click(within(otherwise).getByRole('button', { name: /Add action/ }));
    await choose(user, otherwise, 'Action', 'Limit the options of');
    await user.click(within(otherwise).getByRole('checkbox', { name: 'Small' }));

    expect(last(spy)).toEqual([
      {
        id: 'rule_1',
        name: '',
        when: { expr: 'total > 5000' },
        then: [
          { type: 'SHOW', target: 'approval' },
          { type: 'ERROR', target: 'quantity', message: 'Needs approval' },
        ],
        else: [{ type: 'SET_OPTIONS', target: 'size', values: ['SMALL'] }],
      },
    ]);
    expect(validateFormDefinition(spy.mock.calls.at(-1)![0]).success).toBe(true);
  });

  it('says what is wrong with a formula as it is typed', async () => {
    const user = userEvent.setup();
    render(<Harness initial={form([{ id: 'r', name: 'Total', then: [{ type: 'SET_VALUE', target: 'total', value: '' }] }])} spy={vi.fn()} />);
    const formula = screen.getByLabelText('Formula');
    await user.type(formula, 'quantity * price');
    expect(screen.getAllByText('Refers to unknown field "price"').length).toBeGreaterThan(0);
    await user.clear(formula);
    await user.type(formula, 'launch(quantity)');
    expect(screen.getAllByText('Unknown function "launch"').length).toBeGreaterThan(0);
  });

  it('switches a rule off, and deletes it', async () => {
    const spy = vi.fn();
    const user = userEvent.setup();
    render(<Harness initial={form([{ id: 'r', name: 'Total', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity' }] }])} spy={spy} />);
    await user.click(screen.getByRole('switch', { name: 'Rule is on' }));
    expect(last(spy)[0].disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Delete Total' }));
    expect(last(spy)).toEqual([]);
  });

  it('a published form shows its rules but cannot change them', () => {
    render(<Harness readOnly initial={form([{ id: 'r', name: 'Total', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity' }] }])} spy={vi.fn()} />);
    expect(screen.getByLabelText('Formula')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Add rule/ })).not.toBeInTheDocument();
  });
});
