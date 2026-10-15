/**
 * The PDF made of each response. `keep` stores one with every submission as it
 * arrives; without it a PDF is still made when someone asks for it.
 */
export interface DocumentSettings {
  keep?: boolean;
  title?: string;
  footer?: string;
  showEmpty?: boolean;
  /** Names of questions (or whole sections) the PDF leaves out: asked on the form, kept on the record, not printed. */
  leaveOut?: string[];
  /** A closing paragraph under the answers: a disclaimer, or what happens next. */
  note?: string;
  /** Names of sections that start on a new page of the PDF. */
  newPage?: string[];
  /** Made to the archival standard (PDF/A-2b): everything it needs to be read in decades is inside the file. */
  archival?: boolean;
  /**
   * Sealed with the organisation's certificate: certified, with no changes allowed. A PDF reader then shows who
   * sealed it, will not edit it, and says plainly if it was altered. The signed copy of a response is sealed too.
   */
  seal?: boolean;
  /** The typeface of the PDF's Latin text: the usual sans-serif (left out), or a serif. Other scripts keep their own fonts. */
  font?: 'sans' | 'serif';
  /**
   * The organisation's own fillable PDF, used in place of the product's layout: each response is written into
   * it. `map` says which question goes into which of its boxes ('' for none); a box left out of the map takes
   * the question of the same name, if there is one.
   */
  ownPdf?: { id: string; name: string; map?: Record<string, string> };
}
