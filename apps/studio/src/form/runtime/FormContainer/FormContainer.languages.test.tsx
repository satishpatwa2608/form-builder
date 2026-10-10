import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FormContainer } from './FormContainer';
import { LanguagesDialog } from '../../builder/components/LanguagesDialog';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { createMockDataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import type { FormDefinition, SubmissionResult } from '../../types';

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

const form = (over: Partial<FormDefinition> = {}): FormDefinition => ({
  id: 'f-v1',
  orgId: 'org',
  businessId: '',
  name: 'Visitor pass',
  code: 'VISITOR',
  version: 1,
  status: 'PUBLISHED',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  languages: { default: 'en', others: ['hi', 'ar'] },
  fields: [
    { id: 'a', type: 'TEXT', name: 'visitor', label: 'Visitor name', required: true },
    { id: 'b', type: 'RADIO', name: 'purpose', label: 'Purpose', dataSource: { type: 'STATIC', options: [{ label: 'Meeting', value: 'MEET' }, { label: 'Delivery', value: 'DELIVER' }] } },
    { id: 'r', type: 'REPEAT', name: 'guests', label: 'Guests' },
    { id: 'g', type: 'TEXT', name: 'guest', label: 'Guest', parentId: 'r' },
  ],
  translations: {
    hi: { 'form.name': 'आगंतुक पास', 'field.visitor.label': 'आगंतुक का नाम', 'field.purpose.label': 'उद्देश्य', 'field.purpose.option.MEET': 'बैठक', 'field.guests.label': 'अतिथि' },
  },
  createdBy: 'u',
  updatedBy: 'u',
  ...over,
});

function renderForm(language?: string) {
  const onSubmitted = vi.fn<(r: SubmissionResult) => void>();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormContainer definition={form()} systemContext={{ language }} submissionAdapter={createMockSubmissionAdapter({ delayMs: 0 })} dataSourceAdapter={createMockDataSourceAdapter({ delayMs: 0 })} onSubmitted={onSubmitted} />
    </QueryClientProvider>,
  );
  return { user, onSubmitted };
}

describe('A form shown in another language', () => {
  it('in Hindi: the form\'s wording, the form app\'s own buttons and its messages', async () => {
    const { user, onSubmitted } = renderForm('hi');
    expect(screen.getByRole('textbox', { name: /^आगंतुक का नाम/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'बैठक' })).toBeInTheDocument();
    // Not translated yet: shown in the form's own language rather than left blank.
    expect(screen.getByRole('radio', { name: 'Delivery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'एक और जोड़ें' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'जमा करें' }));
    expect((await screen.findAllByText('आगंतुक का नाम आवश्यक है')).length).toBeGreaterThan(0);

    await user.type(screen.getByRole('textbox', { name: /^आगंतुक का नाम/ }), 'आशा');
    await user.click(screen.getByRole('radio', { name: 'बैठक' }));
    await user.click(screen.getByRole('button', { name: 'जमा करें' }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());
    // What is stored is the same in every language: the value, not the label.
    expect(onSubmitted.mock.calls[0][0].payload).toMatchObject({ visitor: 'आशा', purpose: 'MEET' });
    expect(await screen.findByText('धन्यवाद। आपका उत्तर जमा हो गया है।')).toBeInTheDocument();
  });

  it('in a language with nothing translated yet: the form\'s own wording, the form app\'s phrases in that language', async () => {
    const { user } = renderForm('ar');
    expect(screen.getByRole('textbox', { name: /^Visitor name/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'إرسال' }));
    expect((await screen.findAllByText('Visitor name مطلوب')).length).toBeGreaterThan(0);
  });

  it('with no language asked for, or one the form does not have: as written', () => {
    renderForm('fr');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /^Visitor name/ })).toBeInTheDocument();
  });
});

describe('The form app\'s own wording', () => {
  it('is nowhere written into the screens: every phrase comes from the catalogue', () => {
    const dir = join(__dirname, '..');
    const files = ['FormContainer', 'fields'].flatMap((d) => readdirSync(join(dir, d)).filter((f) => f.endsWith('.tsx') && !f.includes('.test.')).map((f) => join(dir, d, f)));
    const found: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line) || /^\s*import /.test(line)) return;
          // Words between tags, and words in the attributes people hear or see.
          const text =
            />\s*([A-Z][a-z]+(?: [A-Za-z']+)+[^<>{}]*)</.exec(line)?.[1] ??
            /(?:aria-label|placeholder|title|alt)="([A-Za-z][^"]*)"/.exec(line)?.[1] ??
            // A line of a tag's text on its own: "Back", or "Please fix {n} fields:".
            /^\s+([A-Z][a-z]+(?:[ '][A-Za-z]+)*(?: \{[^}]*\})?[A-Za-z :.…]*)$/.exec(line)?.[1];
          if (text) found.push(`${file.slice(dir.length + 1)}:${i + 1} ${text.trim()}`);
        });
    }
    // Shown only to the designer while building, never to someone filling a form in.
    const allowed = [/CustomField\.tsx.*Choose which of your extension/, /CaptchaField\.tsx/];
    expect(found.filter((f) => !allowed.some((a) => a.test(f)))).toEqual([]);
  });
});

describe('The Languages dialog', () => {
  function open(initial: FormDefinition) {
    const changes: Partial<FormDefinition>[] = [];
    let current = initial;
    const user = userEvent.setup();
    const view = render(<LanguagesDialog form={current} readOnly={false} open onOpenChange={() => {}} onChange={(c) => void changes.push(c)} />);
    const apply = () => {
      current = { ...current, ...changes[changes.length - 1] };
      view.rerender(<LanguagesDialog form={current} readOnly={false} open onOpenChange={() => {}} onChange={(c) => void changes.push(c)} />);
    };
    return { user, changes, apply, form: () => current };
  }

  it('shows how far each language is, and each piece of wording with a box for its translation', async () => {
    const { user, changes } = open(form());
    expect(screen.getByRole('button', { name: 'हिन्दी · 5 of 7' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'العربية · 0 of 7' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Translations into हिन्दी' });
    expect(within(table).getByRole('textbox', { name: 'हिन्दी: Visitor name' })).toHaveValue('आगंतुक का नाम');
    await user.type(within(table).getByRole('textbox', { name: 'हिन्दी: Delivery' }), 'ड');
    expect(changes.at(-1)!.translations!.hi['field.purpose.option.DELIVER']).toBe('ड');
    // Emptying a box takes the translation away, so the form's own wording shows again.
    await user.clear(within(table).getByRole('textbox', { name: 'हिन्दी: Visitor name' }));
    expect(changes.at(-1)!.translations!.hi['field.visitor.label']).toBeUndefined();
  });

  it('an XLIFF file for one language is read in; one for a language the form does not have changes nothing', async () => {
    // The test browser has no File.text(); real ones do.
    if (!Blob.prototype.text) {
      Blob.prototype.text = function text(this: Blob) {
        return new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsText(this);
        });
      };
    }
    const { user, changes } = open(form());
    expect(screen.getByRole('button', { name: 'Export हिन्दी as XLIFF' })).toBeInTheDocument();
    const xliff = (language: string, text: string) =>
      new File([`<?xml version="1.0"?><xliff version="1.2"><file source-language="en" target-language="${language}"><body><trans-unit id="form.name"><source>Visitor pass</source><target>${text}</target></trans-unit></body></file></xliff>`], 'pass.xlf', { type: 'application/xliff+xml' });
    const before = changes.length;
    await user.upload(screen.getByLabelText('Translations file (.csv or .xlf)'), xliff('fr', 'Laissez-passer'));
    await new Promise((r) => setTimeout(r, 50));
    expect(changes.length).toBe(before);
    await user.upload(screen.getByLabelText('Translations file (.csv or .xlf)'), xliff('ar', 'تصريح زائر'));
    await vi.waitFor(() => expect(JSON.stringify(changes.at(-1) ?? {})).toContain('تصريح زائر'));
  });

  it('a right-to-left language is typed right to left; removing a language removes its translations', async () => {
    const { user, changes } = open(form({ translations: { hi: { 'form.name': 'आगंतुक पास' }, ar: { 'form.name': 'تصريح زائر' } } }));
    await user.click(screen.getByRole('button', { name: /^العربية/ }));
    expect(screen.getByRole('textbox', { name: 'العربية: Visitor pass' })).toHaveAttribute('dir', 'rtl');
    await user.click(screen.getByRole('button', { name: 'Remove العربية' }));
    expect(changes.at(-1)).toEqual({ languages: { default: 'en', others: ['hi'] }, translations: { hi: { 'form.name': 'आगंतुक पास' } } });
  });

  it('a language the form app does not speak has its own phrases to translate too', () => {
    open(form({ languages: { default: 'en', others: ['ta'] }, translations: {} }));
    const table = screen.getByRole('table', { name: 'Translations into தமிழ்' });
    expect(within(table).getByRole('textbox', { name: 'தமிழ்: Submit' })).toBeInTheDocument();
    expect(within(table).getAllByText('Said by the form itself').length).toBeGreaterThan(40);
  });

  it('with no other language yet, says how to start', () => {
    open(form({ languages: undefined, translations: undefined }));
    expect(screen.getByText('Add a language to translate the form into it.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
