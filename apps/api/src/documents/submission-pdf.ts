import { readFileSync } from 'node:fs';
import { answerText, isEmptyValue, isRepeat, isSignature, isValueField, type FormDefinition, type FormField, type FormValues } from '@fb/engine';
import PDFDocument from 'pdfkit';

/**
 * The document of record: one submission as a PDF, made on the server with
 * no browser. Text only reaches the page as text (never as markup), so what
 * someone typed into a form cannot change what the document does.
 */

export type DocumentRow =
  | { kind: 'heading'; text: string }
  | { kind: 'answer'; label: string; value: string }
  | { kind: 'image'; label: string; png: Buffer }
  /** What follows starts on a new page. */
  | { kind: 'break' }
  /** A closing paragraph in the form owner's words. */
  | { kind: 'note'; text: string }
  | { kind: 'table'; label: string; columns: string[]; rows: string[][] };

export interface DocumentOptions {
  /** Shown as the document's title; the form's name when left out. */
  title?: string;
  /** A line at the foot of every page. */
  footer?: string;
  /** Questions nobody answered are listed too, as "Not answered". */
  showEmpty?: boolean;
  /** Questions and sections (by name) that are not printed. */
  leaveOut?: string[];
  /** A closing paragraph under the answers. */
  note?: string;
  /** Sections (by name) that start on a new page. */
  newPage?: string[];
}

export interface DocumentInput {
  org: { name: string; logo?: string; color?: string };
  form: { name: string; code: string; version: number };
  record: { ref?: string; submittedAt: Date; status?: string };
  options?: DocumentOptions;
  rows: DocumentRow[];
  /** Stamped in the footer and in the file's own details. */
  generatedAt: Date;
}

const label = (f: FormField) => f.label || f.name;
const SKIPPED = new Set<FormField['type']>(['HIDDEN', 'CAPTCHA', 'HTML', 'BUTTON', 'IMAGE']);

/**
 * What a submission says, in the order the form asks it: section titles,
 * answers in words (an option's label, not its stored value), signatures as
 * pictures and repeating sections as tables.
 */
export function documentRows(def: Pick<FormDefinition, 'fields'>, values: FormValues, options: DocumentOptions = {}): DocumentRow[] {
  const children = new Map<string, FormField[]>();
  for (const f of def.fields) children.set(f.parentId ?? '', [...(children.get(f.parentId ?? '') ?? []), f]);
  const out: DocumentRow[] = [];
  const leftOut = new Set(options.leaveOut ?? []);
  const newPage = new Set(options.newPage ?? []);
  const walk = (parentId: string) => {
    for (const f of children.get(parentId) ?? []) {
      // Left out by the form's owner: a section takes everything in it along.
      if (SKIPPED.has(f.type) || leftOut.has(f.name)) continue;
      if (isRepeat(f)) {
        const columns = (children.get(f.id) ?? []).filter(isValueField);
        const list = Array.isArray(values[f.name]) ? (values[f.name] as Record<string, unknown>[]) : [];
        if (list.length || options.showEmpty) out.push({ kind: 'table', label: label(f), columns: columns.map(label), rows: list.map((row) => columns.map((c) => answerText(c, row?.[c.name]))) });
        continue;
      }
      if (!isValueField(f)) {
        // A container: its title, then what it holds. A title with nothing under it is taken back.
        const at = out.length;
        // A new page for this section, unless it would be the document's first thing (or the section turns out empty).
        const breaks = f.type === 'SECTION' && newPage.has(f.name) && out.some((r) => r.kind !== 'break');
        if (breaks) out.push({ kind: 'break' });
        if (f.type === 'SECTION' && f.label) out.push({ kind: 'heading', text: f.label });
        const before = out.length;
        walk(f.id);
        if (out.length === before) out.length = at;
        continue;
      }
      const value = values[f.name];
      if (f.type === 'SIGNATURE') {
        // Only a picture the form itself drew is shown; anything else in its place is not a signature.
        if (isSignature(value)) out.push({ kind: 'image', label: label(f), png: Buffer.from((value as string).slice((value as string).indexOf(',') + 1), 'base64') });
        else if (options.showEmpty) out.push({ kind: 'answer', label: label(f), value: 'Not signed' });
      } else if (f.type === 'FILE') {
        const n = Array.isArray(value) ? value.length : 0;
        if (n || options.showEmpty) out.push({ kind: 'answer', label: label(f), value: n ? `${n} file${n === 1 ? '' : 's'} attached` : 'Not answered' });
      } else if (!isEmptyValue(value)) {
        out.push({ kind: 'answer', label: label(f), value: answerText(f, value) });
      } else if (options.showEmpty) {
        out.push({ kind: 'answer', label: label(f), value: 'Not answered' });
      }
    }
  };
  walk('');
  if (options.note?.trim()) out.push({ kind: 'note', text: options.note.trim() });
  return out;
}

// ── Fonts ──────────────────────────────────────────────────────────────────
// Noto Sans, so the document reads the same on every machine and covers more than Latin.
const INDIC = ['devanagari', 'bengali', 'gurmukhi', 'gujarati', 'oriya', 'tamil', 'telugu', 'kannada', 'malayalam'] as const;
const FONT_FILES = {
  latin: '@fontsource/noto-sans/files/noto-sans-latin-{w}-normal.woff',
  latinExt: '@fontsource/noto-sans/files/noto-sans-latin-ext-{w}-normal.woff',
  ...(Object.fromEntries(INDIC.map((s) => [s, `@fontsource/noto-sans-${s}/files/noto-sans-${s}-${s}-{w}-normal.woff`])) as Record<(typeof INDIC)[number], string>),
} as const;
type Script = keyof typeof FONT_FILES;
/** Each script's block of Unicode, in the order the blocks come. */
const BLOCKS: [number, number, Script][] = [
  [0x0900, 0x097f, 'devanagari'],
  [0x0980, 0x09ff, 'bengali'],
  [0x0a00, 0x0a7f, 'gurmukhi'],
  [0x0a80, 0x0aff, 'gujarati'],
  [0x0b00, 0x0b7f, 'oriya'],
  [0x0b80, 0x0bff, 'tamil'],
  [0x0c00, 0x0c7f, 'telugu'],
  [0x0c80, 0x0cff, 'kannada'],
  [0x0d00, 0x0d7f, 'malayalam'],
];
const loaded = new Map<string, Buffer>();
/** A font file, read from disk the first time a document needs it. */
function fontData(name: string): Buffer {
  let data = loaded.get(name);
  if (!data) {
    const [script, weight] = name.split('-') as [Script, string];
    data = readFileSync(require.resolve(FONT_FILES[script].replace('{w}', weight)));
    loaded.set(name, data);
  }
  return data;
}

/** Which of our fonts can draw a character. Latin first: it is what almost everything is in. */
function scriptOf(cp: number, around: Script | undefined): Script {
  // The rupee sign, the joiners that shape conjuncts and the danda are shared: they stay in the script around them.
  if (cp === 0x20b9 || cp === 0x200c || cp === 0x200d || cp === 0x0964 || cp === 0x0965) return around && around !== 'latin' && around !== 'latinExt' ? around : 'devanagari';
  for (const [from, to, script] of BLOCKS) if (cp >= from && cp <= to) return script;
  if ((cp >= 0x0100 && cp <= 0x024f) || (cp >= 0x1e00 && cp <= 0x1eff)) return 'latinExt';
  return 'latin';
}

/** A string cut where the font has to change. */
export function fontRuns(text: string): { script: Script; text: string }[] {
  const runs: { script: Script; text: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // A space or a line break stays with whatever is around it. Digits and punctuation are Latin's:
    // the other fonts do not all have them, and a missing one would be drawn as an empty box.
    const neutral = cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d;
    const script = neutral && runs.length ? runs[runs.length - 1]!.script : scriptOf(cp, runs[runs.length - 1]?.script);
    if (runs.length && runs[runs.length - 1]!.script === script) runs[runs.length - 1]!.text += ch;
    else runs.push({ script, text: ch });
  }
  return runs;
}

/**
 * Letters are never joined into one shape ("fi"): some readers cannot search or copy text that is.
 * What a script needs to be written at all (Devanagari conjuncts) is not affected.
 */
const PLAIN = { liga: false, clig: false, dlig: false } as unknown as PDFKit.Mixins.OpenTypeFeatures[];
/**
 * The text library cannot place marks that sit above a letter in these two fonts (it stops
 * with an error), so that one refinement is left out for them: the marks are drawn where the
 * font puts them by default. Every letter is still there.
 */
const NO_ABOVE_MARKS = { liga: false, clig: false, dlig: false, abvm: false } as unknown as PDFKit.Mixins.OpenTypeFeatures[];
const featuresFor = (script: string) => (script === 'gurmukhi' || script === 'malayalam' ? NO_ABOVE_MARKS : PLAIN);

const MARGIN = 50;
const LABEL_WIDTH = 170;
const GAP = 14;
const INK = '#111827';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
/** A brand colour is used only if it is a plain hex colour. */
const colour = (c: string | undefined) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#1f2937');
/** Control characters have no place in a document; tabs and line breaks are kept. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');

/** Draws the document. Resolves with the finished PDF. */
export function renderDocument(input: DocumentInput): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN + 20, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: clean(input.options?.title || input.form.name), Author: clean(input.org.name), Creator: 'Form Builder', CreationDate: input.generatedAt, ModDate: input.generatedAt },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - MARGIN * 2;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  // A font is given to the document the first time it is used, so one in English carries no others.
  const registered = new Set<string>();
  const font = (script: Script, bold: boolean) => {
    const name = `${script}-${bold ? '700' : '400'}`;
    if (!registered.has(name)) {
      doc.registerFont(name, fontData(name));
      registered.add(name);
    }
    return doc.font(name);
  };

  /** How tall a piece of text will be at this width. Measured in the font most of it is in. */
  const heightOf = (text: string, w: number, size: number, bold = false) => {
    const runs = fontRuns(text);
    const main = runs.reduce((a, b) => (b.text.length > a.text.length ? b : a), runs[0] ?? { script: 'latin' as Script, text: '' });
    font(main.script, bold).fontSize(size);
    return doc.heightOfString(text || ' ', { width: w, features: featuresFor(main.script) });
  };
  /** Writes text at a place, changing font wherever the script changes. */
  const write = (raw: string, x: number, y: number, w: number, size: number, opts: { bold?: boolean; color?: string; align?: 'left' | 'right' | 'center' } = {}) => {
    const text = clean(raw);
    const runs = fontRuns(text);
    doc.fillColor(opts.color ?? INK).fontSize(size);
    if (runs.length <= 1) {
      font(runs[0]?.script ?? 'latin', !!opts.bold).text(text || ' ', x, y, { width: w, align: opts.align ?? 'left', features: featuresFor(runs[0]?.script ?? 'latin') });
      return;
    }
    runs.forEach((run, i) => {
      font(run.script, !!opts.bold);
      if (i === 0) doc.text(run.text, x, y, { width: w, continued: true, features: featuresFor(run.script) });
      else doc.text(run.text, { continued: i < runs.length - 1, features: featuresFor(run.script) });
    });
  };
  /** Starts a new page if `need` points will not fit on this one. */
  const room = (need: number) => {
    if (doc.y + need > bottom()) doc.addPage();
  };

  // ── Head: logo, organisation, title, what record this is ──
  let y = MARGIN;
  const logo = /^data:image\/(png|jpe?g);base64,/.exec(input.org.logo ?? '');
  if (logo) {
    try {
      doc.image(Buffer.from(input.org.logo!.slice(input.org.logo!.indexOf(',') + 1), 'base64'), MARGIN, y, { fit: [120, 34] });
      y += 42;
    } catch {
      // A logo that cannot be read is left out; the document still stands.
    }
  }
  write(input.org.name, MARGIN, y, width, 10, { color: MUTED });
  y = doc.y + 2;
  write(input.options?.title || input.form.name, MARGIN, y, width, 18, { bold: true });
  y = doc.y + 4;
  const facts = [input.record.ref ? `Reference ${input.record.ref}` : '', `Submitted ${input.record.submittedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`, input.record.status ? `Status ${input.record.status}` : ''].filter(Boolean);
  write(facts.join('   ·   '), MARGIN, y, width, 9.5, { color: MUTED });
  y = doc.y + 8;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(1.5).strokeColor(colour(input.org.color)).stroke();
  doc.y = y + 14;

  // ── Body ──
  for (const row of input.rows) {
    if (row.kind === 'heading') {
      room(40);
      doc.y += 6;
      write(row.text, MARGIN, doc.y, width, 12.5, { bold: true });
      doc.y += 6;
    } else if (row.kind === 'answer') {
      const valueWidth = width - LABEL_WIDTH - GAP;
      const h = Math.max(heightOf(clean(row.label), LABEL_WIDTH, 10, true), heightOf(clean(row.value), valueWidth, 10));
      // An answer longer than a page flows on; anything else moves to the next page whole.
      room(Math.min(h, bottom() - MARGIN) + 12);
      const top = doc.y;
      write(row.label, MARGIN, top, LABEL_WIDTH, 10, { bold: true, color: '#374151' });
      const afterLabel = doc.y;
      write(row.value, MARGIN + LABEL_WIDTH + GAP, top, valueWidth, 10);
      doc.y = Math.max(afterLabel, doc.y) + 5;
      doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.y += 6;
    } else if (row.kind === 'break') {
      doc.addPage();
      doc.y = MARGIN;
    } else if (row.kind === 'note') {
      room(Math.min(heightOf(clean(row.text), width, 9.5), bottom() - MARGIN) + 20);
      doc.y += 8;
      write(row.text, MARGIN, doc.y, width, 9.5, { color: MUTED });
      doc.y += 6;
    } else if (row.kind === 'image') {
      room(90);
      const top = doc.y;
      write(row.label, MARGIN, top, LABEL_WIDTH, 10, { bold: true, color: '#374151' });
      try {
        doc.image(row.png, MARGIN + LABEL_WIDTH + GAP, top, { fit: [220, 66] });
      } catch {
        write('(signature could not be shown)', MARGIN + LABEL_WIDTH + GAP, top, width - LABEL_WIDTH - GAP, 10, { color: MUTED });
      }
      doc.y = top + 74;
      doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
      doc.y += 6;
    } else {
      room(60);
      write(row.label, MARGIN, doc.y, width, 10, { bold: true, color: '#374151' });
      doc.y += 4;
      const n = Math.max(1, row.columns.length);
      const col = (width - (n - 1) * 8) / n;
      const line = (cells: string[], bold: boolean) => {
        const h = Math.max(...cells.map((c) => heightOf(clean(c), col, 9.5, bold)), 12);
        room(h + 8);
        const top = doc.y;
        cells.forEach((c, i) => write(c, MARGIN + i * (col + 8), top, col, 9.5, { bold, color: bold ? '#374151' : INK }));
        doc.y = top + h + 3;
        doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + width, doc.y).lineWidth(0.5).strokeColor(LINE).stroke();
        doc.y += 4;
      };
      line(row.columns.length ? row.columns : ['-'], true);
      if (!row.rows.length) line(['No rows'], false);
      for (const r of row.rows) line(r, false);
      doc.y += 4;
    }
  }
  if (!input.rows.some((r) => r.kind !== 'note' && r.kind !== 'break')) write('Nothing was answered.', MARGIN, doc.y, width, 10, { color: MUTED });

  // ── Foot of every page ──
  const pages = doc.bufferedPageRange();
  const stamp = `Generated ${input.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    const footY = doc.page.height - MARGIN - 6;
    // Written below the bottom margin: without this pdfkit would start a new page for it.
    doc.page.margins.bottom = 0;
    doc.moveTo(MARGIN, footY - 6).lineTo(MARGIN + width, footY - 6).lineWidth(0.5).strokeColor(LINE).stroke();
    write([input.options?.footer, stamp].filter(Boolean).join('   ·   '), MARGIN, footY, width - 90, 8, { color: MUTED });
    write(`Page ${i + 1} of ${pages.count}`, MARGIN + width - 90, footY, 90, 8, { color: MUTED, align: 'right' });
  }
  doc.end();
  return done;
}
