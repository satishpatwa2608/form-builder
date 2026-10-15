import { validateFormDefinition } from '@fb/engine';
import { readDraft } from './form-draft';

const reply = (o: unknown) => `Here is your form:\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

describe('reading a drafted form', () => {
  it('turns the questions into fields of the right kinds, with choices and a question shown after an answer', () => {
    const d = readDraft(
      reply({
        title: 'Maintenance complaint',
        description: 'Tell us what needs fixing.',
        questions: [
          { label: 'Which property?', type: 'choice', choices: ['Tower A', 'Tower B'], required: true },
          { label: 'What kind of problem?', type: 'choice', choices: ['Leak', 'Electrical', 'Lift', 'Noise', 'Other'], required: true },
          { label: 'Is water still coming in?', type: 'yes_no', showWhen: { question: 'What kind of problem?', is: ['Leak'] } },
          { label: 'A photo', type: 'file' },
          { label: 'How urgent?', type: 'choice', choices: ['Now', 'Today', 'This week'], many: false },
          { label: 'Rooms affected', type: 'choice', choices: ['Kitchen', 'Bathroom'], many: true },
          { label: 'Your email', type: 'email', required: true },
          { label: 'Details', type: 'long_text' },
        ],
      }),
    );
    expect(d.title).toBe('Maintenance complaint');
    expect(d.leftOut).toEqual([]);
    expect(d.fields.map((f) => [f.name, f.type, !!f.required])).toEqual([
      ['whichProperty', 'RADIO', true],
      ['whatKindOfProblem', 'DROPDOWN', true],
      ['isWaterStillComingIn', 'RADIO', false],
      ['aPhoto', 'FILE', false],
      ['howUrgent', 'RADIO', false],
      ['roomsAffected', 'MULTI_SELECT', false],
      ['yourEmail', 'EMAIL', true],
      ['details', 'TEXTAREA', false],
    ]);
    expect(d.fields[1]!.dataSource!.options!.map((o) => o.value)).toEqual(['LEAK', 'ELECTRICAL', 'LIFT', 'NOISE', 'OTHER']);
    expect(d.fields[2]!.visibility).toEqual({ when: { field: 'whatKindOfProblem', operator: 'equals', value: 'LEAK' } });
    // It is a valid form as it stands.
    expect(validateFormDefinition({ id: 'x', orgId: 'o', businessId: '', name: 'X', code: 'X', version: 1, status: 'DRAFT', access: 'PUBLIC', fields: d.fields, submission: { method: 'POST', endpointId: 'x' }, createdBy: 'u', updatedBy: 'u' }).success).toBe(true);
  });

  it('takes questions only: a workflow, a script or a kind of question it does not know is left out, and said', () => {
    const d = readDraft(
      reply({
        title: 'X',
        questions: [
          { label: 'Name', type: 'short_text' },
          { label: 'Run this', type: 'html', html: '<script>alert(1)</script>' },
          { label: 'Pick', type: 'choice', choices: ['Only one'] },
          { type: 'short_text' },
        ],
        workflow: { statuses: [{ key: 'NEW' }] },
        automations: [{ actions: [{ type: 'WEBHOOK', url: 'https://evil.example' }] }],
      }),
    );
    expect(d.fields.map((f) => f.name)).toEqual(['name']);
    expect(d.leftOut).toEqual([
      '"workflow" in the answer: only questions are drafted',
      '"automations" in the answer: only questions are drafted',
      '"Run this": "html" is not a kind of question that is drafted',
      '"Pick": a choice needs at least two answers',
      'Question 4: it had no wording',
    ]);
  });

  it('an answer that is not the JSON asked for drafts nothing, and says so', () => {
    for (const bad of ['Sorry, I cannot help with that.', '{"questions": [', '[1, 2, 3]', '']) {
      const d = readDraft(bad);
      expect(d.fields).toEqual([]);
      expect(d.leftOut[0]).toMatch(/not in the form asked for/);
    }
  });

  it('a condition on a later or unknown question is dropped, and the question is kept, always shown', () => {
    const d = readDraft(reply({ questions: [{ label: 'Extra', type: 'short_text', showWhen: { question: 'Later', is: ['Yes'] } }, { label: 'Later', type: 'yes_no' }] }));
    expect(d.fields[0]!.visibility).toBeUndefined();
    expect(d.leftOut).toEqual(['"Extra": shown always, because the answer it depends on was not found among the questions above it']);
  });

  it('limits: words cut to size, markup and control characters removed, names unique and valid', () => {
    const d = readDraft(reply({ questions: [{ label: `<b>Name</b>\u0007 ${'x'.repeat(500)}`, type: 'short_text' }, { label: 'Name', type: 'short_text' }, { label: '123 go', type: 'number' }, ...Array.from({ length: 70 }, (_, i) => ({ label: `Q${i}`, type: 'short_text' }))] }));
    expect(d.fields[0]!.label).not.toMatch(/[<>\u0007]/);
    expect((d.fields[0]!.label ?? '').length).toBeLessThanOrEqual(200);
    expect(d.fields.slice(1, 3).map((f) => f.name)).toEqual(['name', 'q123Go']);
    expect(d.fields).toHaveLength(60);
    expect(d.leftOut).toContain('13 questions after the first 60');
    expect(new Set(d.fields.map((f) => f.name)).size).toBe(60);
  });
});
