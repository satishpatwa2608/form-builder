import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { fieldsFromPdfFields } from '@fb/engine';
import { readPdfFields } from './pdf-fields';

/** A real fillable PDF, made here: the same kind of file a customer would bring. */
async function fillable(): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 500]);
  const form = doc.getForm();
  const name = form.createTextField('applicant.full_name');
  name.enableRequired();
  name.setMaxLength(60);
  name.addToPage(page, { x: 20, y: 440, width: 200, height: 20 });
  const notes = form.createTextField('notes');
  notes.enableMultiline();
  notes.addToPage(page, { x: 20, y: 380, width: 200, height: 40 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 20, y: 340, width: 14, height: 14 });
  const plan = form.createRadioGroup('plan');
  plan.addOptionToPage('Basic', page, { x: 20, y: 300, width: 14, height: 14 });
  plan.addOptionToPage('Premium', page, { x: 60, y: 300, width: 14, height: 14 });
  const state = form.createDropdown('state');
  state.addOptions(['Kerala', 'Punjab']);
  state.addToPage(page, { x: 20, y: 260, width: 120, height: 20 });
  const langs = form.createOptionList('languages');
  langs.addOptions(['Hindi', 'Tamil', 'Telugu']);
  langs.enableMultiselect();
  langs.addToPage(page, { x: 20, y: 180, width: 120, height: 60 });
  const send = form.createButton('send');
  send.addToPage('Send', page, { x: 20, y: 140, width: 60, height: 20 });
  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('Reading a fillable PDF', () => {
  it('finds every field with its kind, choices, length and whether it is required', async () => {
    expect(await readPdfFields(await fillable())).toEqual([
      { name: 'applicant.full_name', kind: 'text', required: true, multiline: false, maxLength: 60 },
      { name: 'notes', kind: 'text', required: false, multiline: true, maxLength: undefined },
      { name: 'agree', kind: 'checkbox', required: false },
      { name: 'plan', kind: 'radio', required: false, options: ['Basic', 'Premium'] },
      { name: 'state', kind: 'dropdown', required: false, options: ['Kerala', 'Punjab'] },
      { name: 'languages', kind: 'list', required: false, options: ['Hindi', 'Tamil', 'Telugu'], multiple: true },
      { name: 'send', kind: 'button', required: false },
    ]);
  });

  it('becomes a form: labels for people, the button left out', async () => {
    const { fields, notes } = fieldsFromPdfFields(await readPdfFields(await fillable()));
    expect(fields.map((f) => `${f.label}: ${f.type}${f.required ? ' (required)' : ''}`)).toEqual(['Full name: TEXT (required)', 'Notes: TEXTAREA', 'Agree: CHECKBOX', 'Plan: RADIO', 'State: DROPDOWN', 'Languages: MULTI_SELECT']);
    expect(notes).toEqual([]);
  });

  it('a PDF with nothing to fill in says so; a file that is not a PDF is refused', async () => {
    const flat = await PDFDocument.create();
    flat.addPage();
    const bytes = await flat.save();
    const { notes } = fieldsFromPdfFields(await readPdfFields(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    expect(notes).toEqual(['This PDF has no fillable fields. A scanned or flat PDF cannot be read this way.']);
    await expect(readPdfFields(new TextEncoder().encode('not a pdf at all').buffer as ArrayBuffer)).rejects.toThrow();
  });
});
