import { describe, expect, it, vi } from 'vitest';
import { validateFormDefinition } from '@fb/engine';
import { FORM_TEMPLATES, linkTemplateFragments, prepareTemplate } from './index';

const supplier = FORM_TEMPLATES.find((t) => t.key === 'supplier')!.definition;
const usesHighlight = (def: Record<string, unknown>) => (def.fields as { styleId?: string }[]).some((f) => f.styleId === 'highlight-box');

describe('creating a form from a template', () => {
  it("adds the template's own style to a library that lacks it, and keeps it on the form", async () => {
    const add = vi.fn(async (_style: { id: string; name: string }) => undefined);
    const { definition, leftOut } = await prepareTemplate(supplier, { existing: async () => [], add });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({ id: 'highlight-box', name: 'Highlight box' });
    expect(leftOut).toEqual([]);
    expect(usesHighlight(definition)).toBe(true);
    // The form is created without an embedded copy: publishing takes the library's.
    expect(definition).not.toHaveProperty('styles');
  });

  it('adds nothing when the library already has the style', async () => {
    const add = vi.fn(async () => undefined);
    const { definition } = await prepareTemplate(supplier, { existing: async () => ['highlight-box'], add });
    expect(add).not.toHaveBeenCalled();
    expect(usesHighlight(definition)).toBe(true);
  });

  it('when adding the style is refused, makes the form without it and says which', async () => {
    const { definition, leftOut } = await prepareTemplate(supplier, { existing: async () => [], add: async () => Promise.reject(new Error('Forbidden')) });
    expect(leftOut).toEqual(['Highlight box']);
    expect(usesHighlight(definition)).toBe(false);
    // Nothing else about the form changed.
    expect((definition.fields as unknown[]).length).toBe((supplier.fields as unknown[]).length);
  });

  it('leaves a template with no styles alone, without asking the library', async () => {
    const existing = vi.fn(async () => []);
    const blank = FORM_TEMPLATES.find((t) => t.key === 'blank')!.definition;
    expect(await prepareTemplate(blank, { existing, add: async () => undefined })).toEqual({ definition: blank, leftOut: [] });
    expect(existing).not.toHaveBeenCalled();
  });

  it('every template is a well-formed draft once prepared', async () => {
    for (const t of FORM_TEMPLATES) {
      const { definition } = await prepareTemplate(t.definition, { existing: async () => [], add: async () => undefined });
      const result = validateFormDefinition({ ...definition, id: 'x', orgId: 'o', version: 1, status: 'DRAFT', name: t.label, code: 'T', createdBy: 'u', updatedBy: 'u' }, 'shape');
      expect(result.success, t.key).toBe(true);
    }
  });

  describe('sections that are copies of library fragments', () => {
    const claim = FORM_TEMPLATES.find((t) => t.key === 'ins-health-claim')!.definition;
    const fragmentIds = (def: Record<string, unknown>) => (def.fields as { props?: { fragment?: { id: string; prefix: string } } }[]).flatMap((f) => (f.props?.fragment ? [f.props.fragment] : []));

    it('are added to a library that lacks them, and the form points at the library\'s own', async () => {
      const add = vi.fn(async (f: { name: string }) => ({ id: `lib-${f.name.toLowerCase().replace(/ /g, '-')}` }));
      const { definition, linked } = await linkTemplateFragments(claim, { existing: async () => [], add });
      expect(add.mock.calls.map((c) => c[0].name)).toEqual(['Bank account']);
      expect(linked).toEqual(['Bank account']);
      expect(fragmentIds(definition)).toEqual([{ id: 'lib-bank-account', prefix: 'payout' }]);
      // The fields themselves are untouched: they are already the copy the library would make.
      expect((definition.fields as { name: string }[]).filter((f) => f.name.startsWith('payout_')).map((f) => f.name)).toEqual(['payout_accountHolder', 'payout_accountNo', 'payout_ifsc', 'payout_bankName']);
    });

    it('use the one already in the library, by name, and add nothing', async () => {
      const add = vi.fn(async () => ({ id: 'new' }));
      const { definition } = await linkTemplateFragments(claim, { existing: async () => [{ id: 'theirs', name: 'Bank account' }, { id: 'x', name: 'Something else' }], add });
      expect(add).not.toHaveBeenCalled();
      expect(fragmentIds(definition)[0]!.id).toBe('theirs');
    });

    it('when the library cannot be changed, the form is made anyway, with the section as its own', async () => {
      const { definition, linked } = await linkTemplateFragments(claim, { existing: async () => [], add: async () => Promise.reject(new Error('Forbidden')) });
      expect(linked).toEqual([]);
      expect((definition.fields as unknown[]).length).toBe((claim.fields as unknown[]).length);
    });

    it('a form that uses none asks nothing of the library', async () => {
      const existing = vi.fn(async () => []);
      const blank = FORM_TEMPLATES.find((t) => t.key === 'blank')!.definition;
      expect(await linkTemplateFragments(blank, { existing, add: async () => ({ id: 'x' }) })).toEqual({ definition: blank, linked: [] });
      expect(existing).not.toHaveBeenCalled();
    });
  });
});
