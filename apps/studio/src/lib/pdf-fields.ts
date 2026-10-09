import type { PdfFormField } from '@fb/engine';

/**
 * The fillable fields of a PDF form, read here in the browser: the file is
 * never sent anywhere. The PDF library is fetched only when someone picks a PDF.
 */
export async function readPdfFields(bytes: ArrayBuffer): Promise<PdfFormField[]> {
  const { PDFDocument, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFSignature, PDFButton } = await import('pdf-lib');
  // Nothing in it is run or drawn; only its list of fields is read.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc
    .getForm()
    .getFields()
    .map((f): PdfFormField => {
      const base = { name: f.getName(), required: f.isRequired() };
      if (f instanceof PDFTextField) return { ...base, kind: 'text', multiline: f.isMultiline(), maxLength: f.getMaxLength() };
      if (f instanceof PDFCheckBox) return { ...base, kind: 'checkbox' };
      if (f instanceof PDFRadioGroup) return { ...base, kind: 'radio', options: f.getOptions() };
      if (f instanceof PDFDropdown) return { ...base, kind: 'dropdown', options: f.getOptions() };
      if (f instanceof PDFOptionList) return { ...base, kind: 'list', options: f.getOptions(), multiple: f.isMultiselect() };
      if (f instanceof PDFSignature) return { ...base, kind: 'signature' };
      if (f instanceof PDFButton) return { ...base, kind: 'button' };
      return { ...base, kind: 'other' };
    });
}
