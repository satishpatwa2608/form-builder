import { describe, expect, it } from 'vitest';
import { publicCopy } from '../src';
import type { FormDefinition } from '../src';
import base from './fixtures/customer-complaint-basic.json';

describe('the copy of a form the public is given', () => {
  const def = {
    ...(base as unknown as FormDefinition),
    workflow: { enabled: true, statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' as const }], assignment: { type: 'USER' as const, userId: 'u-secret' } },
    automations: [{ id: 'a', name: 'To CRM', enabled: true, when: 'SUBMITTED' as const, actions: [{ type: 'WEBHOOK' as const, url: 'https://hooks.example.com/x?sig=secret' }] }],
    recordAccess: { mode: 'TEAM' } as never,
    submitChecks: ['x-abc-check'],
    document: { keep: true },
    listOnPortal: true,
    createdBy: 'u1',
    updatedBy: 'u2',
  } as FormDefinition;

  it('has everything needed to draw the form and check answers', () => {
    const copy = publicCopy(def);
    expect(copy.fields).toEqual(def.fields);
    expect(copy).toMatchObject({ id: def.id, code: def.code, name: def.name, version: def.version, submission: def.submission });
    for (const key of ['rules', 'events', 'actions', 'theme', 'layout', 'languages', 'translations', 'captcha'] as const) expect(copy[key]).toEqual(def[key]);
  });

  it('says nothing about what happens to a response afterwards', () => {
    const text = JSON.stringify(publicCopy(def));
    expect(text).not.toMatch(/u-secret|hooks\.example|sig=secret|x-abc-check|To CRM/);
    for (const key of ['automations', 'workflow', 'recordAccess', 'submitChecks', 'document', 'listOnPortal', 'createdBy', 'updatedBy']) expect(publicCopy(def)).not.toHaveProperty(key);
  });

  it('leaves the form itself as it was', () => {
    publicCopy(def);
    expect(def.automations).toHaveLength(1);
  });
});
