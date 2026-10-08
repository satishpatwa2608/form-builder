import { describe, expect, it, vi } from 'vitest';
import { validateFormDefinition } from '@fb/engine';
import { FORM_TEMPLATES, prepareTemplate } from './index';

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
});
