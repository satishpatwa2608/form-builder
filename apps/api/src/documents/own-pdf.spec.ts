import { PDFDocument } from 'pdf-lib';
import { readPdf as pdfParse } from '../../test/read-pdf';
import type { FormField } from '@fb/engine';
import { fillableBoxes, fillOwnPdf, questionFor } from './own-pdf';

/** A small fillable PDF of the customer's own: three text boxes, a tick box, a choice, and a button. */
async function ownPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const form = doc.getForm();
  page.drawText('Claim form 7B', { x: 20, y: 370, size: 14 });
  form.createTextField('Full Name').addToPage(page, { x: 20, y: 320, width: 200, height: 20 });
  form.createTextField('policy_no').addToPage(page, { x: 20, y: 280, width: 200, height: 20 });
  const short = form.createTextField('Code');
  short.setMaxLength(4);
  short.addToPage(page, { x: 20, y: 240, width: 60, height: 20 });
  form.createCheckBox('Agreed').addToPage(page, { x: 20, y: 200, width: 14, height: 14 });
  const kind = form.createDropdown('Kind');
  kind.addOptions(['Theft', 'Accident']);
  kind.addToPage(page, { x: 20, y: 160, width: 120, height: 20 });
  form.createButton('Print').addToPage('Print', page, { x: 20, y: 120, width: 60, height: 20 });
  return Buffer.from(await doc.save());
}

const fields: FormField[] = [
  { id: 'a', type: 'TEXT', name: 'fullName', label: 'Your name' },
  { id: 'b', type: 'TEXT', name: 'policy', label: 'Policy no' },
  { id: 'c', type: 'TEXT', name: 'code', label: 'Code' },
  { id: 'd', type: 'CHECKBOX', name: 'agreed', label: 'I agree' },
  { id: 'e', type: 'DROPDOWN', name: 'kind', label: 'Kind', dataSource: { type: 'STATIC', options: [{ label: 'Theft', value: 'THEFT' }, { label: 'Accident', value: 'ACC' }] } },
  { id: 'f', type: 'TEXT', name: 'secret', label: 'Not on the PDF' },
];

describe("an organisation's own PDF, filled with a response", () => {
  it('finds the boxes an answer can go into, and leaves buttons out', async () => {
    expect(await fillableBoxes(await ownPdf())).toEqual([
      { name: 'Full Name', kind: 'text' },
      { name: 'policy_no', kind: 'text' },
      { name: 'Code', kind: 'text' },
      { name: 'Agreed', kind: 'tick' },
      { name: 'Kind', kind: 'choice' },
    ]);
  });

  it('matches a box to a question by name or label, give or take spaces and capitals, unless the designer chose', () => {
    expect(questionFor({ fields }, 'Full Name')?.name).toBe('fullName');
    expect(questionFor({ fields }, 'policy_no')?.name).toBe('policy');
    expect(questionFor({ fields }, 'Something else')).toBeUndefined();
    expect(questionFor({ fields }, 'Something else', { 'Something else': 'secret' })?.name).toBe('secret');
    // Chosen "nothing" for a box that would have matched: it stays empty.
    expect(questionFor({ fields }, 'Full Name', { 'Full Name': '' })).toBeUndefined();
  });

  it('writes the answers into the page, in words, and the result can no longer be typed over', async () => {
    const filled = await fillOwnPdf(await ownPdf(), { fields }, { fullName: 'Asha Rao', policy: 'P-778', code: 'ABCDEFG', agreed: true, kind: 'ACC', secret: 'never shown' });
    const text = (await pdfParse(filled)).text;
    expect(text).toContain('Claim form 7B');
    expect(text).toContain('Asha Rao');
    expect(text).toContain('P-778');
    // A box that takes four characters gets four.
    expect(text).toContain('ABCD');
    expect(text).not.toContain('ABCDE');
    // The option's label, as the PDF offers it, not the stored value.
    expect(text).toContain('Accident');
    expect(text).not.toContain('never shown');
    expect((await PDFDocument.load(filled)).getForm().getFields()).toHaveLength(0);
  });

  it('leaves nothing in the filled PDF pointing at a box that is no longer there', async () => {
    const filled = (await fillOwnPdf(await ownPdf(), { fields }, { fullName: 'Asha Rao', agreed: true })).toString('latin1');
    const there = new Set([...filled.matchAll(/(?:^|\n)(\d+) 0 obj/g)].map((m) => m[1]));
    const pointedAt = [...filled.matchAll(/(\d+) 0 R/g)].map((m) => m[1]!);
    expect(pointedAt.length).toBeGreaterThan(0);
    expect(pointedAt.filter((n) => !there.has(n))).toEqual([]);
  });

  it('a small filled PDF is read wherever in memory it happens to sit', async () => {
    // Under 4 KB, which is where the reader used in these tests once went wrong now and then: see test/read-pdf.ts.
    const doc = await PDFDocument.create();
    doc.getForm().createTextField('Full name').addToPage(doc.addPage([300, 200]), { x: 20, y: 120, width: 200, height: 20 });
    const filled = await fillOwnPdf(Buffer.from(await doc.save()), { fields }, { fullName: 'Asha Rao' });
    expect(filled.length).toBeLessThan(4096);
    for (const offset of [0, 8, 1000]) {
      const shared = Buffer.from(new ArrayBuffer(8192), offset, filled.length);
      filled.copy(shared);
      expect((await pdfParse(shared)).text).toContain('Asha Rao');
    }
  });

  it('an unanswered question leaves its box empty, and something that is not a PDF is refused', async () => {
    const filled = await fillOwnPdf(await ownPdf(), { fields }, { fullName: 'Only this' });
    expect((await pdfParse(filled)).text).toContain('Only this');
    await expect(fillableBoxes(Buffer.from('not a pdf at all'))).rejects.toThrow();
  });
});
