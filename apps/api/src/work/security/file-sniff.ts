// file-type@16.5.4 is the last CommonJS release (this API compiles to CommonJS).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FileType: { fromBuffer(buf: Buffer): Promise<{ ext: string; mime: string } | undefined> } = require('file-type');

/**
 * ASF / WMV header GUID. file-type < 21.3.1 has an infinite loop in its ASF
 * parser on crafted input (moderate advisory). ASF is never an allowed upload
 * type, so reject it before the parser runs - the vulnerable path is never reached.
 */
const ASF_GUID = Buffer.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]);

/** How many leading bytes are read from S3 to identify a file. */
export const SNIFF_BYTES = 4100;

export interface SniffResult {
  mime: string;
  ext: string;
}

/** The file's real type from its content, or undefined if unknown / refused. */
export async function sniffFileType(head: Buffer): Promise<SniffResult | undefined> {
  if (head.length >= ASF_GUID.length && head.subarray(0, ASF_GUID.length).equals(ASF_GUID)) return undefined;
  return FileType.fromBuffer(head.subarray(0, SNIFF_BYTES));
}

/**
 * Does a detected type satisfy a field's accept list? Entries may be exact
 * mimes (`application/pdf`), wildcards (`image/*`) or extensions (`.docx`).
 * Text formats (SVG, HTML, CSV) aren't detectable from bytes and are refused -
 * SVG in particular can carry script.
 */
export function mimeAllowed(detected: SniffResult, accept: string[]): boolean {
  if (detected.mime === 'image/svg+xml') return false;
  return accept.some((a) => {
    const rule = a.trim().toLowerCase();
    if (rule.startsWith('.')) return rule.slice(1) === detected.ext;
    if (rule.endsWith('/*')) return detected.mime.startsWith(rule.slice(0, -1));
    return rule === detected.mime;
  });
}
