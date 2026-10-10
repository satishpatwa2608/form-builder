import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSealIdentity, sealPdf } from './pdf-seal';
import { renderDocument } from './submission-pdf';

/**
 * Our archival PDFs, put through veraPDF: the validator the PDF Association maintains, which shares nothing with
 * the code that makes them. It runs from its Docker image, so this is skipped where that image is not to hand
 * (it is a large download) and insisted on in CI (REQUIRE_VERAPDF).
 */
const IMAGE = 'verapdf/cli';
const have = spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** A document with everything ours can hold: headings, answers, another script, a picture, a table, a note, and enough text for a second page. */
const sample = (options: object) =>
  renderDocument({
    org: { name: 'Acme Trading' },
    form: { name: 'Loan agreement', code: 'LOAN', version: 3 },
    record: { ref: 'LN-000042', submittedAt: new Date('2026-10-01T10:00:00Z'), status: 'Newly arrived' },
    options: { archival: true, note: 'Keep this for your records.', ...options },
    rows: [
      { kind: 'heading', text: 'About you' },
      { kind: 'answer', label: 'Customer', value: 'Asha Textiles' },
      { kind: 'answer', label: 'नाम', value: 'आशा राव' },
      { kind: 'image', label: 'Signature', png: PNG },
      { kind: 'table', label: 'Lines', columns: ['Item', 'Quantity'], rows: [['Cotton', '40'], ['Silk', '5']] },
      { kind: 'break' },
      { kind: 'answer', label: 'Story', value: 'word '.repeat(900) },
    ] as never,
    generatedAt: new Date('2026-10-01T10:00:05Z'),
  });

(have || process.env.REQUIRE_VERAPDF ? describe : describe.skip)('archival PDFs, checked by veraPDF', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fb-pdfa-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('every kind we make is valid PDF/A-2b: plain, in the serif typeface, and sealed', async () => {
    const files = {
      'plain.pdf': await sample({}),
      'serif.pdf': await sample({ font: 'serif' }),
      'sealed.pdf': await sealPdf(await sample({}), await newSealIdentity('Acme Trading'), { reason: 'Sealed when it was made' }),
    };
    for (const [name, pdf] of Object.entries(files)) writeFileSync(join(dir, name), pdf);
    const run = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/data:ro`, IMAGE, '--flavour', '2b', '--format', 'text', ...Object.keys(files).map((f) => `/data/${f}`)], { encoding: 'utf8', timeout: 280_000 });
    const said = `${run.stdout}\n${run.stderr}`;
    for (const name of Object.keys(files)) expect(said).toContain(`PASS /data/${name} 2b`);
    expect(said).not.toMatch(/^FAIL /m);
  }, 300_000);

  it('and it does tell a document that is not archival from one that is', async () => {
    // The same document without the archival option: the validator must refuse it, or its "pass" above means nothing.
    writeFileSync(join(dir, 'ordinary.pdf'), await sample({ archival: false }));
    const run = spawnSync('docker', ['run', '--rm', '-v', `${dir}:/data:ro`, IMAGE, '--flavour', '2b', '--format', 'text', '/data/ordinary.pdf'], { encoding: 'utf8', timeout: 280_000 });
    expect(`${run.stdout}\n${run.stderr}`).toContain('FAIL /data/ordinary.pdf 2b');
  }, 300_000);
});
