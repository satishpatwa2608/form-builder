import { orgLog } from '../logs/org-log';
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, GoneException, HttpException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { isSignature } from '@fb/engine';
import type { Model } from 'mongoose';
import { PDFDocument } from 'pdf-lib';
import { hashToken, newId, randomToken } from '../common/crypto';
import { OrgMailService } from '../mail/org-mail.service';
import { OBJECT_STORE, type ObjectStore } from '../common/object-store';
import { APP_CONFIG, type AppConfig } from '../config';
import { DocumentsService } from '../documents/documents.service';
import { SealService } from '../documents/seal.service';
import { renderDocument, type DocumentRow } from '../documents/submission-pdf';
import { JobQueue } from '../jobs/job-queue.service';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { FormSubmission, type FormSubmissionDocument } from '../work/schemas/form-submission.schema';
import { SignatureRequest, type SignatureRequestDocument, type Signer } from './signature.schema';

/** Told to whoever is waiting for the signatures (the workflow), when a request ends. */
export const SIGNATURE_FINISHED_EVENT = 'form.signature.finished';
export interface SignatureFinishedEvent {
  orgId: string;
  recordId: string;
  runId: string;
  stepKey: string;
  output: { status: 'SIGNED' | 'DECLINED' | 'EXPIRED'; signedAt: string; signers: number; declinedBy: string };
}

/** Where the public form app is, for the links in emails (the same setting the workflow's record links use). */
/** Above this the signed PDF is not attached to the closing email (mail servers refuse large messages). */
const MAX_ATTACHMENT_BYTES = 7 * 1024 * 1024;
const formAppUrl = () => (process.env.FORM_APP_URL ?? 'http://localhost:5174').replace(/\/+$/, '');
const REMIND_EVERY_MS = 3 * 86_400_000;
const JOB_REMIND = 'signature.remind';
const JOB_EXPIRE = 'signature.expire';
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const oneLine = (s: string, max: number) => s.replace(/[\r\n]+/g, ' ').trim().slice(0, max);
/** How long an emailed code works, how soon another may be asked for, and how many may be sent and tried. */
const CODE_MINUTES = 10;
const CODE_WAIT_MS = 60_000;
const MAX_CODES = 5;
const MAX_TRIES = 5;
/** Once confirmed, how long the page may read and sign before asking again. */
const PASS_MINUTES = 30;
/** What a signer knows, compared the way a person would: no spaces or dashes, capitals ignored. */
const plainKnown = (s: string) => s.toLowerCase().replace(/[\s-]+/g, '');
const knownHashOf = (requestId: string, value: string) => sha256(Buffer.from(`${requestId}:${plainKnown(value)}`));

/**
 * Signing the PDF of a response, without an outside provider: each signer
 * gets a private link by email, reads the document, and signs by drawing and
 * typing their name. When all have signed, the document is kept with a page
 * that says who signed, when and from where, and carries the fingerprint of
 * what they were shown.
 */
@Injectable()
export class SignaturesService implements OnModuleInit {
  private readonly logger = new Logger(SignaturesService.name);

  constructor(
    private readonly jobs: JobQueue,
    private readonly documents: DocumentsService,
    private readonly events: EventEmitter2,
    private readonly mail: OrgMailService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    @InjectModel(SignatureRequest.name) private readonly requests: Model<SignatureRequestDocument>,
    @InjectModel(FormSubmission.name) private readonly submissions: Model<FormSubmissionDocument>,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly seals: SealService,
  ) {}

  onModuleInit() {
    this.jobs.register(JOB_REMIND, (p: { id: string }) => this.remind(p.id), { maxAttempts: 3 });
    this.jobs.register(JOB_EXPIRE, (p: { id: string }) => this.expire(p.id), { maxAttempts: 3 });
  }

  private async orgName(orgId: string) {
    return (await this.orgs.findOne({ id: orgId }).select('name').lean())?.name ?? '';
  }

  /** Sends a signer their link. The token is made here and kept only as a hash. */
  private async invite(request: SignatureRequest, index: number, reminder = false): Promise<Signer> {
    const signer = request.signers[index]!;
    const token = `fbsig_${randomToken()}`;
    const next: Signer = { ...signer, tokenHash: hashToken(token), status: 'SENT', sentAt: signer.sentAt ?? new Date(), ...(reminder ? { remindedAt: new Date() } : {}) };
    await this.requests.updateOne({ id: request.id }, { $set: { [`signers.${index}`]: next } });
    const org = await this.orgName(request.orgId);
    const days = Math.max(1, Math.ceil((request.expiresAt.getTime() - Date.now()) / 86_400_000));
    await this.mail
      .send(request.orgId, {
        to: signer.email,
        subject: oneLine(`${reminder ? 'Reminder: ' : ''}${org || 'Form Builder'} asks you to sign: ${request.title}`, 200),
        text: [
          `${org || 'An organisation'} has sent you a document to sign: ${request.title}.`,
          ...(request.message ? ['', request.message] : []),
          '',
          `Read and sign it here: ${formAppUrl()}/sign/${token}`,
          '',
          `This link is for you alone and works for ${days} more day${days === 1 ? '' : 's'}. If you were not expecting it, you can ignore this message or decline on that page.`,
        ].join('\n'),
      })
      .catch((e: Error) => this.logger.warn(`could not email a signer of ${request.id}: ${e.name}`));
    return next;
  }

  /** Called by the workflow's "Send for signature" step. */
  async start(p: { orgId: string; recordId: string; runId: string; stepKey: string; title: string; message?: string; order?: 'IN_ORDER' | 'PARALLEL'; expiresInDays?: number; signers: string[]; confirm?: 'EMAIL_CODE' | 'KNOWN'; known?: string; knownLabel?: string }): Promise<string> {
    const emails = [...new Set(p.signers.map((e) => e.trim().toLowerCase()))].slice(0, 10);
    if (!emails.length) throw new BadRequestException('There is no one to sign');
    // What they will all be shown: fixed now, so nobody signs something other than what the first signer saw.
    const { pdf, seal, archival } = await this.documents.forSigning(p.orgId, p.recordId);
    const id = newId();
    // Asking for something they know only works when there is something to ask: a response without that answer
    // must not go out for signature guarded by an empty word.
    if (p.confirm === 'KNOWN' && !plainKnown(p.known ?? '')) throw new BadRequestException('what the signers must know is empty for this response');
    const guard = p.confirm === 'KNOWN' ? { confirm: 'KNOWN' as const, knownLabel: oneLine(p.knownLabel ?? '', 80), knownHash: knownHashOf(id, p.known ?? '') } : p.confirm === 'EMAIL_CODE' ? { confirm: 'EMAIL_CODE' as const } : {};
    const order = p.order === 'PARALLEL' ? 'PARALLEL' : 'IN_ORDER';
    const days = Math.min(90, Math.max(1, p.expiresInDays ?? 14));
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    const maxReminders = Math.min(5, Math.floor((days * 86_400_000 - 1) / REMIND_EVERY_MS));
    const blank = (email: string): Signer => ({ email, tokenHash: '', status: 'WAITING', sentAt: null, remindedAt: null, name: '', signature: '', signedAt: null, ip: '', userAgent: '', declineReason: '' });
    const request = (
      await this.requests.create({ id, orgId: p.orgId, recordId: p.recordId, runId: p.runId, stepKey: p.stepKey, title: oneLine(p.title, 200), message: (p.message ?? '').slice(0, 2000), order, ...guard, seal, archival, signers: emails.map(blank), expiresAt, maxReminders, documentHash: sha256(pdf) })
    ).toObject() as SignatureRequest;
    await this.store.put(SignaturesService.originalKey(request), pdf, 'application/pdf');
    for (const index of order === 'PARALLEL' ? emails.map((_, i) => i) : [0]) await this.invite(request, index);
    orgLog.info(p.orgId, 'signatures', `Sent for signature: ${request.title}`, { record: p.recordId, signers: emails.length, order, days });
    if (maxReminders > 0) await this.jobs.enqueue(JOB_REMIND, { id }, { orgId: p.orgId, runAt: new Date(Date.now() + REMIND_EVERY_MS), dedupeKey: `signature-remind:${id}:1` });
    await this.jobs.enqueue(JOB_EXPIRE, { id }, { orgId: p.orgId, runAt: expiresAt, dedupeKey: `signature-expire:${id}` });
    return id;
  }

  private static originalKey(r: Pick<SignatureRequest, 'orgId' | 'id'>) {
    return `signatures/${r.orgId}/${r.id}/document.pdf`;
  }

  // ── The signer's side (reached with the link's token and nothing else) ────

  private async byToken(token: string): Promise<{ request: SignatureRequest; index: number; signer: Signer }> {
    const request = /^fbsig_[A-Za-z0-9_-]{20,}$/.test(token) ? await this.requests.findOne({ 'signers.tokenHash': hashToken(token) }).lean<SignatureRequest>() : null;
    const index = request?.signers.findIndex((s) => s.tokenHash === hashToken(token)) ?? -1;
    if (!request || index < 0) throw new NotFoundException('This signing link is not valid. Check that you copied all of it, or ask for a new one.');
    return { request, index, signer: request.signers[index]! };
  }

  /** What the signing page shows. Says nothing about the response beyond its title and reference. */
  async view(token: string) {
    const { request, signer } = await this.byToken(token);
    const record = await this.submissions.findOne({ orgId: request.orgId, uuid: request.recordId }).select('ref').lean();
    return {
      title: request.title,
      message: request.message,
      organisation: await this.orgName(request.orgId),
      reference: record?.ref ?? '',
      email: signer.email,
      status: request.status === 'WAITING' ? signer.status : request.status,
      expiresAt: request.expiresAt,
      // What more than the link this page must ask for before the document can be read or signed.
      ...(request.confirm ? { confirm: request.confirm, ...(request.confirm === 'KNOWN' ? { asks: request.knownLabel } : {}), locked: !!signer.lockedAt } : {}),
      // Who else signs, by how far they have got; never their addresses.
      others: request.signers.filter((s) => s !== signer).map((s) => (s.status === 'SIGNED' ? 'SIGNED' : s.status === 'DECLINED' ? 'DECLINED' : 'PENDING')),
    };
  }

  /** The document as it was put to the signers; once all have signed, the signed one. */
  async documentFor(token: string, pass?: unknown): Promise<{ pdf: Buffer; fileName: string }> {
    const { request, signer } = await this.byToken(token);
    // Once everyone has signed, the link shows the finished document as before; until then, whatever the request asks for is asked.
    if (request.status !== 'SIGNED') this.confirmed(request, signer, pass);
    const pdf = await this.store.get(request.status === 'SIGNED' && request.signedKey ? request.signedKey : SignaturesService.originalKey(request));
    if (!pdf) throw new NotFoundException('The document is no longer available');
    return { pdf, fileName: `${request.title.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 60) || 'document'}.pdf` };
  }

  // ── More than the link: a code by email, or something the signer knows ────

  private passFor(signer: Signer, until: number) {
    return `${until}.${createHmac('sha256', Buffer.from(this.config.SECRET_KEY, 'base64')).update(`sign-pass:${signer.tokenHash}:${until}`).digest('base64url')}`;
  }

  /** Refuses unless the request asks for nothing more than the link, or `pass` shows this signer gave it a moment ago. */
  private confirmed(request: SignatureRequest, signer: Signer, pass: unknown) {
    if (!request.confirm) return;
    if (signer.lockedAt) throw new ForbiddenException('There were too many wrong tries, so this link no longer works. Ask for the document to be sent again.');
    const [until, mark] = typeof pass === 'string' && pass.length < 200 ? pass.split('.') : [];
    const expected = until && mark ? this.passFor(signer, Number(until)).split('.')[1]! : '';
    const good = !!expected && expected.length === mark!.length && timingSafeEqual(Buffer.from(expected), Buffer.from(mark!)) && Number(until) > Date.now();
    if (!good) throw new ForbiddenException(request.confirm === 'KNOWN' ? `Enter ${request.knownLabel || 'what you were asked for'} first.` : 'Enter the code we emailed you first.');
  }

  /** Emails the signer a code, for a request that asks for one. Not more often than once a minute, nor more than a few times. */
  async sendCode(token: string) {
    const { request, index, signer } = await this.byToken(token);
    SignaturesService.open(request, signer);
    if (request.confirm !== 'EMAIL_CODE') throw new BadRequestException('This document does not ask for a code.');
    if (signer.lockedAt) throw new ForbiddenException('There were too many wrong tries, so this link no longer works. Ask for the document to be sent again.');
    if (signer.codeSentAt && Date.now() - new Date(signer.codeSentAt).getTime() < CODE_WAIT_MS) throw new HttpException('A code was sent a moment ago. Check your email, or wait a minute to ask for another.', 429);
    if ((signer.codesSent ?? 0) >= MAX_CODES) throw new ForbiddenException('Too many codes have been asked for with this link. Ask for the document to be sent again.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.requests.updateOne({ id: request.id }, { $set: { [`signers.${index}.codeHash`]: sha256(Buffer.from(`${request.id}:${signer.tokenHash}:${code}`)), [`signers.${index}.codeSentAt`]: new Date(), [`signers.${index}.tries`]: 0 }, $inc: { [`signers.${index}.codesSent`]: 1 } });
    const org = await this.orgName(request.orgId);
    await this.mail.send(request.orgId, {
      to: signer.email,
      subject: oneLine(`${code} is your code to sign: ${request.title}`, 200),
      text: [`Your code to read and sign "${request.title}"${org ? ` from ${org}` : ''} is:`, '', code, '', `It works for ${CODE_MINUTES} minutes. If you did not ask for it, someone else has your signing link: do not pass the code on.`].join('\n'),
    });
    return { sentTo: signer.email.replace(/^(.).*(@.*)$/, '$1…$2'), minutes: CODE_MINUTES };
  }

  /** Checks what the signer typed (the emailed code, or what they know). Right: a pass to read and sign for a while. Wrong too often: the link stops working. */
  async confirm(token: string, body: unknown) {
    const { request, index, signer } = await this.byToken(token);
    SignaturesService.open(request, signer);
    if (!request.confirm) return { pass: '' };
    if (signer.lockedAt) throw new ForbiddenException('There were too many wrong tries, so this link no longer works. Ask for the document to be sent again.');
    const typed = typeof (body as { code?: unknown })?.code === 'string' ? (body as { code: string }).code.trim().slice(0, 200) : '';
    if (!typed) throw new BadRequestException(request.confirm === 'KNOWN' ? `Enter ${request.knownLabel || 'what you were asked for'}.` : 'Enter the code from the email.');
    let right: boolean;
    if (request.confirm === 'KNOWN') right = knownHashOf(request.id, typed) === request.knownHash;
    else {
      if (!signer.codeHash || !signer.codeSentAt || Date.now() - new Date(signer.codeSentAt).getTime() > CODE_MINUTES * 60_000) throw new BadRequestException('That code is out of date. Ask for a new one.');
      right = sha256(Buffer.from(`${request.id}:${signer.tokenHash}:${typed.replace(/\s+/g, '')}`)) === signer.codeHash;
    }
    if (!right) {
      const tries = (signer.tries ?? 0) + 1;
      // An emailed code that was guessed at too often is thrown away (another can be asked for, a few times);
      // something they know has no "another", so the link itself stops working.
      const spent = tries >= MAX_TRIES;
      await this.requests.updateOne(
        { id: request.id },
        { $set: { [`signers.${index}.tries`]: spent && request.confirm === 'EMAIL_CODE' ? 0 : tries, ...(spent ? (request.confirm === 'KNOWN' || (signer.codesSent ?? 0) >= MAX_CODES ? { [`signers.${index}.lockedAt`]: new Date() } : { [`signers.${index}.codeHash`]: '' }) : {}) } },
      );
      if (spent) orgLog.warn(request.orgId, 'signatures', `Too many wrong tries before signing: ${request.title}`, { record: request.recordId });
      throw new ForbiddenException(spent ? (request.confirm === 'KNOWN' ? 'That is not right, and there were too many wrong tries: this link no longer works. Ask for the document to be sent again.' : 'That is not right, and that code has been tried too often. Ask for a new one.') : 'That is not right. Check it and try again.');
    }
    await this.requests.updateOne({ id: request.id }, { $set: { [`signers.${index}.confirmedAt`]: new Date(), [`signers.${index}.codeHash`]: '', [`signers.${index}.tries`]: 0 } });
    return { pass: this.passFor(signer, Date.now() + PASS_MINUTES * 60_000) };
  }

  private static open(request: SignatureRequest, signer: Signer) {
    if (request.status === 'EXPIRED' || (request.status === 'WAITING' && request.expiresAt.getTime() < Date.now())) throw new GoneException('The time to sign this document has passed.');
    if (request.status === 'DECLINED') throw new ConflictException('This document was declined and is no longer open for signing.');
    if (signer.status === 'SIGNED' || request.status === 'SIGNED') throw new ConflictException('You have already signed this document.');
    if (signer.status === 'WAITING') throw new ConflictException('It is not your turn to sign yet. You will get an email when it is.');
  }

  async sign(token: string, body: unknown, meta: { ip: string; userAgent: string }) {
    const { request, index, signer } = await this.byToken(token);
    SignaturesService.open(request, signer);
    const input = (body && typeof body === 'object' ? body : {}) as { name?: unknown; signature?: unknown; agreed?: unknown; pass?: unknown };
    this.confirmed(request, signer, input.pass);
    const name = typeof input.name === 'string' ? oneLine(input.name, 100) : '';
    if (!name) throw new BadRequestException('Type your full name');
    if (!isSignature(input.signature)) throw new BadRequestException('Draw your signature');
    if (input.agreed !== true) throw new BadRequestException('Tick the box to agree to sign electronically');
    // Claimed in one step, so the same link used twice at once signs once.
    const claimed = await this.requests.findOneAndUpdate(
      { id: request.id, status: 'WAITING', [`signers.${index}.status`]: 'SENT', [`signers.${index}.tokenHash`]: signer.tokenHash },
      { $set: { [`signers.${index}.status`]: 'SIGNED', [`signers.${index}.name`]: name, [`signers.${index}.signature`]: input.signature, [`signers.${index}.signedAt`]: new Date(), [`signers.${index}.ip`]: meta.ip.slice(0, 64), [`signers.${index}.userAgent`]: meta.userAgent.slice(0, 300) } },
      { new: true },
    ).lean<SignatureRequest>();
    if (!claimed) throw new ConflictException('You have already signed this document.');
    const waiting = claimed.signers.findIndex((s) => s.status === 'WAITING');
    if (claimed.signers.every((s) => s.status === 'SIGNED')) await this.finish(claimed, 'SIGNED');
    else if (claimed.order === 'IN_ORDER' && waiting >= 0 && !claimed.signers.some((s) => s.status === 'SENT')) await this.invite(claimed, waiting);
    return this.view(token);
  }

  async decline(token: string, body: unknown, meta: { ip: string; userAgent: string }) {
    const { request, index, signer } = await this.byToken(token);
    SignaturesService.open(request, signer);
    const reason = typeof (body as { reason?: unknown })?.reason === 'string' ? oneLine((body as { reason: string }).reason, 500) : '';
    const claimed = await this.requests.findOneAndUpdate(
      { id: request.id, status: 'WAITING', [`signers.${index}.status`]: 'SENT' },
      { $set: { [`signers.${index}.status`]: 'DECLINED', [`signers.${index}.declineReason`]: reason, [`signers.${index}.signedAt`]: new Date(), [`signers.${index}.ip`]: meta.ip.slice(0, 64), [`signers.${index}.userAgent`]: meta.userAgent.slice(0, 300) } },
      { new: true },
    ).lean<SignatureRequest>();
    if (!claimed) throw new ConflictException('This document is no longer open for signing.');
    await this.finish(claimed, 'DECLINED');
    return this.view(token);
  }

  // ── Ending a request ─────────────────────────────────────────────────────

  private async finish(request: SignatureRequest, status: 'SIGNED' | 'DECLINED' | 'EXPIRED') {
    let signedKey = '';
    if (status === 'SIGNED') {
      const signed = await this.signedPdf(request);
      signedKey = `signatures/${request.orgId}/${request.id}/signed.pdf`;
      await this.store.put(signedKey, signed, 'application/pdf');
    }
    const done = await this.requests.findOneAndUpdate({ id: request.id, status: 'WAITING' }, { $set: { status, signedKey, finishedAt: new Date() } });
    // Ended already (the last signature and the expiry arriving together): the workflow has been told once.
    if (!done) return;
    const declined = request.signers.find((s) => s.status === 'DECLINED');
    const event: SignatureFinishedEvent = {
      orgId: request.orgId,
      recordId: request.recordId,
      runId: request.runId,
      stepKey: request.stepKey,
      output: { status, signedAt: status === 'SIGNED' ? new Date().toISOString() : '', signers: request.signers.filter((s) => s.status === 'SIGNED').length, declinedBy: declined?.email ?? '' },
    };
    (status === 'SIGNED' ? orgLog.info : orgLog.warn)(request.orgId, 'signatures', status === 'SIGNED' ? `Signed by everyone: ${request.title}` : status === 'DECLINED' ? `Declined: ${request.title}` : `Not signed in time: ${request.title}`, { record: request.recordId, signers: request.signers.length });
    this.events.emit(SIGNATURE_FINISHED_EVENT, event);
    await this.tellSigners(request, status, declined?.email ?? '');
  }

  /**
   * How it ended, for the people who took part: the signed PDF to everyone who
   * signed it, and word to those already involved when someone else declined.
   */
  private async tellSigners(request: SignatureRequest, status: 'SIGNED' | 'DECLINED' | 'EXPIRED', declinedBy: string) {
    if (status === 'EXPIRED') return;
    const org = (await this.orgName(request.orgId)) || 'Form Builder';
    const signed = status === 'SIGNED' ? await this.store.get(`signatures/${request.orgId}/${request.id}/signed.pdf`) : null;
    const fileName = `${request.title.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 60).trim() || 'document'}-signed.pdf`;
    const to = request.signers.filter((s) => (status === 'SIGNED' ? s.status === 'SIGNED' : s.email !== declinedBy && (s.status === 'SIGNED' || s.status === 'SENT')));
    for (const s of to) {
      const mail =
        status === 'SIGNED'
          ? {
              subject: oneLine(`Signed by everyone: ${request.title}`, 200),
              text:
                signed && signed.length <= MAX_ATTACHMENT_BYTES
                  ? `Everyone has signed "${request.title}". The signed document is attached; its last page shows who signed and when. Keep it for your records.`
                  : `Everyone has signed "${request.title}". Ask ${org} for a copy of the signed document.`,
              ...(signed && signed.length <= MAX_ATTACHMENT_BYTES ? { attachments: [{ fileName, contentType: 'application/pdf', content: signed }] } : {}),
            }
          : { subject: oneLine(`No longer to be signed: ${request.title}`, 200), text: `One of the signers declined "${request.title}", so it will not be signed and your link no longer works. ${org} has been told.` };
      await this.mail.send(request.orgId, { to: s.email, ...mail }).catch((e: Error) => this.logger.warn(`could not tell a signer of ${request.id} how it ended: ${e.name}`));
    }
  }

  /**
   * The document everyone signed, followed by a page that says who signed it:
   * each signature as drawn, the name typed, the address the link was sent
   * to, when and from where, and the fingerprint of the document signed.
   */
  private async signedPdf(request: SignatureRequest): Promise<Buffer> {
    const original = await this.store.get(SignaturesService.originalKey(request));
    if (!original) throw new Error('the document that was signed is missing');
    if (sha256(original) !== request.documentHash) throw new Error('the document has changed since it was sent for signature');
    const rows: DocumentRow[] = [];
    for (const [i, s] of request.signers.entries()) {
      rows.push({ kind: 'heading', text: `Signer ${i + 1}` });
      rows.push({ kind: 'image', label: 'Signature', png: Buffer.from(s.signature.slice(s.signature.indexOf(',') + 1), 'base64') });
      rows.push({ kind: 'answer', label: 'Name as typed', value: s.name });
      rows.push({ kind: 'answer', label: 'Link sent to', value: s.email });
      if (request.confirm && s.confirmedAt) {
        const at = `${new Date(s.confirmedAt).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
        rows.push({ kind: 'answer', label: 'Confirmed before signing', value: request.confirm === 'KNOWN' ? `By giving ${request.knownLabel || 'what they were asked for'}, at ${at}` : `By a code emailed to that address, at ${at}` });
      }
      rows.push({ kind: 'answer', label: 'Signed at', value: `${s.signedAt!.toISOString().slice(0, 19).replace('T', ' ')} UTC` });
      rows.push({ kind: 'answer', label: 'From', value: [s.ip, s.userAgent].filter(Boolean).join(' · ') || 'Not recorded' });
    }
    rows.push({ kind: 'heading', text: 'Document' });
    rows.push({ kind: 'answer', label: 'Fingerprint (SHA-256)', value: request.documentHash });
    rows.push({ kind: 'answer', label: 'Request', value: request.id });
    if (request.seal) rows.push({ kind: 'answer', label: 'Sealed', value: 'This document, with this page, is sealed with the organisation\'s certificate. A PDF reader shows the seal and says if anything was changed afterwards.' });
    rows.push({ kind: 'answer', label: 'How it was signed', value: `Each signer opened a private link sent to their email address${request.confirm === 'EMAIL_CODE' ? ', entered a code emailed to them at that moment' : request.confirm === 'KNOWN' ? `, gave ${request.knownLabel || 'what they were asked for'}` : ''}, read the document above, drew a signature, typed their name and agreed to sign electronically.` });
    const record = await this.submissions.findOne({ orgId: request.orgId, uuid: request.recordId }).select('ref createdAt').lean();
    const page = await renderDocument({
      org: { name: await this.orgName(request.orgId) },
      form: { name: request.title, code: '', version: 0 },
      record: { ref: record?.ref || undefined, submittedAt: (record as { createdAt?: Date } | null)?.createdAt ?? request.createdAt },
      options: { title: `Signatures: ${request.title}`, ...(request.archival ? { archival: true } : {}) },
      rows,
      generatedAt: new Date(),
    });
    const out = await PDFDocument.load(original);
    const audit = await PDFDocument.load(page);
    for (const copied of await out.copyPages(audit, audit.getPageIndices())) out.addPage(copied);
    const whole = Buffer.from(await out.save());
    // Sealed last, over the document and the page of signatures together, so neither can be altered afterwards.
    return request.seal ? this.seals.seal(request.orgId, whole, `${request.title}: signed by ${request.signers.length} ${request.signers.length === 1 ? 'person' : 'people'}`) : whole;
  }

  private async remind(id: string) {
    // Counted first, in one step: a round of reminders goes out once however often the job is tried.
    const request = await this.requests.findOneAndUpdate({ id, status: 'WAITING', expiresAt: { $gt: new Date() }, $expr: { $lt: ['$reminders', '$maxReminders'] } }, { $inc: { reminders: 1 } }, { new: true }).lean<SignatureRequest>();
    if (!request) return;
    // A reminder is a fresh link: the earlier one stops working, so only the newest email signs.
    for (const [index, s] of request.signers.entries()) if (s.status === 'SENT') await this.invite(request, index, true);
    if (request.reminders < request.maxReminders) {
      await this.jobs.enqueue(JOB_REMIND, { id }, { orgId: request.orgId, runAt: new Date(Date.now() + REMIND_EVERY_MS), dedupeKey: `signature-remind:${id}:${request.reminders + 1}` });
    }
  }

  private async expire(id: string) {
    const request = await this.requests.findOne({ id, status: 'WAITING' }).lean<SignatureRequest>();
    if (request) await this.finish(request, 'EXPIRED');
  }

  // ── The organisation's side ──────────────────────────────────────────────

  /** For a record's page: each request and how far each signer has got. */
  async forRecord(orgId: string, recordId: string) {
    const rows = await this.requests.find({ orgId, recordId }).sort({ createdAt: 1 }).lean<SignatureRequest[]>();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      order: r.order,
      expiresAt: r.expiresAt,
      finishedAt: r.finishedAt,
      hasSignedDocument: !!r.signedKey,
      signers: r.signers.map((s) => ({ email: s.email, name: s.name, status: s.status, signedAt: s.signedAt, declineReason: s.declineReason })),
    }));
  }

  async signedDocument(orgId: string, recordId: string, requestId: string): Promise<{ pdf: Buffer; fileName: string }> {
    const request = await this.requests.findOne({ orgId, recordId, id: requestId }).lean<SignatureRequest>();
    const pdf = request?.signedKey ? await this.store.get(request.signedKey) : null;
    if (!request || !pdf) throw new NotFoundException('There is no signed document yet');
    const record = await this.submissions.findOne({ orgId, uuid: recordId }).select('ref').lean();
    return { pdf, fileName: `${record?.ref || 'document'}-signed.pdf` };
  }
}
