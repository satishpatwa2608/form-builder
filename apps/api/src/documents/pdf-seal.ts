import { createPrivateKey, createPublicKey, randomBytes, webcrypto, X509Certificate } from 'node:crypto';
import { SignPdf } from '@signpdf/signpdf';
import { DEFAULT_BYTE_RANGE_PLACEHOLDER, Signer } from '@signpdf/utils';
import * as asn1js from 'asn1js';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import * as pkijs from 'pkijs';
import { BufferSourceConverter } from 'pvtsutils';

/**
 * Sealing a PDF: a real digital signature made with a certificate, of the kind every PDF reader checks. The
 * seal certifies the document with "no changes allowed", so a reader shows who sealed it, refuses to edit it,
 * and says so plainly if a single byte was altered afterwards. This is the lock and the certificate in one.
 *
 * The certificate is the organisation's own when it has given us one, and otherwise one made for the
 * organisation here. A certificate made here proves the document has not changed since we sealed it; only one
 * issued by a certificate authority also proves to a stranger's reader who the organisation is.
 */

const crypto = webcrypto;
pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto as never }));

/** What a seal is made with: the certificate (and any above it, up to the authority), and its private key. PEM text. */
export interface SealIdentity {
  /** The signing certificate first, then those that vouch for it. */
  certificates: string[];
  /** PKCS#8, not encrypted: it is only ever held in memory, and sealed when stored. */
  privateKey: string;
}

/** What can be said about a certificate without its key. */
export interface SealInfo {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** SHA-256 of the certificate, as readers show it. */
  fingerprint: string;
  /** Issued by itself: made here, not by a certificate authority. */
  selfIssued: boolean;
}

const pem = (label: string, der: ArrayBuffer | Uint8Array) => `-----BEGIN ${label}-----\n${Buffer.from(der as ArrayBuffer).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
const der = (text: string) => Buffer.from(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
const nameOf = (x: X509Certificate, which: 'subject' | 'issuer') => /(?:^|\n)CN=([^\n]+)/.exec(x[which])?.[1] ?? x[which].split('\n').join(', ');

export function sealInfo(identity: Pick<SealIdentity, 'certificates'>): SealInfo {
  const x = new X509Certificate(identity.certificates[0]!);
  return { subject: nameOf(x, 'subject'), issuer: nameOf(x, 'issuer'), validFrom: new Date(x.validFrom).toISOString(), validTo: new Date(x.validTo).toISOString(), fingerprint: x.fingerprint256, selfIssued: x.subject === x.issuer };
}

/** A certificate made here for an organisation, good for ten years, with a new key of its own. */
export async function newSealIdentity(organisation: string, now = new Date()): Promise<SealIdentity> {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const keys = (await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ valueHex: new Uint8Array([...randomBytes(15)].map((b, i) => (i === 0 ? b & 0x7f || 1 : b))).buffer });
  const name = (organisation.replace(/[\r\n]+/g, ' ').trim() || 'Organisation').slice(0, 60);
  // Common name, organisation, and a unit that says plainly what kind of certificate this is: each a part of the name in its own right.
  const part = (type: string, value: string) => new asn1js.Set({ value: [new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: type }), new asn1js.Utf8String({ value })] })] });
  const whole = new asn1js.Sequence({ value: [part('2.5.4.3', name), part('2.5.4.10', name), part('2.5.4.11', 'Sealed with Form Builder')] }).toBER(false);
  cert.subject = new pkijs.RelativeDistinguishedNames({ schema: asn1js.fromBER(whole).result });
  cert.issuer = new pkijs.RelativeDistinguishedNames({ schema: asn1js.fromBER(whole).result });
  cert.notBefore.value = new Date(now.getTime() - 60_000);
  cert.notAfter.value = new Date(now.getTime() + 10 * 365 * 86_400_000);
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey as never);
  // For signing documents, and not for vouching for other certificates.
  const usage = new ArrayBuffer(1);
  new Uint8Array(usage)[0] = 0x80 | 0x40; // digitalSignature, nonRepudiation
  cert.extensions = [
    new pkijs.Extension({ extnID: '2.5.29.19', critical: true, extnValue: new pkijs.BasicConstraints({ cA: false }).toSchema().toBER(false) }),
    new pkijs.Extension({ extnID: '2.5.29.15', critical: true, extnValue: new asn1js.BitString({ valueHex: usage, unusedBits: 6 }).toBER(false) }),
  ];
  await cert.sign(keys.privateKey as never, 'SHA-256');
  return { certificates: [pem('CERTIFICATE', cert.toSchema(true).toBER(false))], privateKey: pem('PRIVATE KEY', await crypto.subtle.exportKey('pkcs8', keys.privateKey)) };
}

/** Why a certificate file could not be used, in words for the person who chose it. */
export class SealFileError extends Error {}

/**
 * Reads the organisation's own certificate from the file it was given as: a .pfx / .p12 with its password, or
 * PEM text holding the certificate(s) and the private key. Checks that the key belongs to the certificate, and
 * that the certificate is in date.
 */
export async function identityFromFile(file: Buffer, password: string, now = new Date()): Promise<SealIdentity> {
  let certificates: string[];
  let privateKey: string;
  const text = file.subarray(0, 100_000).toString('latin1');
  if (text.includes('-----BEGIN')) {
    const whole = file.toString('latin1');
    certificates = whole.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    const key = /-----BEGIN (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (?:ENCRYPTED |RSA |EC )?PRIVATE KEY-----/.exec(whole)?.[0];
    if (!certificates.length || !key) throw new SealFileError('The file must hold both the certificate and its private key.');
    try {
      privateKey = createPrivateKey({ key, passphrase: password }).export({ type: 'pkcs8', format: 'pem' }) as string;
    } catch {
      throw new SealFileError('The private key could not be opened. Check the password.');
    }
  } else {
    ({ certificates, privateKey } = await fromPkcs12(file, password));
  }
  // The signing certificate is the one the key belongs to; the others vouch for it.
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const own = certificates.findIndex((c) => {
    try {
      return new X509Certificate(c).publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey);
    } catch {
      return false;
    }
  });
  if (own < 0) throw new SealFileError('The private key in the file does not belong to the certificate in it.');
  const ordered = [certificates[own]!, ...certificates.filter((_, i) => i !== own)].slice(0, 6);
  const x = new X509Certificate(ordered[0]!);
  if (new Date(x.validTo).getTime() < now.getTime()) throw new SealFileError(`This certificate ran out on ${new Date(x.validTo).toISOString().slice(0, 10)}.`);
  if (new Date(x.validFrom).getTime() > now.getTime()) throw new SealFileError(`This certificate is not valid until ${new Date(x.validFrom).toISOString().slice(0, 10)}.`);
  const kind = createPublicKey(privateKey).asymmetricKeyType;
  if (kind !== 'rsa' && kind !== 'ec') throw new SealFileError('Only RSA and elliptic-curve certificates can be used to seal a PDF.');
  return { certificates: ordered.map((c) => pem('CERTIFICATE', der(c))), privateKey };
}

async function fromPkcs12(file: Buffer, password: string): Promise<SealIdentity> {
  const secret = BufferSourceConverter.toArrayBuffer(Buffer.from(password, 'utf8'));
  let pfx: pkijs.PFX;
  try {
    pfx = pkijs.PFX.fromBER(new Uint8Array(file).buffer);
  } catch {
    throw new SealFileError('This is not a certificate file we can read. Use a .pfx or .p12 file, or PEM text with the certificate and its key.');
  }
  try {
    await pfx.parseInternalValues({ password: secret, checkIntegrity: true });
    const safe = pfx.parsedValue!.authenticatedSafe!;
    await safe.parseInternalValues({ safeContents: safe.safeContents.map(() => ({ password: secret })) });
    const certificates: string[] = [];
    let privateKey = '';
    for (const content of safe.parsedValue.safeContents as { value: pkijs.SafeContents }[]) {
      for (const bag of content.value.safeBags) {
        if (bag.bagId === '1.2.840.113549.1.12.10.1.3') certificates.push(pem('CERTIFICATE', ((bag.bagValue as pkijs.CertBag).parsedValue as pkijs.Certificate).toSchema(true).toBER(false)));
        else if (bag.bagId === '1.2.840.113549.1.12.10.1.2') {
          const shrouded = bag.bagValue as pkijs.PKCS8ShroudedKeyBag;
          await (shrouded as unknown as { parseInternalValues(p: { password: ArrayBuffer }): Promise<void> }).parseInternalValues({ password: secret });
          privateKey = pem('PRIVATE KEY', shrouded.parsedValue!.toSchema().toBER(false));
        } else if (bag.bagId === '1.2.840.113549.1.12.10.1.1') privateKey = pem('PRIVATE KEY', (bag.bagValue as pkijs.PrivateKeyInfo).toSchema().toBER(false));
      }
    }
    if (!certificates.length || !privateKey) throw new SealFileError('The file must hold both the certificate and its private key.');
    return { certificates, privateKey };
  } catch (e) {
    if (e instanceof SealFileError) throw e;
    // Either the password, or the old way of protecting these files, which cannot be opened here.
    throw new SealFileError(
      'The file could not be opened. Check the password. If it is right, the file is protected the old way (TripleDES): save it again choosing "AES256-SHA256" as the encryption (the certificate export in Windows offers it), and add that file.',
    );
  }
}

/** The signature itself (CMS, detached), made over the bytes of the PDF around the place it is written into. */
async function signatureOver(data: Buffer, identity: SealIdentity, at: Date): Promise<Buffer> {
  const certificates = identity.certificates.map((c) => pkijs.Certificate.fromBER(new Uint8Array(der(c)).buffer));
  const key = createPrivateKey(identity.privateKey);
  const elliptic = key.asymmetricKeyType === 'ec';
  const curve = elliptic ? ({ prime256v1: 'P-256', secp384r1: 'P-384', secp521r1: 'P-521' } as Record<string, string>)[key.asymmetricKeyDetails?.namedCurve ?? ''] : undefined;
  if (elliptic && !curve) throw new SealFileError('This kind of elliptic-curve certificate cannot be used to seal a PDF.');
  const algorithm = elliptic ? { name: 'ECDSA', namedCurve: curve! } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const signingKey = await crypto.subtle.importKey('pkcs8', new Uint8Array(key.export({ type: 'pkcs8', format: 'der' })), algorithm, false, ['sign']);
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
  const signer = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: certificates[0]!.issuer, serialNumber: certificates[0]!.serialNumber }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({
      type: 0,
      attributes: [
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.1' })] }),
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.5', values: [new asn1js.UTCTime({ valueDate: at })] }),
        new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: digest })] }),
      ],
    }),
  });
  const signed = new pkijs.SignedData({ version: 1, encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: '1.2.840.113549.1.7.1' }), signerInfos: [signer], certificates });
  await signed.sign(signingKey as never, 0, 'SHA-256');
  return Buffer.from(new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: signed.toSchema(true) }).toSchema().toBER(false));
}

class SealSigner extends Signer {
  constructor(private readonly identity: SealIdentity) {
    super();
  }
  sign(pdf: Buffer, signingTime?: Date): Promise<Buffer> {
    return signatureOver(pdf, this.identity, signingTime ?? new Date());
  }
}

/** Room left in the file for the signature and its certificates. */
const SIGNATURE_BYTES = 12_288;

/**
 * Seals a PDF: certifies it with the identity's certificate, allowing no changes. The PDF is otherwise as it
 * was: same pages, same text. Sealing is the last thing done to a document: anything done to it afterwards
 * breaks the seal, which is the point.
 */
export async function sealPdf(pdf: Buffer, identity: SealIdentity, about: { reason: string; at?: Date }): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const who = sealInfo(identity).subject;
  const at = about.at ?? new Date();
  const ctx = doc.context;
  // Where the signature will go: its place in the file is filled in once the rest of the file is fixed.
  const range = PDFArray.withContext(ctx);
  range.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i++) range.push(PDFName.of(DEFAULT_BYTE_RANGE_PLACEHOLDER));
  const signatureRef = ctx.register(
    ctx.obj({
      Type: 'Sig',
      Filter: 'Adobe.PPKLite',
      SubFilter: 'adbe.pkcs7.detached',
      ByteRange: range,
      Contents: PDFHexString.of('0'.repeat(SIGNATURE_BYTES * 2)),
      Reason: PDFString.of(about.reason.replace(/[\r\n]+/g, ' ').slice(0, 200)),
      M: PDFString.fromDate(at),
      Name: PDFString.of(who),
      // "Certified, no changes allowed": the signature says which changes it permits (none).
      Reference: [{ Type: 'SigRef', TransformMethod: 'DocMDP', TransformParams: { Type: 'TransformParams', P: 1, V: '1.2' } }],
    }),
  );
  // A signature lives in a form field; this one takes up no room on the page.
  const page = doc.getPage(0);
  const widgetRef = ctx.register(
    ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Sig', Rect: [0, 0, 0, 0], V: signatureRef, T: PDFString.of(`Seal${Date.now().toString(36)}`), F: 4, P: page.ref, AP: { N: ctx.register(ctx.formXObject([], { BBox: [0, 0, 0, 0], Resources: {} })) } }),
  );
  const annotations = page.node.Annots() ?? ctx.obj([]);
  annotations.push(widgetRef);
  page.node.set(PDFName.of('Annots'), annotations);
  const form = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict) ?? ctx.obj({ Fields: [] });
  const fields = form.lookupMaybe(PDFName.of('Fields'), PDFArray) ?? ctx.obj([]);
  fields.push(widgetRef);
  form.set(PDFName.of('Fields'), fields);
  form.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  doc.catalog.set(PDFName.of('AcroForm'), form);
  // And the document points at that signature as the one that decides what may change.
  doc.catalog.set(PDFName.of('Perms'), ctx.obj({ DocMDP: signatureRef }));
  const ready = Buffer.from(await doc.save({ useObjectStreams: false }));
  return new SignPdf().sign(ready, new SealSigner(identity), at);
}
