import { answerText, isValueField, type FormDefinition, type FormField, type FormValues } from '@fb/engine';
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFTextField } from 'pdf-lib';

/** The largest PDF an organisation may keep as a template. */
export const OWN_PDF_MAX_BYTES = 4 * 1024 * 1024;

const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The boxes of a fillable PDF that can take an answer: text boxes, tick boxes, and choices. A signature box or a
 * button is not something an answer goes into. Nothing in the file is run or drawn; only its list of boxes is read.
 */
export async function fillableBoxes(pdf: Buffer): Promise<{ name: string; kind: 'text' | 'tick' | 'choice' }[]> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const boxes: { name: string; kind: 'text' | 'tick' | 'choice' }[] = [];
  for (const f of doc.getForm().getFields()) {
    const name = f.getName();
    if (f instanceof PDFTextField) boxes.push({ name, kind: 'text' });
    else if (f instanceof PDFCheckBox) boxes.push({ name, kind: 'tick' });
    else if (f instanceof PDFRadioGroup || f instanceof PDFDropdown || f instanceof PDFOptionList) boxes.push({ name, kind: 'choice' });
  }
  return boxes.slice(0, 500);
}

/**
 * Which question of the form goes into a box: the one the designer chose, or, when they chose nothing, the one
 * whose name or label is the box's name give or take spaces and capitals (so a well-named PDF needs no mapping).
 */
export function questionFor(def: Pick<FormDefinition, 'fields'>, box: string, map: Record<string, string> = {}): FormField | undefined {
  const questions = def.fields.filter((f) => isValueField(f) && f.type !== 'HIDDEN' && f.type !== 'CAPTCHA' && f.type !== 'FILE' && f.type !== 'SIGNATURE' && f.type !== 'REPEAT');
  if (box in map) return questions.find((f) => f.name === map[box]);
  const want = plain(box);
  return questions.find((f) => plain(f.name) === want) ?? questions.find((f) => !!f.label && plain(f.label) === want);
}

/**
 * The organisation's own PDF with a response written into it. Text goes in as words (an option's label, not its
 * stored value); a tick box is ticked for yes; a choice is set when the PDF offers that choice. The result is
 * flattened: what was filled in is part of the page and can no longer be typed over.
 */
export async function fillOwnPdf(template: Buffer, def: Pick<FormDefinition, 'fields'>, values: FormValues, map: Record<string, string> = {}): Promise<Buffer> {
  const doc = await PDFDocument.load(template, { updateMetadata: false });
  const form = doc.getForm();
  for (const box of form.getFields()) {
    const question = questionFor(def, box.getName(), map);
    if (!question) continue;
    const value = values[question.name];
    const empty = value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
    try {
      if (box instanceof PDFTextField) {
        const text = empty ? '' : answerText(question, value);
        const most = box.getMaxLength();
        box.setText(most ? text.slice(0, most) : text);
      } else if (box instanceof PDFCheckBox) {
        if (value === true || value === 'true' || value === 'YES' || value === 'yes') box.check();
        else box.uncheck();
      } else if (!empty && (box instanceof PDFRadioGroup || box instanceof PDFDropdown || box instanceof PDFOptionList)) {
        // The PDF's own choices decide what can be set: the answer's label first, then its stored value.
        const offered = box.getOptions();
        const wanted = [answerText(question, value), String(value)].find((v) => offered.includes(v));
        if (wanted) box.select(wanted);
      }
    } catch {
      // A box the PDF library cannot write to (an unusual font, a broken appearance) is left as it was.
    }
  }
  form.flatten();
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
