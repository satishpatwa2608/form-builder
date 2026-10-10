import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPdf as pdfParse } from './read-pdf';
import { JobQueue } from '../src/jobs/job-queue.service';
import { SignaturesService } from '../src/signatures/signatures.service';
import { startApp, type Harness } from './harness';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DAY = 86_400_000;

const form = (code: string, sign: object) => ({
  name: `${code} agreement`,
  code,
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'a', type: 'TEXT', name: 'customer', label: 'Customer', required: true },
    { id: 'b', type: 'EMAIL', name: 'email', label: 'Email', required: true },
  ],
  workflow: {
    enabled: true,
    refPrefix: code.slice(0, 3),
    statuses: [
      { key: 'NEW', label: 'New', category: 'OPEN' },
      { key: 'SIGNED', label: 'Signed', category: 'DONE' },
      { key: 'REFUSED', label: 'Refused', category: 'DONE' },
      { key: 'LAPSED', label: 'Lapsed', category: 'DONE' },
    ],
    assignment: { type: 'NONE' },
  },
  automations: [
    {
      id: 'a1',
      name: 'Sign',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 'sign', type: 'SIGN', to: [{ kind: 'FIELD', field: 'email' }, { kind: 'EMAIL', email: 'approver@acme.test' }], title: 'Agreement {{$record.ref}}', message: 'Please sign, {{customer}}.', ...sign },
        { id: 'ok', type: 'SET_STATUS', status: 'SIGNED', if: { field: '$steps.sign.status', operator: 'equals', value: 'SIGNED' } },
        { id: 'no', type: 'SET_STATUS', status: 'REFUSED', if: { field: '$steps.sign.status', operator: 'equals', value: 'DECLINED' } },
        { id: 'late', type: 'SET_STATUS', status: 'LAPSED', if: { field: '$steps.sign.status', operator: 'equals', value: 'EXPIRED' } },
      ],
    },
  ],
});

describe('Signing a response (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  let dir: string;
  let queue: JobQueue;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-sign-'));
    h = await startApp({ LOCAL_STORAGE_DIR: dir });
    queue = h.app.get(JobQueue);
    await h.signUp('Asha', 'asha@acme.test', 'Acme Trading');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Legal' }).expect(201)).body[0].id;
  });
  afterAll(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const publish = async (definition: object) => {
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id as string;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
    return id;
  };
  const submit = async (code: string, email: string) => (await h.api().post(`/public/forms/${code}/submissions?org=${orgId}`).send({ values: { customer: 'Ravi Kumar', email } }).expect(201)).body as { submissionId: string; ref: string };
  const linkTo = (to: string, reminder = false) => {
    const mail = [...h.outbox].reverse().find((m) => m.to === to && /asks you to sign/.test(m.subject) && m.subject.startsWith('Reminder') === reminder);
    return mail ? { mail, token: /\/sign\/(fbsig_[A-Za-z0-9_-]+)/.exec(mail.text)![1]! } : undefined;
  };
  const waitFor = async <T>(get: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const v = await get();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const statusOf = async (sid: string) => (await h.api().get(`/records/${sid}`).set(h.bearer(owner)).expect(200)).body.record.status as string;
  const signBody = (name: string) => ({ name, signature: PNG, agreed: true });
  const binary = (res: any, cb: any) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };

  it('the requester signs, then the approver; the signed PDF with who signed is kept on the record', async () => {
    await publish(form('AGR', {}));
    const sub = await submit('AGR', 'ravi@customer.test');

    // One after another: only the first signer is asked to begin with.
    const first = await waitFor(() => linkTo('ravi@customer.test'), 'the first signer\'s email');
    expect(first.mail.subject).toBe(`Acme Trading asks you to sign: Agreement ${sub.ref}`);
    expect(first.mail.text).toContain('Please sign, Ravi Kumar.');
    expect(linkTo('approver@acme.test')).toBeUndefined();

    const page = (await h.api().get(`/public/sign/${first.token}`).expect(200)).body;
    expect(page).toMatchObject({ title: `Agreement ${sub.ref}`, organisation: 'Acme Trading', reference: sub.ref, email: 'ravi@customer.test', status: 'SENT', others: ['PENDING'] });
    // What they are shown is the PDF of the response.
    const shown = await h.api().get(`/public/sign/${first.token}/document`).buffer(true).parse(binary).expect(200);
    expect((await pdfParse(shown.body)).text).toContain('Ravi Kumar');

    // Signing takes a drawn signature, a typed name and agreement; anything less is refused in words.
    expect((await h.api().post(`/public/sign/${first.token}`).send({ signature: PNG, agreed: true }).expect(400)).body.message).toBe('Type your full name');
    expect((await h.api().post(`/public/sign/${first.token}`).send({ name: 'Ravi', signature: 'data:image/svg+xml;base64,PHN2Zz4=', agreed: true }).expect(400)).body.message).toBe('Draw your signature');
    expect((await h.api().post(`/public/sign/${first.token}`).send({ name: 'Ravi', signature: PNG }).expect(400)).body.message).toBe('Tick the box to agree to sign electronically');
    expect((await h.api().post(`/public/sign/${first.token}`).send(signBody('Ravi Kumar')).expect(200)).body).toMatchObject({ status: 'SIGNED', others: ['PENDING'] });
    expect(await statusOf(sub.submissionId)).toBe('NEW');

    const second = await waitFor(() => linkTo('approver@acme.test'), 'the approver\'s email');
    await h.api().post(`/public/sign/${second.token}`).set('User-Agent', 'TestBrowser/1.0').send(signBody('Asha Rao')).expect(200);

    // Everyone has signed: the flow carries on, and the signed document is on the record.
    await waitFor(async () => (await statusOf(sub.submissionId)) === 'SIGNED', 'the record to be marked signed');
    const list = (await h.api().get(`/records/${sub.submissionId}/signatures`).set(h.bearer(owner)).expect(200)).body;
    expect(list).toEqual([
      expect.objectContaining({
        title: `Agreement ${sub.ref}`,
        status: 'SIGNED',
        hasSignedDocument: true,
        signers: [expect.objectContaining({ email: 'ravi@customer.test', name: 'Ravi Kumar', status: 'SIGNED' }), expect.objectContaining({ email: 'approver@acme.test', name: 'Asha Rao', status: 'SIGNED' })],
      }),
    ]);
    // Nothing about how to sign is given out with the list.
    expect(JSON.stringify(list)).not.toMatch(/tokenHash|fbsig_|data:image/);

    const signed = await h.api().get(`/records/${sub.submissionId}/signatures/${list[0].id}/document`).set(h.bearer(owner)).buffer(true).parse(binary).expect(200);
    expect(signed.headers['content-disposition']).toBe(`inline; filename="${sub.ref}-signed.pdf"`);
    const parsed = await pdfParse(signed.body);
    const text = parsed.text.replace(/\s+/g, ' ');
    expect(parsed.numpages).toBe((await pdfParse(shown.body)).numpages + 1);
    for (const part of ['AGR agreement', 'Ravi Kumar', `Signatures: Agreement ${sub.ref}`, 'Signer 1', 'ravi@customer.test', 'Signer 2', 'Asha Rao', 'approver@acme.test', 'TestBrowser/1.0', 'Fingerprint (SHA-256)']) expect(text).toContain(part);
    // The signers themselves can fetch the finished document with their link.
    const theirs = await h.api().get(`/public/sign/${first.token}/document`).buffer(true).parse(binary).expect(200);
    expect(Buffer.compare(theirs.body, signed.body)).toBe(0);
    // And each is sent it to keep, attached to a closing email.
    for (const to of ['ravi@customer.test', 'approver@acme.test']) {
      const closing = await waitFor(() => h.outbox.find((m) => m.to === to && m.subject === `Signed by everyone: Agreement ${sub.ref}`), `the closing email to ${to}`);
      expect(closing.attachments).toHaveLength(1);
      expect(closing.attachments![0]).toMatchObject({ contentType: 'application/pdf' });
      expect(Buffer.compare(closing.attachments![0]!.content, signed.body)).toBe(0);
    }

    const events = (await h.api().get(`/records/${sub.submissionId}`).set(h.bearer(owner)).expect(200)).body.events.map((e: { message: string }) => e.message);
    expect(events).toEqual(expect.arrayContaining([expect.stringContaining('sent for signature to 2 people'), 'Sign: signed by all 2 signers']));
  });

  it('a link signs once, only for the person it was sent to, and only while it is their turn', async () => {
    const sub = await submit('AGR', 'meera@customer.test');
    const first = await waitFor(() => linkTo('meera@customer.test'), 'the email');
    await h.api().post(`/public/sign/${first.token}`).send(signBody('Meera')).expect(200);
    // Used again: refused, and the first signature stands.
    expect((await h.api().post(`/public/sign/${first.token}`).send(signBody('Someone Else')).expect(409)).body.message).toBe('You have already signed this document.');
    await h.api().post(`/public/sign/${first.token}/decline`).send({ reason: 'changed my mind' }).expect(409);
    // A made-up or altered link is not one.
    await h.api().get('/public/sign/fbsig_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').expect(404);
    await h.api().get(`/public/sign/${first.token.slice(0, -2)}xx`).expect(404);
    await h.api().post('/public/sign/not-a-token').send(signBody('X')).expect(404);
    expect((await h.api().get(`/records/${sub.submissionId}/signatures`).set(h.bearer(owner)).expect(200)).body[0].signers[0]).toMatchObject({ name: 'Meera', status: 'SIGNED' });
    // The same link used twice at the very same moment still signs once.
    const sub2 = await submit('AGR', 'twice@customer.test');
    const link = await waitFor(() => linkTo('twice@customer.test'), 'the email');
    const both = await Promise.all([h.api().post(`/public/sign/${link.token}`).send(signBody('A')), h.api().post(`/public/sign/${link.token}`).send(signBody('B'))]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(sub2.ref).toBeTruthy();
  });

  it('a signer can decline: nobody else is asked, the flow is told, and the document is not marked signed', async () => {
    const sub = await submit('AGR', 'no@customer.test');
    const first = await waitFor(() => linkTo('no@customer.test'), 'the email');
    const before = h.outbox.filter((m) => m.to === 'approver@acme.test').length;
    expect((await h.api().post(`/public/sign/${first.token}/decline`).send({ reason: 'The amount is wrong' }).expect(200)).body.status).toBe('DECLINED');
    await waitFor(async () => (await statusOf(sub.submissionId)) === 'REFUSED', 'the record to be marked refused');
    expect(h.outbox.filter((m) => m.to === 'approver@acme.test')).toHaveLength(before);
    // Nobody signed, so nobody is sent a signed copy.
    expect(h.outbox.filter((m) => /^Signed by everyone/.test(m.subject) && m.subject.includes(sub.ref))).toEqual([]);
    const [req] = (await h.api().get(`/records/${sub.submissionId}/signatures`).set(h.bearer(owner)).expect(200)).body;
    expect(req).toMatchObject({ status: 'DECLINED', hasSignedDocument: false, signers: [expect.objectContaining({ status: 'DECLINED', declineReason: 'The amount is wrong' }), expect.objectContaining({ status: 'WAITING' })] });
    await h.api().get(`/records/${sub.submissionId}/signatures/${req.id}/document`).set(h.bearer(owner)).expect(404);
    expect((await h.api().post(`/public/sign/${first.token}`).send(signBody('Too late')).expect(409)).body.message).toBe('This document was declined and is no longer open for signing.');
  });

  it('an answer that arrives the instant the invitation goes out still moves the flow on', async () => {
    // The narrowest moment: the signer declines after the invitation is sent and before the flow has noted
    // which request it is waiting for. Held open here on purpose; it once left the flow waiting for ever.
    const signatures = h.app.get(SignaturesService);
    const start = signatures.start.bind(signatures);
    const spy = jest.spyOn(signatures, 'start').mockImplementationOnce(async (p) => {
      const id = await start(p);
      const link = linkTo('quick@customer.test')!;
      await h.api().post(`/public/sign/${link.token}/decline`).send({ reason: 'Too quick for you' }).expect(200);
      return id;
    });
    const sub = await submit('AGR', 'quick@customer.test');
    await waitFor(async () => (await statusOf(sub.submissionId)) === 'REFUSED', 'the record to be marked refused');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('signers are reminded with a fresh link, and a request nobody signs in time lapses', async () => {
    await publish(form('SLOW', { expiresInDays: 7 }));
    const sub = await submit('SLOW', 'slow@customer.test');
    const first = await waitFor(() => linkTo('slow@customer.test'), 'the email');

    await queue.drain(new Date(Date.now() + 3 * DAY + 60_000));
    const reminder = await waitFor(() => linkTo('slow@customer.test', true), 'the reminder');
    expect(reminder.mail.subject).toMatch(/^Reminder: Acme Trading asks you to sign/);
    // Only the newest email signs.
    await h.api().get(`/public/sign/${first.token}`).expect(404);
    expect((await h.api().get(`/public/sign/${reminder.token}`).expect(200)).body.status).toBe('SENT');

    await queue.drain(new Date(Date.now() + 8 * DAY));
    await waitFor(async () => (await statusOf(sub.submissionId)) === 'LAPSED', 'the record to lapse');
    const latest = [...h.outbox].reverse().find((m) => m.to === 'slow@customer.test')!;
    const token = /\/sign\/(fbsig_[A-Za-z0-9_-]+)/.exec(latest.text)![1]!;
    expect((await h.api().post(`/public/sign/${token}`).send(signBody('Late')).expect(410)).body.message).toBe('The time to sign this document has passed.');
    expect((await h.api().get(`/records/${sub.submissionId}/signatures`).set(h.bearer(owner)).expect(200)).body[0].status).toBe('EXPIRED');
  });

  it('all at once: everyone is asked together and may sign in any order', async () => {
    await publish(form('BOTH', { order: 'PARALLEL' }));
    const sub = await submit('BOTH', 'pair@customer.test');
    const a = await waitFor(() => linkTo('pair@customer.test'), 'the requester\'s email');
    const b = await waitFor(() => [...h.outbox].reverse().find((m) => m.to === 'approver@acme.test' && m.subject.includes(sub.ref)), 'the approver\'s email');
    const bToken = /\/sign\/(fbsig_[A-Za-z0-9_-]+)/.exec(b.text)![1]!;
    await h.api().post(`/public/sign/${bToken}`).send(signBody('Asha Rao')).expect(200);
    expect(await statusOf(sub.submissionId)).toBe('NEW');
    await h.api().post(`/public/sign/${a.token}`).send(signBody('Pair')).expect(200);
    await waitFor(async () => (await statusOf(sub.submissionId)) === 'SIGNED', 'the record to be marked signed');
  });

  it('all at once and one declines: the other, already asked, is told their link no longer works', async () => {
    const sub = await submit('BOTH', 'split@customer.test');
    const a = await waitFor(() => linkTo('split@customer.test'), 'the requester\'s email');
    await waitFor(() => h.outbox.find((m) => m.to === 'approver@acme.test' && m.subject.includes(sub.ref)), 'the approver\'s email');
    await h.api().post(`/public/sign/${a.token}/decline`).send({}).expect(200);
    const told = await waitFor(() => h.outbox.find((m) => m.to === 'approver@acme.test' && m.subject === `No longer to be signed: Agreement ${sub.ref}`), 'word to the other signer');
    expect(told.text).toContain('One of the signers declined');
    expect(told.attachments).toBeUndefined();
    // The one who declined knows already.
    expect(h.outbox.filter((m) => m.to === 'split@customer.test' && /^No longer/.test(m.subject))).toEqual([]);
  });

  it('only people who may see a record see who signed it', async () => {
    const sub = await submit('AGR', 'private@customer.test');
    await h.api().get(`/records/${sub.submissionId}/signatures`).expect(401);
    await h.signUp('Zed', 'zed@other.test', 'Other');
    const stranger = (await h.login('zed@other.test')).token;
    const res = await h.api().get(`/records/${sub.submissionId}/signatures`).set(h.bearer(stranger));
    expect([403, 404]).toContain(res.status);
  });

  it('a signature step with nobody to sign is caught before the form is published', async () => {
    const bad = form('NOBODY', {});
    (bad.automations[0]!.actions[0] as { to: unknown[] }).to = [];
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: bad }).expect(201)).body.definition.id;
    expect(JSON.stringify((await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(400)).body)).toContain('choose who signs');
  });

  describe('more than the link: a code by email, or something the signer knows', () => {
    const one = (code: string, extra: object) => {
      const def = form(code, extra);
      // One signer keeps these stories short.
      (def.automations[0]!.actions[0] as { to: object[] }).to = [{ kind: 'FIELD', field: 'email' }];
      return def;
    };
    const codeFor = (to: string) => {
      const mail = [...h.outbox].reverse().find((m) => m.to === to && /is your code to sign/.test(m.subject));
      return mail ? /^\d{6}$/m.exec(mail.text)![0] : undefined;
    };

    it('a code is emailed when they are about to sign; without it the document cannot be read or signed', async () => {
      await publish(one('CODED', { confirm: 'EMAIL_CODE' }));
      const sub = await submit('CODED', 'coded@customer.test');
      const { token } = await waitFor(() => linkTo('coded@customer.test'), 'the signer\'s email');
      expect((await h.api().get(`/public/sign/${token}`).expect(200)).body).toMatchObject({ status: 'SENT', confirm: 'EMAIL_CODE', locked: false });

      // The link alone opens nothing.
      expect((await h.api().get(`/public/sign/${token}/document`).expect(403)).body.message).toBe('Enter the code we emailed you first.');
      await h.api().post(`/public/sign/${token}`).send(signBody('Meera Nair')).expect(403);
      await h.api().post(`/public/sign/${token}/confirm`).send({ code: '000000' }).expect(400); // none has been sent yet

      const sent = (await h.api().post(`/public/sign/${token}/code`).expect(200)).body;
      expect(sent).toEqual({ sentTo: 'c…@customer.test', minutes: 10 });
      const code = codeFor('coded@customer.test')!;
      // Not again straight away.
      await h.api().post(`/public/sign/${token}/code`).expect(429);

      const wrong = code === '123456' ? '654321' : '123456';
      expect((await h.api().post(`/public/sign/${token}/confirm`).send({ code: wrong }).expect(403)).body.message).toBe('That is not right. Check it and try again.');
      const { pass } = (await h.api().post(`/public/sign/${token}/confirm`).send({ code }).expect(200)).body as { pass: string };
      // The code is used up; the pass it gave is what lets the page on.
      await h.api().post(`/public/sign/${token}/confirm`).send({ code }).expect(400);
      await h.api().get(`/public/sign/${token}/document?pass=${encodeURIComponent(pass)}`).expect(200);
      await h.api().get(`/public/sign/${token}/document?pass=${encodeURIComponent(`${pass}x`)}`).expect(403);
      // A pass made for one signer's link is no use with another's.
      await publish(one('CODED_TWO', { confirm: 'EMAIL_CODE' }));
      await submit('CODED_TWO', 'other@customer.test');
      const other = await waitFor(() => linkTo('other@customer.test'), 'the other signer\'s email');
      await h.api().get(`/public/sign/${other.token}/document?pass=${encodeURIComponent(pass)}`).expect(403);

      expect((await h.api().post(`/public/sign/${token}`).send({ ...signBody('Meera Nair'), pass }).expect(200)).body.status).toBe('SIGNED');
      await waitFor(async () => ((await statusOf(sub.submissionId)) === 'SIGNED' ? true : undefined), 'the flow to carry on');
      // The page of signatures says how they were confirmed.
      const signed = await h.api().get(`/public/sign/${token}/document`).buffer(true).parse(binary).expect(200);
      const text = (await pdfParse(signed.body)).text.replace(/\s+/g, ' ');
      expect(text).toContain('Confirmed before signing');
      expect(text).toContain('By a code emailed to that address');
      expect(text).toContain('entered a code emailed to them at that moment');
    });

    it('a code guessed at too often is thrown away, and after too many codes the link stops working', async () => {
      await publish(one('GUESS', { confirm: 'EMAIL_CODE' }));
      await submit('GUESS', 'guess@customer.test');
      const { token } = await waitFor(() => linkTo('guess@customer.test'), 'the signer\'s email');
      const clock = jest.spyOn(Date, 'now');
      const start = Date.now();
      try {
        for (let round = 1; round <= 5; round++) {
          // A minute and a bit later each time, so another code may be asked for.
          clock.mockReturnValue(start + round * 70_000);
          await h.api().post(`/public/sign/${token}/code`).expect(200);
          const code = codeFor('guess@customer.test')!;
          const wrong = code === '111111' ? '222222' : '111111';
          for (let i = 0; i < 4; i++) await h.api().post(`/public/sign/${token}/confirm`).send({ code: wrong }).expect(403);
          const last = (await h.api().post(`/public/sign/${token}/confirm`).send({ code: wrong }).expect(403)).body.message as string;
          expect(last).toContain(round < 5 ? 'that code has been tried too often. Ask for a new one.' : 'that code has been tried too often');
          // Even the right code no longer works once it has been thrown away.
          if (round < 5) await h.api().post(`/public/sign/${token}/confirm`).send({ code }).expect(400);
        }
        clock.mockReturnValue(start + 6 * 70_000);
        expect((await h.api().get(`/public/sign/${token}`).expect(200)).body.locked).toBe(true);
        expect((await h.api().post(`/public/sign/${token}/code`).expect(403)).body.message).toContain('this link no longer works');
        await h.api().post(`/public/sign/${token}`).send(signBody('Someone')).expect(403);
      } finally {
        clock.mockRestore();
      }
    });

    it('something they know: an answer from the form, compared as a person would; five wrong tries and the link stops working', async () => {
      const def = one('KNOWN', { confirm: 'KNOWN', known: '{{customer}}', knownLabel: 'the name on your account' });
      await publish(def);
      const sub = await submit('KNOWN', 'ravi2@customer.test');
      const { token } = await waitFor(() => linkTo('ravi2@customer.test'), 'the signer\'s email');
      const page = (await h.api().get(`/public/sign/${token}`).expect(200)).body;
      expect(page).toMatchObject({ confirm: 'KNOWN', asks: 'the name on your account', locked: false });
      // What they must know is nowhere on the page.
      expect(page).not.toHaveProperty('knownHash');
      expect(page).not.toHaveProperty('known');
      expect((await h.api().get(`/public/sign/${token}/document`).expect(403)).body.message).toBe('Enter the name on your account first.');
      await h.api().post(`/public/sign/${token}/code`).expect(400); // this one does not send codes
      await h.api().post(`/public/sign/${token}/confirm`).send({ code: 'Asha Rao' }).expect(403);
      // Capitals, spaces and dashes do not matter.
      const { pass } = (await h.api().post(`/public/sign/${token}/confirm`).send({ code: '  ravi-KUMAR ' }).expect(200)).body as { pass: string };
      expect((await h.api().post(`/public/sign/${token}`).send({ ...signBody('Ravi Kumar'), pass }).expect(200)).body.status).toBe('SIGNED');
      await waitFor(async () => ((await statusOf(sub.submissionId)) === 'SIGNED' ? true : undefined), 'the flow to carry on');
      const signed = await h.api().get(`/public/sign/${token}/document`).buffer(true).parse(binary).expect(200);
      expect((await pdfParse(signed.body)).text.replace(/\s+/g, ' ')).toContain('By giving the name on your account');

      // Someone who has the link but not the answer.
      await submit('KNOWN', 'thief@customer.test');
      const stolen = await waitFor(() => linkTo('thief@customer.test'), 'the second email');
      for (let i = 0; i < 4; i++) await h.api().post(`/public/sign/${stolen.token}/confirm`).send({ code: `guess ${i}` }).expect(403);
      expect((await h.api().post(`/public/sign/${stolen.token}/confirm`).send({ code: 'guess 5' }).expect(403)).body.message).toContain('this link no longer works');
      // Now even the right answer is refused.
      await h.api().post(`/public/sign/${stolen.token}/confirm`).send({ code: 'Ravi Kumar' }).expect(403);
      expect((await h.api().get(`/public/sign/${stolen.token}`).expect(200)).body.locked).toBe(true);
    });

    it('a form whose PDFs are sealed: signers read an unsealed copy, and the finished document, with its page of signatures, is sealed', async () => {
      const def = { ...one('SEALSIGN', {}), document: { keep: true, seal: true } };
      await publish(def);
      const sub = await submit('SEALSIGN', 'seal@customer.test');
      const { token } = await waitFor(() => linkTo('seal@customer.test'), 'the signer\'s email');
      // What is put in front of the signer is not sealed: the page of signatures has still to be added to it.
      const shown = await h.api().get(`/public/sign/${token}/document`).buffer(true).parse(binary).expect(200);
      expect((shown.body as Buffer).toString('latin1')).not.toContain('/DocMDP');
      expect((await h.api().post(`/public/sign/${token}`).send(signBody('Ravi Kumar')).expect(200)).body.status).toBe('SIGNED');
      await waitFor(async () => ((await statusOf(sub.submissionId)) === 'SIGNED' ? true : undefined), 'the flow to carry on');
      const signed = (await h.api().get(`/public/sign/${token}/document`).buffer(true).parse(binary).expect(200)).body as Buffer;
      expect(signed.toString('latin1')).toMatch(/\/Perms\s*<<\s*\/DocMDP \d+ 0 R/);
      const parsed = await pdfParse(signed);
      expect(parsed.text.replace(/\s+/g, ' ')).toContain('is sealed with the organisation');
      expect(parsed.numpages).toBe((await pdfParse(shown.body)).numpages + 1);
      if (spawnSync('pdfsig', ['-v'], { stdio: 'ignore' }).status === 0 || process.env.REQUIRE_PDFSIG) {
        const file = join(dir, 'signed-sealed.pdf');
        writeFileSync(file, signed);
        const said = spawnSync('pdfsig', [file], { encoding: 'utf8' });
        expect(`${said.stdout}${said.stderr}`).toContain('Signature Validation: Signature is Valid.');
        expect(`${said.stdout}${said.stderr}`).toMatch(/Total document signed/);
      }
    });

    it('an archival form\'s signed copy is archival too, page of signatures and seal included (checked by veraPDF where it is to hand)', async () => {
      const def = { ...one('ARCHSIGN', {}), document: { keep: true, seal: true, archival: true } };
      await publish(def);
      const sub = await submit('ARCHSIGN', 'archival@customer.test');
      const { token } = await waitFor(() => linkTo('archival@customer.test'), 'the signer\'s email');
      expect((await h.api().post(`/public/sign/${token}`).send(signBody('Ravi Kumar')).expect(200)).body.status).toBe('SIGNED');
      await waitFor(async () => ((await statusOf(sub.submissionId)) === 'SIGNED' ? true : undefined), 'the flow to carry on');
      const signed = (await h.api().get(`/public/sign/${token}/document`).buffer(true).parse(binary).expect(200)).body as Buffer;
      expect(signed.toString('latin1')).toContain('pdfaid:part');
      expect(signed.toString('latin1')).toMatch(/\/Perms\s*<<\s*\/DocMDP \d+ 0 R/);
      if (spawnSync('docker', ['image', 'inspect', 'verapdf/cli'], { stdio: 'ignore' }).status === 0 || process.env.REQUIRE_VERAPDF) {
        const folder = mkdtempSync(join(tmpdir(), 'fb-archsign-'));
        chmodSync(folder, 0o755);
        writeFileSync(join(folder, 'signed.pdf'), signed);
        const run = spawnSync('docker', ['run', '--rm', '-v', `${folder}:/data:ro`, 'verapdf/cli', '--flavour', '2b', '--format', 'text', '/data/signed.pdf'], { encoding: 'utf8', timeout: 200_000 });
        rmSync(folder, { recursive: true, force: true });
        expect(`${run.stdout}\n${run.stderr}`).toContain('PASS /data/signed.pdf 2b');
      }
    }, 240_000);

    it('a step that asks for something they know must say what, and what to call it', async () => {
      const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: one('KNOWN_BAD', { confirm: 'KNOWN', known: '{{customer}}' }) }).expect(201)).body.definition.id as string;
      expect(JSON.stringify((await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(400)).body)).toContain('say what the signers must know before they can sign');
    });
  });
});
