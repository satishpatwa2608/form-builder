import { describe, expect, it } from 'vitest';
import { validateFormDefinition } from '../engine';
import { createBlankForm } from './blank-form';
import { applyTemplate, FORM_TEMPLATES } from './templates';

describe('process templates', () => {
  it.each(FORM_TEMPLATES.map((t) => [t.name, t] as const))('%s is publishable as is', (_name, template) => {
    const draft = createBlankForm({ name: template.name, code: 'TEMPLATE_TEST', businessId: '', access: 'PUBLIC', description: '' }, { orgId: 'org', uuid: 'u' });
    const def = applyTemplate(draft, template);
    const r = validateFormDefinition(def, 'publish');
    expect(r.success ? [] : r.issues.map((i) => `${i.path}: ${i.message}`)).toEqual([]);
    expect(def.workflow?.enabled).toBe(true);
    expect(def.code).toBe('TEMPLATE_TEST');
  });
});
