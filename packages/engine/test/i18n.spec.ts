import { describe, expect, it } from 'vitest';
import { buildZodSchema, isRtl, languagesOf, localize, pickLanguage, translatableStrings, translationProgress, translationsFromCsv, translationsFromXliff, translationsToCsv, translationsToXliff, UI_KEYS, UI_TEXT, uiText, validateFormDefinition } from '../src';
import type { FormDefinition } from '../src';
import base from './fixtures/customer-complaint-basic.json';

const form = (): FormDefinition =>
  ({
    ...base,
    name: 'Visitor pass',
    languages: { default: 'en', others: ['hi', 'ar'] },
    fields: [
      { id: 'a', type: 'TEXT', name: 'visitor', label: 'Visitor name', placeholder: 'As on your ID', helpText: 'First and last name', required: true, validation: { minLength: 3, messages: { minLength: 'Too short for a name' } } },
      { id: 'b', type: 'EMAIL', name: 'email', label: 'Email' },
      { id: 'c', type: 'RADIO', name: 'purpose', label: 'Purpose', dataSource: { type: 'STATIC', options: [{ label: 'Meeting', value: 'MEET' }, { label: 'Delivery', value: 'DELIVER' }] } },
      { id: 'd', type: 'CONSENT', name: 'rules', label: 'I accept', required: true, props: { text: 'Visitors must wear a badge.' } },
      { id: 'e', type: 'SECTION', name: 'more', label: 'More', props: { description: 'Optional details' } },
      { id: 'f', type: 'NUMBER', name: 'guests', label: 'Guests', parentId: 'e', validation: { max: 5 } },
    ],
    rules: [{ id: 'r1', name: 'Limit', when: { field: 'guests', operator: 'greaterThan', value: 3 }, then: [{ type: 'ERROR', target: 'guests', message: 'Ask your host first' }] }],
    events: [{ id: 'e1', on: { type: 'SUBMIT_SUCCESS' }, do: [{ type: 'SHOW_MESSAGE', message: 'Collect your badge at the desk.' }] }],
    actions: { submit: { enabled: true, label: 'Request pass' } },
    submission: { method: 'POST', endpointId: 'default-submit', success: { type: 'MESSAGE', message: 'Thank you.' } },
    closedMessage: 'Visits are closed for today.',
    document: { title: 'Visitor record', footer: 'Security copy' },
    translations: {
      hi: {
        'form.name': 'आगंतुक पास',
        'field.visitor.label': 'आगंतुक का नाम',
        'field.visitor.message.minLength': 'नाम के लिए बहुत छोटा',
        'field.purpose.label': 'उद्देश्य',
        'field.purpose.option.MEET': 'बैठक',
        'field.rules.text': 'आगंतुकों को बैज पहनना होगा।',
        'rule.r1.then.0': 'पहले अपने मेज़बान से पूछें',
        'form.submit': 'पास माँगें',
        'form.success': 'धन्यवाद।',
      },
    },
  }) as unknown as FormDefinition;
const messages = (def: FormDefinition, language: string, values: object) => {
  const shown = localize(def, language);
  const r = buildZodSchema(shown, { language }).safeParse(values);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]));
};

describe('What a form says itself', () => {
  it('has every phrase in English, Hindi and Arabic, with the same blanks to fill', () => {
    const blanks = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const lang of ['hi', 'ar'] as const) {
      expect(Object.keys(UI_TEXT[lang]).sort()).toEqual([...UI_KEYS].sort());
      for (const key of UI_KEYS) {
        expect(UI_TEXT[lang][key].trim(), `${lang}.${key}`).not.toBe('');
        expect(blanks(UI_TEXT[lang][key]), `${lang}.${key}`).toBe(blanks(UI_TEXT.en[key]));
      }
    }
  });

  it('speaks the language asked for, falling back to English, and takes a form\'s own wording first', () => {
    expect(uiText('hi')('required', { label: 'नाम' })).toBe('नाम आवश्यक है');
    expect(uiText('ar')('submit')).toBe('إرسال');
    expect(uiText('hi-IN')('next')).toBe('आगे');
    expect(uiText('ta')('submit')).toBe('Submit');
    expect(uiText(undefined)('min', { n: 3 })).toBe('Must be at least 3');
    expect(uiText('ta', { translations: { ta: { 'ui.submit': 'சமர்ப்பி' } } })('submit')).toBe('சமர்ப்பி');
    expect(uiText('hi', { translations: { hi: { 'ui.submit': 'भेजें' } } })('submit')).toBe('भेजें');
  });

  it('knows which languages a form has, which to show, and which run right to left', () => {
    expect(languagesOf(form())).toEqual(['en', 'hi', 'ar']);
    expect(languagesOf({})).toEqual(['en']);
    expect(pickLanguage(form(), 'hi')).toBe('hi');
    expect(pickLanguage(form(), 'hi-IN')).toBe('hi');
    expect(pickLanguage(form(), 'fr')).toBe('en');
    expect(pickLanguage(form(), undefined)).toBe('en');
    expect([isRtl('ar'), isRtl('ur'), isRtl('ar-EG'), isRtl('hi'), isRtl(undefined)]).toEqual([true, true, true, false, false]);
  });
});

describe('A form in another language', () => {
  it('lists everything a translator must translate, saying where each piece appears', () => {
    expect(translatableStrings(form()).map((s) => s.key)).toEqual([
      'form.name',
      'field.visitor.label', 'field.visitor.placeholder', 'field.visitor.helpText', 'field.visitor.message.minLength',
      'field.email.label',
      'field.purpose.label', 'field.purpose.option.MEET', 'field.purpose.option.DELIVER',
      'field.rules.label', 'field.rules.text',
      'field.more.label', 'field.more.description',
      'field.guests.label',
      'rule.r1.then.0', 'event.e1.0',
      'form.submit', 'form.success', 'form.closed', 'form.documentTitle', 'form.documentFooter',
    ]);
    expect(translatableStrings(form()).find((s) => s.key === 'field.purpose.option.MEET')).toEqual({ key: 'field.purpose.option.MEET', text: 'Meeting', context: 'Choice of "Purpose"' });
  });

  it('shows its translations and keeps its own wording where there is none', () => {
    const hi = localize(form(), 'hi');
    expect(hi.name).toBe('आगंतुक पास');
    expect(hi.fields[0]).toMatchObject({ name: 'visitor', label: 'आगंतुक का नाम', placeholder: 'As on your ID', validation: { minLength: 3, messages: { minLength: 'नाम के लिए बहुत छोटा' } } });
    // Labels change; the values stored do not.
    expect(hi.fields[2].dataSource!.options).toEqual([{ label: 'बैठक', value: 'MEET' }, { label: 'Delivery', value: 'DELIVER' }]);
    expect(hi.fields[3].props).toEqual({ text: 'आगंतुकों को बैज पहनना होगा।' });
    expect(hi.rules![0].then[0]).toMatchObject({ type: 'ERROR', message: 'पहले अपने मेज़बान से पूछें' });
    expect(hi.actions!.submit!.label).toBe('पास माँगें');
    expect(hi.submission.success!.message).toBe('धन्यवाद।');
    expect(hi.closedMessage).toBe('Visits are closed for today.');
    // Its own language, a language it does not have, and one with nothing translated: the form as written.
    const original = form();
    expect(localize(original, 'en')).toBe(original);
    expect(localize(original, 'fr')).toBe(original);
    expect(localize(original, 'ar')).toBe(original);
    expect(validateFormDefinition(hi, 'publish').success).toBe(true);
  });

  it('checks answers in that language: its own messages translated, the standard ones built in', () => {
    const wrong = { visitor: 'A', email: 'nope', guests: 9 };
    expect(messages(form(), 'en', wrong)).toEqual({ visitor: 'Too short for a name', email: 'Enter a valid email address', rules: 'Please accept to continue', guests: 'Must be at most 5' });
    expect(messages(form(), 'hi', wrong)).toEqual({ visitor: 'नाम के लिए बहुत छोटा', email: 'एक मान्य ईमेल पता दर्ज करें', rules: 'आगे बढ़ने के लिए कृपया स्वीकार करें', guests: 'अधिकतम 5 हो सकता है' });
    expect(messages(form(), 'ar', { rules: true }).visitor).toBe('Visitor name مطلوب');
    expect(messages(form(), 'hi', { rules: true }).visitor).toBe('आगंतुक का नाम आवश्यक है');
    expect(messages(form(), 'hi', { visitor: 'Asha', rules: true, guests: 4 })).toEqual({ guests: 'पहले अपने मेज़बान से पूछें' });
  });

  it('says how much of a language is done', () => {
    const p = translationProgress(form(), 'hi');
    expect([p.done, p.total]).toEqual([9, 21]);
    expect(p.missing.map((s) => s.key)).toContain('field.email.label');
    expect(translationProgress(form(), 'ar').done).toBe(0);
  });
});

describe('Translating outside the product', () => {
  it('exports one row per string with a column per language, and reads the file back', () => {
    const csv = translationsToCsv(form());
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('key,where,en,hi,ar');
    expect(lines).toContain('field.purpose.option.MEET,"Choice of ""Purpose""",Meeting,बैठक,');
    expect(lines.some((l) => l.startsWith('ui.'))).toBe(false);

    const filled = csv.replace('field.email.label,Label,Email,,', 'field.email.label,Label,Email,ईमेल,البريد الإلكتروني');
    const { translations, notes } = translationsFromCsv(form(), filled);
    expect(translations.hi['field.email.label']).toBe('ईमेल');
    expect(translations.ar).toEqual({ 'field.email.label': 'البريد الإلكتروني' });
    expect(translations.hi['form.name']).toBe('आगंतुक पास');
    expect(notes).toEqual(['11 translations read.']);
    // Round trip: exporting what was read gives the same file.
    expect(translationsToCsv({ ...form(), translations })).toBe(filled);
  });

  it('a language that is not built in gets the form app\'s own phrases to translate too', () => {
    const tamil = { ...form(), languages: { default: 'en', others: ['ta'] }, translations: {} } as FormDefinition;
    const csv = translationsToCsv(tamil);
    expect(csv).toContain('ui.submit,Said by the form itself,Submit,');
    const { translations } = translationsFromCsv(tamil, csv.replace('ui.submit,Said by the form itself,Submit,', 'ui.submit,Said by the form itself,Submit,சமர்ப்பி'));
    expect(uiText('ta', { translations })('submit')).toBe('சமர்ப்பி');
  });

  it('takes only what belongs to this form, and says what it left out', () => {
    const csv = ['key,where,en,hi,fr', 'field.email.label,Label,Email,ईमेल,Courriel', 'field.gone.label,Label,Gone,गया,', 'form.name,,Visitor pass,,', ',,,,'].join('\r\n');
    const { translations, notes } = translationsFromCsv(form(), csv);
    expect(translations.hi['field.email.label']).toBe('ईमेल');
    expect(translations.fr).toBeUndefined();
    // An emptied cell takes the translation away again.
    expect(translations.hi['form.name']).toBeUndefined();
    expect(notes).toEqual(['1 translation read.', 'The column "fr" is not a language of this form and was ignored.', '1 row had a key this form does not have (the form has changed since the file was exported) and was ignored.']);
    expect(translationsFromCsv(form(), 'name,value\na,b').notes).toEqual(['The first column must be "key". Export the translations first and fill in that file.']);
  });

  it('a string that a spreadsheet would run as a formula is written as text, and comes back as it was', () => {
    const risky = { ...form(), name: '=HYPERLINK("http://evil.test")', translations: { hi: { 'form.name': '+1 visitor' } } } as FormDefinition;
    const csv = translationsToCsv(risky);
    expect(csv).toContain(`form.name,The form's title,"'=HYPERLINK(""http://evil.test"")",'+1 visitor,`);
    expect(translationsFromCsv(risky, csv).translations.hi['form.name']).toBe('+1 visitor');
  });
});

describe('Translating with XLIFF, the file translation tools exchange', () => {
  it('one file for one language: every piece of wording as a unit, with where it is and what is translated so far', () => {
    const started = { ...form(), translations: { hi: { 'form.name': 'आगंतुक पास' } } };
    const xml = translationsToXliff(started, 'hi');
    expect(xml).toContain('<xliff version="1.2"');
    expect(xml).toContain('source-language="en" target-language="hi"');
    expect(xml).toContain('<trans-unit id="form.name"');
    expect(xml).toContain('<source>Visitor pass</source>');
    expect(xml).toContain('<target state="translated">आगंतुक पास</target>');
    expect(xml).toContain('<target state="new"></target>');
    expect((xml.match(/<trans-unit /g) ?? []).length).toBe(translatableStrings(started).length);
  });

  it('comes back in: what was translated is taken, what was emptied is removed, the other languages are untouched', () => {
    const started = { ...form(), translations: { hi: { 'form.name': 'पुराना' }, ar: { 'form.name': 'تصريح زائر' } } };
    const xml = translationsToXliff(started, 'hi')
      .replace('<target state="translated">पुराना</target>', '<target state="translated">आगंतुक पास</target>')
      .replace(/(<trans-unit id="field\.visitor\.label"[\s\S]*?<target state="new">)(<\/target>)/, '$1आगंतुक का <g id="1">नाम</g> &amp; पता$2');
    const { translations, notes } = translationsFromXliff(started, xml);
    expect(translations.hi['form.name']).toBe('आगंतुक पास');
    // Markup a tool wrapped round words is dropped, and escaped characters are themselves again.
    expect(translations.hi['field.visitor.label']).toBe('आगंतुक का नाम & पता');
    expect(translations.ar).toEqual({ 'form.name': 'تصريح زائر' });
    expect(notes[0]).toBe('2 translations into hi read.');
    // A unit sent back empty takes that translation away.
    const emptied = translationsFromXliff(started, translationsToXliff(started, 'hi').replace('<target state="translated">पुराना</target>', '<target></target>'));
    expect(emptied.translations.hi['form.name']).toBeUndefined();
  });

  it('a file for a language the form does not offer, something that is not XLIFF, and wording the form no longer has are said, not taken', () => {
    const xml = translationsToXliff(form(), 'hi');
    expect(translationsFromXliff(form(), xml.replace('target-language="hi"', 'target-language="fr"')).notes).toEqual(['The file is for "fr", which is not a language of this form.']);
    expect(translationsFromXliff(form(), '<html></html>').notes[0]).toContain('not an XLIFF file');
    const stale = xml.replace('</body>', '<trans-unit id="field.gone.label"><source>Gone</source><target>गया</target></trans-unit></body>');
    const read = translationsFromXliff(form(), stale);
    expect(read.notes.join(' ')).toContain('1 unit had a key this form does not have');
    expect(read.translations.hi['field.gone.label']).toBeUndefined();
  });

  it('wording with angle brackets and quotes goes out escaped and comes back as it was', () => {
    const tricky = { ...form(), name: 'Pass <A> & "B"' };
    const xml = translationsToXliff(tricky, 'hi');
    expect(xml).toContain('<source>Pass &lt;A&gt; &amp; &quot;B&quot;</source>');
    const back = translationsFromXliff(tricky, xml.replace(/(<trans-unit id="form\.name"[\s\S]*?<target[^>]*>)[\s\S]*?(<\/target>)/, '$1पास &lt;A&gt; &amp; &quot;B&quot;$2'));
    expect(back.translations.hi['form.name']).toBe('पास <A> & "B"');
  });
});
