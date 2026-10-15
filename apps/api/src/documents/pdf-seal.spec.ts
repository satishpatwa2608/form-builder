import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { PDFDocument } from 'pdf-lib';
import { readPdf } from '../../test/read-pdf';
import { identityFromFile, newSealIdentity, sealInfo, sealPdf, SealFileError, type SealIdentity } from './pdf-seal';
import { renderDocument } from './submission-pdf';

const has = (tool: string, ...args: string[]) => spawnSync(tool, args, { stdio: 'ignore' }).status === 0;
/** poppler's own checker of PDF signatures: a second opinion that shares no code with what made the seal. */
const PDFSIG = has('pdfsig', '-v');
const OPENSSL = has('openssl', 'version');

const document = (archival = false) =>
  renderDocument({
    org: { name: 'Acme Trading' },
    form: { name: 'Loan agreement', code: 'LOAN', version: 3 },
    record: { ref: 'LN-000042', submittedAt: new Date('2026-10-01T10:00:00Z') },
    options: archival ? { archival: true } : {},
    rows: [{ kind: 'answer', label: 'Customer', value: 'Asha Textiles' }, { kind: 'answer', label: 'Amount', value: '50,000' }],
    generatedAt: new Date('2026-10-01T10:00:05Z'),
  });

/** Checks a sealed PDF the way a reader does: the signature must be over exactly the bytes around it, by the certificate inside it. */
async function sealHolds(pdf: Buffer): Promise<boolean> {
  const text = pdf.toString('latin1');
  const range = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  if (!range) return false;
  const [a, b, c, d] = range.slice(1).map(Number) as [number, number, number, number];
  const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  // The signature is padded with zeros to the space kept for it. Read as a structure, it ends where it ends: cutting
  // the zeros off cut the signature too whenever its own last byte was zero (one seal in a couple of hundred).
  const der = Buffer.from(pdf.subarray(a + b + 1, c - 1).toString('latin1'), 'hex');
  try {
    const asn = asn1js.fromBER(new Uint8Array(der).buffer);
    if (asn.offset === -1) return false;
    const content = new pkijs.ContentInfo({ schema: asn.result });
    const data = new pkijs.SignedData({ schema: content.content });
    return await data.verify({ signer: 0, data: new Uint8Array(signed).buffer, checkChain: false });
  } catch {
    return false;
  }
}

describe('sealing a PDF', () => {
  let acme: SealIdentity;
  let dir: string;
  beforeAll(async () => {
    acme = await newSealIdentity('Acme Trading');
    dir = mkdtempSync(join(tmpdir(), 'fb-seal-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('a certificate made for an organisation carries its name, lasts ten years, and says it was issued by itself', () => {
    const info = sealInfo(acme);
    expect(info).toMatchObject({ subject: 'Acme Trading', issuer: 'Acme Trading', selfIssued: true });
    expect(new Date(info.validTo).getFullYear() - new Date(info.validFrom).getFullYear()).toBeGreaterThanOrEqual(9);
    expect(info.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(createPrivateKey(acme.privateKey).asymmetricKeyDetails?.modulusLength).toBe(2048);
  });

  it('the sealed PDF reads the same, certifies itself with no changes allowed, and its seal holds', async () => {
    const original = await document();
    const sealed = await sealPdf(original, acme, { reason: 'Sealed when it was made' });
    expect((await readPdf(sealed)).text).toBe((await readPdf(original)).text);
    expect((await PDFDocument.load(sealed)).getPageCount()).toBe((await PDFDocument.load(original)).getPageCount());
    const text = sealed.toString('latin1');
    // Certified (not merely signed), allowing nothing to be changed.
    expect(text).toMatch(/\/Perms\s*<<\s*\/DocMDP \d+ 0 R/);
    expect(text).toMatch(/\/TransformMethod \/DocMDP/);
    expect(text).toMatch(/\/P 1\b/);
    expect(text).toContain('/SubFilter /adbe.pkcs7.detached');
    expect(text).toContain('(Sealed when it was made)');
    expect(await sealHolds(sealed)).toBe(true);
  });

  it('one changed byte, anywhere in the document, breaks the seal', async () => {
    const sealed = await sealPdf(await document(), acme, { reason: 'Sealed' });
    // (The signature's own place in the file is the one stretch it cannot cover: these are either side of it.)
    const [, before, after] = /\/ByteRange\s*\[\s*0\s+(\d+)\s+(\d+)/.exec(sealed.toString('latin1'))!.map(Number) as [number, number, number];
    for (const at of [20, before - 30, after + 30, sealed.length - 40]) {
      const altered = Buffer.from(sealed);
      altered[at] = altered[at]! ^ 0x01;
      expect(await sealHolds(altered)).toBe(false);
    }
  });

  it('an archival PDF can be sealed too', async () => {
    const sealed = await sealPdf(await document(true), acme, { reason: 'Sealed' });
    expect(await sealHolds(sealed)).toBe(true);
    expect(sealed.toString('latin1')).toContain('pdfaid:part');
  });

  (PDFSIG ? it : process.env.REQUIRE_PDFSIG ? it : it.skip)('an independent checker (poppler) finds the seal valid, names the organisation, and catches a change', async () => {
    const sealed = await sealPdf(await document(), acme, { reason: 'Sealed' });
    const good = join(dir, 'sealed.pdf');
    writeFileSync(good, sealed);
    const said = execFileSync('pdfsig', [good], { encoding: 'utf8' });
    expect(said).toContain('Signature Validation: Signature is Valid.');
    expect(said).toContain('Signer Certificate Common Name: Acme Trading');
    expect(said).toMatch(/Signature Type: adbe\.pkcs7\.detached/);
    expect(said).toMatch(/Total document signed/);
    const altered = Buffer.from(sealed);
    altered[40] ^= 0x01;
    const bad = join(dir, 'altered.pdf');
    writeFileSync(bad, altered);
    const saidBad = spawnSync('pdfsig', [bad], { encoding: 'utf8' });
    expect(`${saidBad.stdout}${saidBad.stderr}`).not.toContain('Signature is Valid.');
  });

  describe("an organisation's own certificate", () => {
    const asPem = (id: SealIdentity) => Buffer.from(`${id.certificates.join('')}${id.privateKey}`);

    it('is read from PEM text, with the key in the clear or under a password', async () => {
      expect(sealInfo(await identityFromFile(asPem(acme), '')).subject).toBe('Acme Trading');
      const locked = createPrivateKey(acme.privateKey).export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'open sesame' }) as string;
      const file = Buffer.from(`${acme.certificates[0]}${locked}`);
      const read = await identityFromFile(file, 'open sesame');
      // What comes out seals as well as the one it was made from.
      expect(await sealHolds(await sealPdf(await document(), read, { reason: 'Sealed' }))).toBe(true);
      await expect(identityFromFile(file, 'wrong')).rejects.toThrow('The private key could not be opened. Check the password.');
    });

    it('is refused when the key is someone else\'s, when it has run out, or when the file is not one', async () => {
      const other = await newSealIdentity('Someone Else');
      await expect(identityFromFile(Buffer.from(`${acme.certificates[0]}${other.privateKey}`), '')).rejects.toThrow('does not belong to the certificate');
      const old = await newSealIdentity('Long Ago Ltd', new Date('2005-01-01T00:00:00Z'));
      await expect(identityFromFile(asPem(old), '')).rejects.toThrow(/This certificate ran out on 201\d-/);
      await expect(identityFromFile(Buffer.from(acme.certificates[0]!), '')).rejects.toThrow('must hold both the certificate and its private key');
      await expect(identityFromFile(Buffer.from('not a certificate at all'), '')).rejects.toBeInstanceOf(SealFileError);
    });

    it('when several certificates are in the file, the one the key belongs to signs and the others go with it', async () => {
      const other = await newSealIdentity('An Authority');
      const read = await identityFromFile(Buffer.from(`${other.certificates[0]}${acme.certificates[0]}${acme.privateKey}`), '');
      expect(read.certificates.map((c) => sealInfo({ certificates: [c] }).subject)).toEqual(['Acme Trading', 'An Authority']);
    });

    (OPENSSL ? it : it.skip)('is read from a .pfx file with its password', async () => {
      const key = join(dir, 'key.pem');
      const cert = join(dir, 'cert.pem');
      const pfx = join(dir, 'acme.pfx');
      writeFileSync(key, acme.privateKey);
      writeFileSync(cert, acme.certificates[0]!);
      execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', pfx, '-passout', 'pass:pfx-secret', '-keypbe', 'aes-256-cbc', '-certpbe', 'aes-256-cbc', '-macalg', 'sha256'], { stdio: 'ignore' });
      const read = await identityFromFile(readFileSync(pfx), 'pfx-secret');
      expect(sealInfo(read).fingerprint).toBe(sealInfo(acme).fingerprint);
      expect(await sealHolds(await sealPdf(await document(), read, { reason: 'Sealed' }))).toBe(true);
      await expect(identityFromFile(readFileSync(pfx), 'not it')).rejects.toThrow('The file could not be opened. Check the password.');
    });
  });
});
