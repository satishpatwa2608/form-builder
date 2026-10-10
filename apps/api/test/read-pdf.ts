import pdfParse from 'pdf-parse';

/**
 * Reads a PDF's text and page count in tests.
 *
 * Always use this, not `pdf-parse` directly. Given a Node Buffer, the reader copies it into another Buffer, and Node
 * keeps Buffers under 4 KB inside a shared block of memory; the reader then looks from the start of that block and not
 * from where the PDF begins, so a small PDF is refused ("bad XRef entry") whenever it does not land first in the block.
 * That depends on what else the process has allocated, which made a correct PDF fail now and then. Plain bytes are
 * copied into memory of their own, and are always read.
 */
export const readPdf = (pdf: Uint8Array) => pdfParse(new Uint8Array(pdf) as Buffer);
