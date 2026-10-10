import { describe, expect, it } from 'vitest';
import { buildFormCss, buildLayoutIndex, buildPayload, buildSteps, buildZodSchema, childrenOf, computeFieldStates, descendantFields, namesWithin, ROOT, styleToCss, validateFormDefinition } from '../src';
import { fixtureDefinitions } from './fixtures';
import type { FormField, FormStyle } from '../src/types';

const f = (x: Partial<FormField> & Pick<FormField, 'id' | 'type'>): FormField => ({ name: x.id, ...x });

const fields: FormField[] = [
  f({ id: 'cols', type: 'COLUMNS', props: { columns: [1, 1] } }),
  f({ id: 'left', type: 'TEXT', label: 'Left', parentId: 'cols', column: 0, required: true }),
  f({ id: 'right', type: 'TEXT', label: 'Right', parentId: 'cols', column: 1 }),
  f({ id: 'toggle', type: 'CHECKBOX', label: 'More' }),
  f({ id: 'sec', type: 'SECTION', label: 'More', visibility: { when: { field: 'toggle', operator: 'equals', value: true } } }),
  f({ id: 'inner', type: 'TEXT', label: 'Inner', parentId: 'sec', column: 0, required: true }),
  f({ id: 'orphan', type: 'TEXT', label: 'Orphan', parentId: 'gone' }),
];

describe('layout index', () => {
  it('places fields by parent and column, falling back to root for dangling parents', () => {
    const index = buildLayoutIndex(fields);
    expect(childrenOf(index, ROOT).map((x) => x.id)).toEqual(['cols', 'toggle', 'sec', 'orphan']);
    expect(childrenOf(index, 'cols', 0).map((x) => x.id)).toEqual(['left']);
    expect(childrenOf(index, 'cols', 1).map((x) => x.id)).toEqual(['right']);
    expect(descendantFields(fields, 'sec').map((x) => x.id)).toEqual(['inner']);
  });

  it('builds steps from top-level sections, grouping loose fields', () => {
    const steps = buildSteps(fields);
    expect(steps.map((s) => s.title)).toEqual(['Details', 'More', 'Details']);
    expect(steps[0].items.map((x) => x.id)).toEqual(['cols', 'toggle']);
    expect([...namesWithin(fields, steps[0].items)]).toEqual(['cols', 'left', 'right', 'toggle']);
  });
});

describe('containers and validation', () => {
  it('hiding a section hides - and stops requiring - everything inside it', () => {
    const states = computeFieldStates({ fields }, { toggle: false });
    expect(states.get('inner')).toEqual({ visible: false, required: false });
    const errors = (values: Record<string, unknown>) => {
      const r = buildZodSchema({ fields }).safeParse(values);
      return r.success ? [] : r.error.issues.map((i) => String(i.path[0]));
    };
    expect(errors({ left: 'x', toggle: false, inner: '' })).toEqual([]);
    expect(errors({ left: 'x', toggle: true, inner: '' })).toEqual(['inner']);
    expect(errors({ left: '', toggle: false })).toEqual(['left']);
  });

  it('the payload stays flat and never includes containers', () => {
    const payload = buildPayload({ fields, submission: { method: 'POST', endpointId: 'e' } }, { left: 'L', right: 'R', toggle: false, inner: 'I' });
    expect(payload).toEqual({ left: 'L', right: 'R', toggle: false });
  });

  it('the validator checks parents, columns and nesting loops', () => {
    const base = fixtureDefinitions[0];
    const bad = {
      ...base,
      fields: [
        f({ id: 'a', type: 'TEXT', label: 'A', parentId: 'nope' }),
        f({ id: 'b', type: 'TEXT', label: 'B', parentId: 'a' }),
        f({ id: 'c', type: 'COLUMNS', props: { columns: [1, 1] } }),
        f({ id: 'd', type: 'TEXT', label: 'D', parentId: 'c', column: 5 }),
        f({ id: 's1', type: 'SECTION', parentId: 's2' }),
        f({ id: 's2', type: 'SECTION', parentId: 's1' }),
      ],
    };
    const r = validateFormDefinition(bad);
    const messages = r.success ? [] : r.issues.map((i) => i.message);
    expect(messages).toContain('Is inside a container that no longer exists');
    expect(messages).toContain('"a" is not a Columns or Section block');
    expect(messages).toContain('"c" has no column 6');
    expect(messages).toContain('Containers are nested inside each other in a loop');
  });

  it('the supplier fixture (steps + columns + styles) is publishable', () => {
    expect(validateFormDefinition(fixtureDefinitions.find((d) => d.code === 'SUPPLIER_REGISTRATION')).success).toBe(true);
  });
});

describe('style CSS', () => {
  const style: FormStyle = {
    id: 'box',
    name: 'Box',
    props: { backgroundColor: '#eff6ff', borderWidth: 99, padding: -4, fontWeight: 700, labelColor: '#123456' },
  };

  it('emits whitelisted, clamped CSS scoped to the form', () => {
    const css = styleToCss('.scope', style);
    expect(css).toContain('.scope .fps-box{background-color:#eff6ff;border-style:solid;border-width:8px;padding:0px;font-weight:700}');
    expect(css).toContain('.scope .fps-box [data-slot="form-label"],.scope .fps-box label{color:#123456}');
  });

  it('a theme sets the colour of mistakes, the corners and the room between questions from fixed choices', () => {
    const css = buildFormCss('.scope', { errorColor: '#b91c1c', corners: 'pill', spacing: 'roomy' }, []);
    expect(css).toContain('--destructive:#b91c1c');
    expect(css).toContain('--radius:22px');
    expect(css).toContain('.scope .fp-grid{gap:34px 22px}');
    // On a phone, roomy gives way: there is no room to spare.
    expect(css).toContain('@media (max-width:640px){.scope .fp-grid{gap:18px 12px}}');
    // Anything that is not one of the choices, or not a colour, is left out, not written into the page.
    const evil = buildFormCss('.scope', { errorColor: 'red;}body{display:none', corners: '0;position:fixed' as never, spacing: 'x' as never }, []);
    expect(evil).toBe('');
    expect(buildFormCss('.scope', {}, [])).toBe('');
  });

  it('drops anything that is not a valid value - no CSS injection', () => {
    const evil: FormStyle = {
      id: 'x;}body{display:none',
      name: 'Evil',
      props: { textColor: 'red;}body{display:none', backgroundColor: 'url(https://evil.test/x.png)', textAlign: 'left;position:fixed' as never },
    };
    const css = styleToCss('.scope', evil);
    expect(css).not.toMatch(/body|url\(|position|display/);
    expect(css).toBe('');
  });

  it('themes set brand variables and font on the form root only', () => {
    const css = buildFormCss('.scope', { primaryColor: '#0f766e', fontFamily: 'serif', backgroundColor: 'nope' }, []);
    expect(css).toContain('.scope{--primary:#0f766e;--ring:#0f766e;font-family:Georgia');
    expect(css).not.toContain('background-color');
  });
});
