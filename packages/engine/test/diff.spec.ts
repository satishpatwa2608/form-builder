import { describe, expect, it } from 'vitest';
import { diffForms, parseFormDefinition } from '../src';
import type { FormDefinition } from '../src/types';
import base from './fixtures/customer-complaint-basic.json';

const v1 = parseFormDefinition(base);
const edit = (change: (def: FormDefinition) => void): FormDefinition => {
  const copy = JSON.parse(JSON.stringify(v1)) as FormDefinition;
  change(copy);
  return copy;
};
const lines = (after: FormDefinition, before = v1) => diffForms(before, after).map((c) => `${c.area} ${c.kind}: ${c.what}${c.details.length ? ` [${c.details.join(' | ')}]` : ''}`);
const field = (def: FormDefinition, name: string) => def.fields.find((f) => f.name === name)!;

describe('comparing two versions of a form', () => {
  it('finds nothing between a form and itself', () => {
    expect(diffForms(v1, JSON.parse(JSON.stringify(v1)))).toEqual([]);
  });

  it('reports a field that was added, removed or changed, by its label', () => {
    expect(lines(edit((d) => d.fields.push({ id: 'new', type: 'TEXT', name: 'orderNo', label: 'Order number' })))).toEqual(['Field added: Order number']);
    expect(lines(edit((d) => (d.fields = d.fields.filter((f) => f.name !== 'phone'))))).toEqual(['Field removed: Phone']);
    expect(
      lines(
        edit((d) => {
          const f = field(d, 'name');
          f.label = 'Full name';
          f.required = false;
          f.validation = { maxLength: 5 };
        }),
      ),
    ).toEqual(['Field changed: Full name [label: was "Name", now "Full name" | required: was on, now off | validation changed]']);
  });

  it('follows a field through a change of key, because it is matched by identity', () => {
    expect(lines(edit((d) => (field(d, 'email').name = 'emailAddress')))).toEqual(['Field changed: Email [key: was "email", now "emailAddress"]']);
  });

  it('says when fields were moved into a block or reordered', () => {
    const moved = edit((d) => {
      d.fields.push({ id: 'sec', type: 'SECTION', name: 'contact', label: 'Contact' });
      field(d, 'phone').parentId = 'sec';
    });
    expect(lines(moved)).toEqual(['Field changed: Phone [moved into "Contact"]', 'Field added: Contact']);
    expect(lines(edit((d) => d.fields.reverse()))).toEqual(['Form changed: Order of fields']);
  });

  it('reports form settings with their old and new values', () => {
    expect(
      lines(
        edit((d) => {
          d.name = 'Complaints';
          d.access = 'AUTHENTICATED';
          d.layout = { mode: 'steps', review: true };
          d.closesAt = '2026-12-31T00:00:00.000Z';
          d.saveForLater = false;
        }),
      ),
    ).toEqual([
      'Form changed: Form settings [name: was "Customer Complaint (Basic)", now "Complaints" | who can open it: was "PUBLIC", now "AUTHENTICATED" | layout changed | save and continue later: was nothing, now off | closing time: was nothing, now "2026-12-31T00:00:00.000Z"]',
    ]);
  });

  it('reports rules and events by name', () => {
    const withRules = edit((d) => {
      d.rules = [{ id: 'r1', name: 'Total', then: [{ type: 'SET_VALUE', target: 'amountDisputed', value: '1' }] }];
      d.events = [{ id: 'e1', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'SHOW_MESSAGE', message: 'Thanks' }] }];
    });
    expect(lines(withRules)).toEqual(['Rule added: Total', 'Event added: Event 1']);
    const changed = JSON.parse(JSON.stringify(withRules)) as FormDefinition;
    changed.rules![0].disabled = true;
    changed.rules![0].then = [{ type: 'SET_VALUE', target: 'amountDisputed', value: '2' }];
    changed.events = [];
    expect(lines(changed, withRules)).toEqual(['Rule changed: Total [switched off | "then" actions changed]', 'Event removed: Event 1']);
  });

  it('reports the workflow and automations', () => {
    const wf = { enabled: true, refPrefix: 'CC', statuses: [{ key: 'NEW', label: 'New', category: 'OPEN' as const }], assignment: { type: 'NONE' as const }, actions: [] };
    const withWorkflow = edit((d) => {
      d.workflow = wf;
      d.automations = [{ id: 'a1', name: 'Acknowledge', enabled: true, when: 'SUBMITTED', actions: [] }];
    });
    expect(lines(withWorkflow)).toEqual(['Workflow added: Workflow', 'Automation added: Acknowledge']);
    const changed = JSON.parse(JSON.stringify(withWorkflow)) as FormDefinition;
    changed.workflow!.refPrefix = 'CMP';
    changed.workflow!.statuses.push({ key: 'DONE', label: 'Done', category: 'DONE' });
    changed.automations![0].enabled = false;
    expect(lines(changed, withWorkflow)).toEqual([
      'Workflow changed: Workflow [reference prefix: was "CC", now "CMP" | statuses changed]',
      'Automation changed: Acknowledge [switched off]',
    ]);
    expect(lines(v1, withWorkflow)).toEqual(['Workflow removed: Workflow', 'Automation removed: Acknowledge']);
  });

  it('ignores what is not the designer\'s doing: version, status and who saved it', () => {
    expect(diffForms(v1, { ...v1, id: 'other', version: 9, status: 'ARCHIVED', updatedBy: 'x', updatedAt: 'y' })).toEqual([]);
  });
});
