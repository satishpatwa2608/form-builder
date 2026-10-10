import { writeFileSync } from 'node:fs';
import { readPdf as pdfParse } from '../../test/read-pdf';
import type { FormField } from '@fb/engine';
import { documentRows, fontRuns, renderDocument, type DocumentInput } from './submission-pdf';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const sign = `data:image/png;base64,${PNG.toString('base64')}`;

const fields: FormField[] = [
  { id: 'who', type: 'TEXT', name: 'customer', label: 'Customer' },
  { id: 'sev', type: 'RADIO', name: 'severity', label: 'Severity', dataSource: { type: 'STATIC', options: [{ label: 'Minor', value: 'LOW' }, { label: 'Serious', value: 'HIGH' }] } },
  { id: 'ok', type: 'CHECKBOX', name: 'contactMe', label: 'Contact me' },
  { id: 'tok', type: 'HIDDEN', name: 'source', label: 'Source' },
  { id: 'cap', type: 'CAPTCHA', name: 'captchaToken' },
  { id: 'note', type: 'HTML', name: 'note', label: 'A note' },
  { id: 'sec', type: 'SECTION', name: 'delivery', label: 'Delivery' },
  { id: 'cols', type: 'COLUMNS', name: 'cols', parentId: 'sec' },
  { id: 'city', type: 'TEXT', name: 'city', label: 'City', parentId: 'cols' },
  { id: 'pin', type: 'TEXT', name: 'pin', label: 'PIN code', parentId: 'cols' },
  { id: 'empty', type: 'SECTION', name: 'extras', label: 'Extras' },
  { id: 'gift', type: 'TEXT', name: 'gift', label: 'Gift note', parentId: 'empty' },
  { id: 'lines', type: 'REPEAT', name: 'items', label: 'Items' },
  { id: 'item', type: 'TEXT', name: 'item', label: 'Item', parentId: 'lines' },
  { id: 'qty', type: 'NUMBER', name: 'qty', label: 'Qty', parentId: 'lines' },
  { id: 'files', type: 'FILE', name: 'proof', label: 'Proof' },
  { id: 'sig', type: 'SIGNATURE', name: 'sign', label: 'Signature' },
];
const values = { customer: 'Asha Textiles', severity: 'HIGH', contactMe: true, source: 'WEB', captchaToken: 'x', city: 'Pune', pin: '', items: [{ item: 'Pen', qty: 2 }, { item: 'Ink', qty: 1 }], proof: [{ uploadId: 'u1' }, { uploadId: 'u2' }], sign };

const input = (over: Partial<DocumentInput> = {}): DocumentInput => ({
  org: { name: 'Acme Trading', color: '#0f766e' },
  form: { name: 'Customer complaint', code: 'COMPLAINT', version: 3 },
  record: { ref: 'CMP-000042', submittedAt: new Date('2026-10-09T05:30:00Z'), status: 'New' },
  rows: documentRows({ fields }, values),
  generatedAt: new Date('2026-10-09T06:00:00Z'),
  ...over,
});
const textOf = async (pdf: Buffer) => (await pdfParse(pdf)).text.replace(/\s+/g, ' ');

describe('What a submission says, for its document', () => {
  it('lists answers in the form\'s order, in words, under their section titles', () => {
    expect(documentRows({ fields }, values)).toEqual([
      { kind: 'answer', label: 'Customer', value: 'Asha Textiles' },
      { kind: 'answer', label: 'Severity', value: 'Serious' },
      { kind: 'answer', label: 'Contact me', value: 'Yes' },
      { kind: 'heading', text: 'Delivery' },
      { kind: 'answer', label: 'City', value: 'Pune' },
      { kind: 'table', label: 'Items', columns: ['Item', 'Qty'], rows: [['Pen', '2'], ['Ink', '1']] },
      { kind: 'answer', label: 'Proof', value: '2 files attached' },
      { kind: 'image', label: 'Signature', png: PNG },
    ]);
  });

  it('leaves out what was not answered, with its section title, unless asked to show it', () => {
    const rows = documentRows({ fields }, { customer: 'A' });
    expect(rows).toEqual([{ kind: 'answer', label: 'Customer', value: 'A' }]);
    const all = documentRows({ fields }, { customer: 'A' }, { showEmpty: true });
    expect(all.filter((r) => r.kind === 'answer').map((r) => (r.kind === 'answer' ? `${r.label}: ${r.value}` : ''))).toContain('Gift note: Not answered');
    expect(all).toContainEqual({ kind: 'heading', text: 'Extras' });
    expect(all).toContainEqual({ kind: 'table', label: 'Items', columns: ['Item', 'Qty'], rows: [] });
    // Never: what the form hides from people, or a verification token.
    expect(JSON.stringify(all)).not.toMatch(/Source|captcha/i);
  });

  it('leaves out the questions and sections the form\'s owner chose, and ends with their closing note', () => {
    const rows = documentRows({ fields }, values, { leaveOut: ['severity', 'delivery', 'items'], note: '  This is a record of what was sent, not an approval.  ' });
    const said = JSON.stringify(rows);
    expect(said).toContain('Asha Textiles');
    // The question, the whole section (title and what it holds) and the table are gone.
    expect(said).not.toContain('Serious');
    expect(said).not.toContain('Delivery');
    expect(said).not.toContain('Pune');
    expect(said).not.toContain('Pen');
    expect(rows.at(-1)).toEqual({ kind: 'note', text: 'This is a record of what was sent, not an approval.' });
    // Nothing chosen: nothing changes, and no note is added.
    expect(documentRows({ fields }, values, {}).some((r) => r.kind === 'note')).toBe(false);
  });

  it('a section can start on a new page; an empty one, or the very first, adds no blank page', async () => {
    const rows = documentRows({ fields }, values, { newPage: ['delivery', 'extras'] });
    // Delivery has answers and something before it: it gets a break. Extras holds nothing that was answered: no break, no title.
    expect(rows.filter((r) => r.kind === 'break')).toHaveLength(1);
    const at = rows.findIndex((r) => r.kind === 'break');
    expect(rows[at + 1]).toEqual({ kind: 'heading', text: 'Delivery' });
    expect(JSON.stringify(rows)).not.toContain('Extras');
    const one = await renderDocument(input({ rows: documentRows({ fields }, values, {}) }));
    const two = await renderDocument(input({ rows }));
    expect((await pdfParse(two)).numpages).toBe((await pdfParse(one)).numpages + 1);
    // A break asked for on the first section of a form changes nothing.
    const first = documentRows({ fields: [{ id: 's', type: 'SECTION', name: 'only', label: 'Only' }, { id: 'a', type: 'TEXT', name: 'a', label: 'A', parentId: 's' }] }, { a: 'x' }, { newPage: ['only'] });
    expect(first.some((r) => r.kind === 'break')).toBe(false);
  });

  it('made to the archival standard when asked: marked PDF/A-2b, with its fonts inside, and still the same words', async () => {
    const rows = documentRows({ fields }, values, {});
    const usual = await renderDocument(input({ rows }));
    const archival = await renderDocument(input({ rows, options: { archival: true } }));
    const raw = archival.toString('latin1');
    expect(raw).toContain('<pdfaid:part>2</pdfaid:part>');
    expect(raw).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    expect(raw).toContain('/OutputIntents');
    expect(usual.toString('latin1')).not.toContain('pdfaid');
    expect((await pdfParse(archival)).text).toContain('Asha Textiles');
  });

  it('can be set in a serif: Latin text changes typeface, Hindi keeps its own font, and the words are the same', async () => {
    const rows = documentRows({ fields }, { ...values, customer: 'Asha आशा' }, {});
    const sans = await renderDocument(input({ rows }));
    const serif = await renderDocument(input({ rows, options: { font: 'serif' } }));
    expect(serif.toString('latin1')).toContain('NotoSerif');
    expect(sans.toString('latin1')).not.toContain('NotoSerif');
    expect(serif.toString('latin1')).toContain('NotoSansDevanagari');
    expect((await pdfParse(serif)).text).toContain('Asha');
  });

  it('prints the closing note under the answers', async () => {
    const pdf = await renderDocument(input({ rows: documentRows({ fields }, values, { note: 'Keep this for your records.' }) }));
    expect((await pdfParse(pdf)).text).toContain('Keep this for your records.');
  });

  it('a signature that is not a picture the form drew is not put in the document', () => {
    expect(documentRows({ fields }, { sign: 'data:image/svg+xml;base64,PHN2Zz4=' })).toEqual([]);
  });
});

describe('The document itself', () => {
  it('is a PDF carrying the organisation, the form, the record and every answer as text', async () => {
    const pdf = await renderDocument(input({ options: { footer: 'Confidential' } }));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    if (process.env.PDF_SAMPLE) writeFileSync(process.env.PDF_SAMPLE, pdf);
    const text = await textOf(pdf);
    for (const part of ['Acme Trading', 'Customer complaint', 'Reference CMP-000042', 'Submitted 2026-10-09 05:30 UTC', 'Status New', 'Customer', 'Asha Textiles', 'Serious', 'Delivery', 'Pune', 'Items', 'Pen', 'Ink', '2 files attached', 'Signature', 'Confidential', 'Generated 2026-10-09 06:00 UTC', 'Page 1 of 1']) {
      expect(text).toContain(part);
    }
    const parsed = await pdfParse(pdf);
    expect(parsed.numpages).toBe(1);
    expect(parsed.info).toMatchObject({ Title: 'Customer complaint', Author: 'Acme Trading', Creator: 'Form Builder' });
  });

  it('is the same every time for the same input', async () => {
    const a = await renderDocument(input());
    const b = await renderDocument(input());
    expect(a.equals(b)).toBe(true);
  });

  it('runs onto more pages when it must, numbering each', async () => {
    const many: FormField[] = Array.from({ length: 80 }, (_, i) => ({ id: `f${i}`, type: 'TEXT', name: `f${i}`, label: `Question ${i + 1}` }));
    const pdf = await renderDocument(input({ rows: documentRows({ fields: many }, Object.fromEntries(many.map((f, i) => [f.name, `Answer ${i + 1}`]))) }));
    const parsed = await pdfParse(pdf);
    expect(parsed.numpages).toBeGreaterThan(2);
    const text = parsed.text.replace(/\s+/g, ' ');
    expect(text).toContain('Answer 80');
    expect(text).toContain(`Page ${parsed.numpages} of ${parsed.numpages}`);
    // A very long answer flows across pages instead of being cut.
    const long = await pdfParse(await renderDocument(input({ rows: [{ kind: 'answer', label: 'Story', value: 'word '.repeat(4000) + 'THE-END' }] })));
    expect(long.numpages).toBeGreaterThan(1);
    expect(long.text).toContain('THE-END');
  });

  it('treats what people typed as text, whatever it looks like', async () => {
    const hostile = '<script>alert(1)</script> %PDF-1.7 \u0000\u0007 (/JavaScript) \\) BT /F1 ET';
    const pdf = await renderDocument(input({ org: { name: hostile }, rows: [{ kind: 'answer', label: hostile, value: hostile }, { kind: 'table', label: 'T', columns: [hostile], rows: [[hostile]] }] }));
    const text = await textOf(pdf);
    expect(text).toContain('<script>alert(1)</script>');
    // Nothing that runs: no script, no action, no embedded file, in the file itself.
    const raw = pdf.toString('latin1');
    expect(raw).not.toMatch(/\/JS\b|\/JavaScript\s*\/|\/OpenAction|\/AA\b|\/EmbeddedFile|\/Launch/);
  });

  it('writes Hindi and accented names in a font that has the letters', async () => {
    const runs = fontRuns('Name: आशा राव, Zoë Müller, Łódź ₹500');
    // Nothing is lost or reordered, and each kind of letter goes to a font that has it.
    expect(runs.map((r) => r.text).join('')).toBe('Name: आशा राव, Zoë Müller, Łódź ₹500');
    expect(runs.find((r) => r.text.includes('आशा'))?.script).toBe('devanagari');
    expect(runs.find((r) => r.text.includes('Zoë'))?.script).toBe('latin');
    expect(runs.find((r) => r.text.includes('Ł'))?.script).toBe('latinExt');
    expect(runs.find((r) => r.text.includes('₹'))?.script).toBe('devanagari');
    const pdf = await renderDocument(input({ rows: [{ kind: 'answer', label: 'नाम', value: 'आशा राव, Zoë Müller, Łódź' }] }));
    expect(pdf.length).toBeGreaterThan(2000);
    const text = await textOf(pdf);
    expect(text).toContain('Zoë Müller');
  });

  it('writes the major Indian scripts, each in its own font, and only carries the fonts a document uses', async () => {
    const samples: Record<string, string> = {
      devanagari: 'नमस्ते',
      bengali: 'নমস্কার',
      gurmukhi: 'ਸਤ ਸ੍ਰੀ ਅਕਾਲ',
      gujarati: 'નમસ્તે',
      oriya: 'ନମସ୍କାର',
      tamil: 'வணக்கம்',
      telugu: 'నమస్కారం',
      kannada: 'ನಮಸ್ಕಾರ',
      malayalam: 'നമസ്കാരം',
    };
    for (const [script, text] of Object.entries(samples)) expect(fontRuns(text).map((r) => r.script)).toEqual([script]);
    // The rupee sign takes the script it stands in; digits are always Latin; nothing is lost.
    expect(fontRuns('மொத்தம் ₹500').map((r) => `${r.script}:${r.text}`)).toEqual(['tamil:மொத்தம் ₹', 'latin:500']);

    const english = await renderDocument(input({ rows: [{ kind: 'answer', label: 'Name', value: 'Asha' }] }));
    const all = await renderDocument(input({ rows: Object.entries(samples).map(([script, text]) => ({ kind: 'answer' as const, label: script, value: `${text} / ${script}` })) }));
    expect(await pdfParse(all).then((p) => p.numpages)).toBe(1);
    expect(await textOf(all)).toContain('/ malayalam');
    // Nine more fonts are inside the second document, and none of them in the first.
    const fontsIn = (pdf: Buffer) => (pdf.toString('latin1').match(/\/FontFile[23]?\b/g) ?? []).length;
    expect(fontsIn(all)).toBeGreaterThanOrEqual(fontsIn(english) + 9);
    if (process.env.PDF_SAMPLE) writeFileSync(process.env.PDF_SAMPLE.replace('.pdf', '-scripts.pdf'), all);
  });

  it('a logo or a brand colour that is not what it should be is left out; the document still stands', async () => {
    const pdf = await renderDocument(input({ org: { name: 'Acme', logo: 'data:image/png;base64,bm90LWFuLWltYWdl', color: 'red; drop table' } }));
    expect(await textOf(pdf)).toContain('Asha Textiles');
    const withLogo = await renderDocument(input({ org: { name: 'Acme', logo: sign } }));
    expect(withLogo.length).toBeGreaterThan(pdf.length - 2000);
    expect(await textOf(await renderDocument(input({ rows: [] })))).toContain('Nothing was answered.');
  });
});
