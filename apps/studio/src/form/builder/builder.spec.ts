import { beforeEach, describe, expect, it } from 'vitest';
import { useFormBuilderStore } from './store/useFormBuilderStore';
import { createField, DEFAULT_CAPTCHA_CONFIG, PALETTE_GROUPS, uniqueFieldName } from './field-catalog';
import { fieldsReferencing, moveItem, renameFieldReferences, rulesReferencing } from './definition-edits';
import { createBlankForm, suggestCode } from './blank-form';
import { publishIssues } from './publish-issues';
import { validateFormDefinition } from '../engine';
import type { FormDefinition } from '../types';

const blank = (): FormDefinition =>
  createBlankForm({ name: 'Test Form', code: 'TEST_FORM', businessId: 'B1', access: 'PUBLIC' }, { orgId: 'O1', uuid: 'u1' });

const state = () => useFormBuilderStore.getState();

describe('field catalog', () => {
  it('every available palette type creates a field a form can publish with', () => {
    const available = PALETTE_GROUPS.flatMap((g) => g.items).filter((i) => !i.unavailable);
    for (const item of available) {
      const text = createField('TEXT', []);
      text.label = 'Anchor';
      const field = createField(item.type, [text.name]);
      // The store adds form-level CAPTCHA settings along with a CAPTCHA field.
      const form = { ...blank(), fields: [text, field], ...(item.type === 'CAPTCHA' ? { captcha: { ...DEFAULT_CAPTCHA_CONFIG } } : {}) };
      const result = validateFormDefinition(form, 'publish');
      expect(result.success, `${item.type}: ${JSON.stringify(!result.success && result.issues)}`).toBe(true);
    }
  });

  it('names fields uniquely', () => {
    expect(uniqueFieldName('TEXT', [])).toBe('text_1');
    expect(uniqueFieldName('TEXT', ['text_1', 'text_2'])).toBe('text_3');
  });

  it('suggests codes from names', () => {
    expect(suggestCode('  Customer complaint - v2 ')).toBe('CUSTOMER_COMPLAINT_V2');
  });
});

describe('definition edits', () => {
  it('renaming a field rewrites rules, dependencies, params and mapping', () => {
    const form: FormDefinition = {
      ...blank(),
      fields: [
        { id: '1', type: 'TEXT', name: 'category', label: 'Category' },
        {
          id: '2',
          type: 'TEXT',
          name: 'product',
          label: 'Product',
          visibility: { when: { all: [{ field: 'category', operator: 'equals', value: 'P' }] } },
          requiredWhen: { field: 'category', operator: 'isNotEmpty' },
          dependency: { dependsOn: ['category'] },
          dataSource: { type: 'API', api: { url: '/x', method: 'GET', valueField: 'id', labelField: 'n', params: { c: '{{category}}' } } },
        },
      ],
      submission: { method: 'POST', endpointId: 'e', mapping: { category: 'complaintCategory' } },
    };
    const next = renameFieldReferences(form, 'category', 'kind');
    const product = next.fields[1];
    expect(product.visibility).toEqual({ when: { all: [{ field: 'kind', operator: 'equals', value: 'P' }] } });
    expect(product.requiredWhen).toEqual({ field: 'kind', operator: 'isNotEmpty' });
    expect(product.dependency?.dependsOn).toEqual(['kind']);
    expect(product.dataSource?.api?.params).toEqual({ c: '{{kind}}' });
    expect(next.submission.mapping).toEqual({ kind: 'complaintCategory' });
  });

  it('renaming a field carries through form rules, and rules that use a field are found', () => {
    const form: FormDefinition = {
      ...blank(),
      fields: [
        { id: '1', type: 'NUMBER', name: 'qty', label: 'Quantity' },
        { id: '2', type: 'NUMBER', name: 'price', label: 'Price' },
        { id: '3', type: 'NUMBER', name: 'total', label: 'Total' },
        { id: '4', type: 'TEXT', name: 'note', label: 'Note' },
      ],
      rules: [
        { id: 'a', then: [{ type: 'SET_VALUE', target: 'total', value: 'qty * price' }] },
        { id: 'b', when: { expr: 'qty > 10' }, then: [{ type: 'REQUIRE', target: 'note' }], else: [{ type: 'HIDE', target: 'qty' }] },
        { id: 'c', when: { field: 'qty', operator: 'isEmpty' }, then: [{ type: 'ERROR', target: 'price', message: 'qty first' }] },
        { id: 'd', then: [{ type: 'SHOW', target: 'note' }] },
      ],
    };
    expect(rulesReferencing(form, 'qty').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(rulesReferencing(form, 'total').map((r) => r.id)).toEqual(['a']);

    const next = renameFieldReferences(form, 'qty', 'quantity');
    expect(next.rules).toEqual([
      { id: 'a', then: [{ type: 'SET_VALUE', target: 'total', value: 'quantity * price' }] },
      { id: 'b', when: { expr: 'quantity > 10' }, then: [{ type: 'REQUIRE', target: 'note' }], else: [{ type: 'HIDE', target: 'quantity' }] },
      { id: 'c', when: { field: 'quantity', operator: 'isEmpty' }, then: [{ type: 'ERROR', target: 'price', message: 'qty first' }] },
      { id: 'd', then: [{ type: 'SHOW', target: 'note' }] },
    ]);
    expect(rulesReferencing(next, 'qty')).toEqual([]);

    const withEvents: FormDefinition = {
      ...form,
      fields: [...form.fields, { id: '5', type: 'BUTTON', name: 'go', label: 'Go' }],
      events: [
        {
          id: 'e',
          on: { type: 'CLICK', field: 'go' },
          when: { expr: 'qty > 0' },
          do: [
            { type: 'SET_VALUE', target: 'qty', value: 'qty + 1' },
            { type: 'FETCH', source: { url: 'stock', method: 'GET', params: { q: '{{qty}}', fixed: 'x' } }, set: { qty: 'onHand', note: 'remark' } },
          ],
        },
      ],
    };
    expect(renameFieldReferences(renameFieldReferences(withEvents, 'qty', 'quantity'), 'go', 'lookup').events).toEqual([
      {
        id: 'e',
        on: { type: 'CLICK', field: 'lookup' },
        when: { expr: 'quantity > 0' },
        do: [
          { type: 'SET_VALUE', target: 'quantity', value: 'quantity + 1' },
          { type: 'FETCH', source: { url: 'stock', method: 'GET', params: { q: '{{quantity}}', fixed: 'x' } }, set: { quantity: 'onHand', note: 'remark' } },
        ],
      },
    ]);
    // A form with no rules does not grow an empty list.
    expect(renameFieldReferences(blank(), 'a', 'b')).not.toHaveProperty('rules');
  });

  it('moveItem and fieldsReferencing', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    const form: FormDefinition = {
      ...blank(),
      fields: [
        { id: '1', type: 'TEXT', name: 'a', label: 'A' },
        { id: '2', type: 'TEXT', name: 'b', label: 'B', visibility: { when: { field: 'a', operator: 'isEmpty' } } },
      ],
    };
    expect(fieldsReferencing(form, 'a').map((f) => f.name)).toEqual(['b']);
  });
});

describe('useFormBuilderStore', () => {
  beforeEach(() => state().load(blank()));

  it('tabs and accordions start with two sections and take sections only', () => {
    const tabs = state().addField('TABS');
    const inside = () => state().form!.fields.filter((f) => f.parentId === tabs);
    expect(inside().map((f) => [f.type, f.label])).toEqual([['SECTION', 'Tab 1'], ['SECTION', 'Tab 2']]);
    expect(new Set(state().form!.fields.map((f) => f.name)).size).toBe(3);

    expect(state().addField('TEXT', { parentId: tabs, column: 0 })).toBe('');
    expect(inside()).toHaveLength(2);
    expect(state().addField('SECTION', { parentId: tabs, column: 0 })).not.toBe('');
    expect(inside()).toHaveLength(3);

    // A field goes inside one of the sections, and cannot be dragged out onto the tab strip.
    const text = state().addField('TEXT', { parentId: inside()[0].id, column: 0 });
    state().moveField(text, { parentId: tabs, column: 0 });
    expect(state().form!.fields.find((f) => f.id === text)!.parentId).toBe(inside()[0].id);

    const accordion = state().addField('ACCORDION');
    expect(state().form!.fields.filter((f) => f.parentId === accordion).map((f) => f.label)).toEqual(['Panel 1', 'Panel 2']);
    expect(validateFormDefinition(state().form, 'publish').success).toBe(true);
  });

  it('retyping a field key never merges its rules with another field\'s', () => {
    const a = state().addField('NUMBER');
    const ab = state().addField('NUMBER');
    const total = state().addField('NUMBER');
    state().updateField(a, { name: 'a' });
    state().updateField(ab, { name: 'ab' });
    state().updateField(total, { name: 'total' });
    state().updateForm({ rules: [{ id: 'r', then: [{ type: 'SET_VALUE', target: 'total', value: 'a + ab' }] }] });
    const formula = () => (state().form!.rules![0].then[0] as { value: string }).value;

    // Clear the key of "ab" and type "a", "ac", "acc": it passes through empty and through another field's key.
    for (const name of ['', 'a', 'ac', 'acc']) state().updateField(ab, { name });
    expect(formula()).toBe('a + acc');

    // The other field renames normally afterwards, and so does this one again.
    state().updateField(a, { name: 'first' });
    state().updateField(ab, { name: 'second' });
    expect(formula()).toBe('first + second');
    expect(state().form!.rules![0].then[0]).toMatchObject({ target: 'total' });
  });

  it('a key left clashing keeps the rules pointing at the old name', () => {
    const a = state().addField('NUMBER');
    const b = state().addField('NUMBER');
    state().updateField(a, { name: 'a' });
    state().updateField(b, { name: 'b' });
    state().updateForm({ rules: [{ id: 'r', when: { expr: 'b > 1' }, then: [{ type: 'REQUIRE', target: 'a' }] }] });
    state().updateField(b, { name: 'a' });
    expect(state().form!.rules![0]).toMatchObject({ when: { expr: 'b > 1' }, then: [{ type: 'REQUIRE', target: 'a' }] });
  });

  it('adds fields at an index and selects the new one', () => {
    const first = state().addField('TEXT');
    const second = state().addField('EMAIL', 0);
    expect(state().form!.fields.map((f) => f.id)).toEqual([second, first]);
    expect(state().selectedFieldId).toBe(second);
    expect(state().isDirty).toBe(true);
  });

  it('duplicates with a new id and a unique name, right after the source', () => {
    const id = state().addField('TEXT');
    state().duplicateField(id);
    const [a, b] = state().form!.fields;
    expect(b.id).not.toBe(a.id);
    expect(b.name).toBe('text_2');
    expect(b.label).toBe('Text (copy)');
  });

  it('renaming through updateField rewrites references', () => {
    const a = state().addField('TEXT');
    const b = state().addField('TEXT');
    state().updateField(b, { visibility: { when: { field: 'text_1', operator: 'isNotEmpty' } } });
    state().updateField(a, { name: 'reason' });
    const fb = state().form!.fields.find((f) => f.id === b)!;
    expect(fb.visibility?.when).toEqual({ field: 'reason', operator: 'isNotEmpty' });
  });

  it('removes and reorders; removing the selected field clears the selection', () => {
    const a = state().addField('TEXT');
    const b = state().addField('NUMBER');
    state().reorderFields(1, 0);
    expect(state().form!.fields.map((f) => f.id)).toEqual([b, a]);
    state().selectField(a);
    state().removeField(a);
    expect(state().form!.fields.map((f) => f.id)).toEqual([b]);
    expect(state().selectedFieldId).toBeUndefined();
  });

  it('undo / redo walk the history; typing into one setting is one step', () => {
    const id = state().addField('TEXT');
    state().updateField(id, { label: 'N' });
    state().updateField(id, { label: 'Na' });
    state().updateField(id, { label: 'Name' });
    state().undo();
    expect(state().form!.fields[0].label).toBe('Text');
    state().undo();
    expect(state().form!.fields).toHaveLength(0);
    state().redo();
    state().redo();
    expect(state().form!.fields[0].label).toBe('Name');
  });

  it('CAPTCHA: one per form, brings form settings, removing it drops them', () => {
    const id = state().addField('CAPTCHA');
    expect(state().form!.captcha).toMatchObject({ enabled: true, provider: 'RECAPTCHA' });
    expect(state().form!.fields[0].name).toBe('captchaToken');
    expect(state().addField('CAPTCHA')).toBe('');
    state().duplicateField(id);
    expect(state().form!.fields).toHaveLength(1);
    state().removeField(id);
    expect(state().form!.captcha).toBeUndefined();
  });

  it('markSaved clears dirty; load clears history', () => {
    state().addField('TEXT');
    state().markSaved(state().form!);
    expect(state().isDirty).toBe(false);
    expect(state().past.length).toBe(1);
    state().load(blank());
    expect(state().past.length).toBe(0);
  });
});

describe('publishIssues', () => {
  it('attributes issues to fields and flags empty forms', () => {
    expect(publishIssues(blank()).map((i) => i.message)).toContain('Add at least one field for people to fill in');
    const form: FormDefinition = { ...blank(), fields: [{ id: 'x', type: 'TEXT', name: 'x' }] };
    expect(publishIssues(form)).toEqual([{ message: '"x" needs a label', fieldId: 'x', fieldLabel: 'x' }]);
  });
});
