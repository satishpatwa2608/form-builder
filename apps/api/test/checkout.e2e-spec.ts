import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { FormSubmission } from '../src/work/schemas/form-submission.schema';
import { fillSms } from '../src/verify/sms.service';
import { startApp, type Harness } from './harness';

/** A stand-in for somebody else's service: answers what the test tells it to, and remembers what it was sent. */
async function standIn(answer: (req: { method: string; path: string; body: string; headers: IncomingMessage['headers'] }) => { status?: number; json: unknown }) {
  const seen: { method: string; path: string; body: string; headers: IncomingMessage['headers'] }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const got = { method: req.method ?? '', path: req.url ?? '', body, headers: req.headers };
      seen.push(got);
      const { status = 200, json } = answer(got);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

describe('What goes into a text message', () => {
  it('the number and the words are written the way the place they go needs', () => {
    expect(fillSms('{"to":"{{to}}","text":"{{ message }}"}', '+919812345678', 'Code "123456"\nfor you', 'JSON')).toBe('{"to":"+919812345678","text":"Code \\"123456\\"\\nfor you"}');
    expect(fillSms('https://sms.test/send?to={{to}}&msg={{message}}', '+919812345678', 'a b&c', 'URL')).toBe('https://sms.test/send?to=%2B919812345678&msg=a%20b%26c');
  });
});

describe('Forms: confirming with a code, and paying (e2e)', () => {
  let h: Harness;
  let owner: string;
  let orgId: string;
  let folder: string;
  let submissions: Model<FormSubmission>;
  const texts: { to: string; message: string }[] = [];
  let sms: Awaited<ReturnType<typeof standIn>>;

  const publish = async (code: string, more: Record<string, unknown>) => {
    const definition = {
      name: `Form ${code}`,
      code,
      businessId: '',
      access: 'PUBLIC',
      submission: { method: 'POST', endpointId: 'default-submit' },
      fields: [
        { id: 'n', type: 'TEXT', name: 'name', label: 'Name', required: true },
        { id: 'e', type: 'EMAIL', name: 'email', label: 'Email', required: true },
        { id: 'm', type: 'PHONE', name: 'mobile', label: 'Mobile' },
        { id: 'q', type: 'NUMBER', name: 'seats', label: 'Seats', validation: { min: 0, max: 10 } },
        { id: 'f', type: 'NUMBER', name: 'fee', label: 'Fee', disabled: true },
      ],
      rules: [{ id: 'fee', then: [{ type: 'SET_VALUE', target: 'fee', value: 'seats * 250' }] }],
      ...more,
    };
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  };
  const at = (path: string) => `/public${path}${path.includes('?') ? '&' : '?'}org=${orgId}`;
  const codeIn = (text: string) => /\b([0-9]{6})\b/.exec(text)![1]!;

  beforeAll(async () => {
    process.env.SMS_ALLOW_PRIVATE = 'true';
    sms = await standIn((req) => {
      const sent = JSON.parse(req.body || '{}') as { to: string; message: string };
      texts.push(sent);
      return sent.to === '+910000000000' ? { status: 422, json: { error: 'number not reachable, account 99812' } } : { json: { ok: true } };
    });
    h = await startApp();
    submissions = h.app.get(getModelToken(FormSubmission.name));
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Forms' }).expect(201)).body[0].id;
  });
  afterAll(async () => {
    delete process.env.SMS_ALLOW_PRIVATE;
    delete process.env.PAY_RAZORPAY_URL;
    delete process.env.PAY_STRIPE_URL;
    await sms.close();
    await h?.close();
  });

  describe('a one-time code', () => {
    const email = { ...{ id: 'e', type: 'EMAIL', name: 'email', label: 'Email', required: true }, props: { verify: true } };
    const mobile = { id: 'm', type: 'PHONE', name: 'mobile', label: 'Mobile', props: { verify: true } };
    const values = { name: 'Ravi', email: 'Ravi@Example.test', seats: 1 };

    beforeAll(async () => {
      await publish('CODES', { fields: [{ id: 'n', type: 'TEXT', name: 'name', label: 'Name', required: true }, email, mobile, { id: 'q', type: 'NUMBER', name: 'seats', label: 'Seats' }], rules: [] });
    });

    it('an address the form asks to be confirmed is refused without its proof', async () => {
      const res = await h.api().post(at('/forms/CODES/submissions')).send({ values }).expect(422);
      expect(res.body.errors).toEqual([{ field: 'email', message: 'Confirm this email address with the code we send to it' }]);
      expect(await submissions.countDocuments({ formCode: 'CODES' })).toBe(0);
    });

    it('sends the code by email, refuses a wrong one, and gives a proof for the right one', async () => {
      expect((await h.api().post(at('/forms/CODES/codes')).send({ field: 'email', value: values.email }).expect(202)).body).toEqual({ sent: true, minutes: 10 });
      const mail = h.outbox.find((m) => m.to === 'ravi@example.test')!;
      expect(mail.subject).toMatch(/^[0-9]{6} is your code$/);
      expect(mail.text).toContain('"Form CODES"');
      const code = codeIn(mail.subject);
      const wrong = code === '000000' ? '111111' : '000000';
      expect((await h.api().post(at('/forms/CODES/codes/check')).send({ field: 'email', value: values.email, code: wrong }).expect(400)).body.errors[0].message).toBe('That code is not right. Check it and try again.');
      const proof = (await h.api().post(at('/forms/CODES/codes/check')).send({ field: 'email', value: ' ravi@example.test ', code }).expect(200)).body.proof as string;
      expect(proof).toMatch(/^v1\.[0-9]+\.[A-Za-z0-9_-]+$/);
      // A code is spent once it has made a proof.
      await h.api().post(at('/forms/CODES/codes/check')).send({ field: 'email', value: values.email, code }).expect(400);

      // The proof is for that address alone, on that field, on that form.
      await h.api().post(at('/forms/CODES/submissions')).send({ values: { ...values, email: 'someone.else@example.test' }, proofs: { email: proof } }).expect(422);
      await h.api().post(at('/forms/CODES/submissions')).send({ values, proofs: { email: `${proof}x` } }).expect(422);
      await h.api().post(at('/forms/CODES/submissions')).send({ values, proofs: { email: proof.replace(/^v1\.[0-9]+/, `v1.${Date.now() + 9e9}`) } }).expect(422);
      const ok = await h.api().post(at('/forms/CODES/submissions')).send({ values, proofs: { email: proof } }).expect(201);
      expect(ok.body.payload.email).toBe('Ravi@Example.test');
      // Nothing about the proof is kept with the response.
      expect(JSON.stringify(await submissions.findOne({ formCode: 'CODES' }).lean())).not.toContain(proof);
    });

    it('five wrong tries spend a code; more than five codes in an hour are not sent', async () => {
      await h.api().post(at('/forms/CODES/codes')).send({ field: 'email', value: 'tries@example.test' }).expect(202);
      const code = codeIn(h.outbox.filter((m) => m.to === 'tries@example.test').pop()!.subject);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await h.api().post(at('/forms/CODES/codes/check')).send({ field: 'email', value: 'tries@example.test', code: wrong }).expect(400);
      expect((await h.api().post(at('/forms/CODES/codes/check')).send({ field: 'email', value: 'tries@example.test', code }).expect(400)).body.errors[0].message).toBe('That code has expired. Ask for a new one.');
      for (let i = 0; i < 4; i++) await h.api().post(at('/forms/CODES/codes')).send({ field: 'email', value: 'tries@example.test' }).expect(202);
      await h.api().post(at('/forms/CODES/codes')).send({ field: 'email', value: 'tries@example.test' }).expect(429);
    });

    it('only fields the designer chose, of forms that exist, with something that looks like an address', async () => {
      await h.api().post(at('/forms/CODES/codes')).send({ field: 'name', value: 'x@example.test' }).expect(404);
      await h.api().post(at('/forms/NO_SUCH/codes')).send({ field: 'email', value: 'x@example.test' }).expect(404);
      await h.api().post(at('/forms/CODES/codes')).send({ field: 'email', value: 'not an address' }).expect(400);
      await h.api().post(at('/forms/CODES/codes')).send({ field: 'mobile', value: '12' }).expect(400);
    });

    it('a phone number needs the organisation\'s own SMS service, which is set up, tested and only then used', async () => {
      await h.api().post(at('/forms/CODES/codes')).send({ field: 'mobile', value: '+91 98123 45678' }).expect(503);
      await h.addMember(owner, 'Dev', 'dev@acme.test', 'DESIGNER');
      const dev = (await h.login('dev@acme.test')).token;
      await h.api().get('/org/sms').set(h.bearer(dev)).expect(403);
      await h.api().put('/org/sms').set(h.bearer(dev)).send({ url: sms.url }).expect(403);

      await h.api().put('/org/sms').set(h.bearer(owner)).send({ url: 'ftp://sms.test' }).expect(400);
      await h.api().put('/org/sms').set(h.bearer(owner)).send({ url: sms.url, headers: [{ name: 'Host', value: 'x' }] }).expect(400);
      const saved = (await h.api().put('/org/sms').set(h.bearer(owner)).send({ url: `${sms.url}/send`, headers: [{ name: 'Authorization', value: 'Bearer sms-secret-key' }] }).expect(200)).body;
      expect(saved).toMatchObject({ url: `${sms.url}/send`, method: 'POST', format: 'JSON', enabled: false, headers: [{ name: 'Authorization', valueSet: true }] });
      expect(JSON.stringify(saved)).not.toContain('sms-secret-key');
      // Saved is not yet used: a test must go through first.
      await h.api().post(at('/forms/CODES/codes')).send({ field: 'mobile', value: '+919812345678' }).expect(503);
      const failed = (await h.api().post('/org/sms/test').set(h.bearer(owner)).send({ to: '+910000000000' }).expect(200)).body;
      expect(failed).toMatchObject({ enabled: false, lastError: expect.stringContaining('Your SMS service answered 422') });
      await h.api().post('/org/sms/test').set(h.bearer(owner)).send({ to: 'abc' }).expect(400);
      expect((await h.api().post('/org/sms/test').set(h.bearer(owner)).send({ to: '+91 98123 45678' }).expect(200)).body).toMatchObject({ enabled: true, lastError: '' });
      expect(sms.seen.at(-1)).toMatchObject({ method: 'POST', path: '/send' });
      expect(sms.seen.at(-1)!.headers.authorization).toBe('Bearer sms-secret-key');

      // Changing a setting without retyping the secret keeps it; and it must be tested again.
      const kept = (await h.api().put('/org/sms').set(h.bearer(owner)).send({ headers: [{ name: 'Authorization' }] }).expect(200)).body;
      expect(kept).toMatchObject({ enabled: false, headers: [{ name: 'Authorization', valueSet: true }] });
      await h.api().post('/org/sms/test').set(h.bearer(owner)).send({ to: '+919812345678' }).expect(200);
      expect(sms.seen.at(-1)!.headers.authorization).toBe('Bearer sms-secret-key');

      await h.api().post(at('/forms/CODES/codes')).send({ field: 'mobile', value: '+91 98123-45678' }).expect(202);
      const text = texts.at(-1)!;
      expect(text.to).toBe('+919812345678');
      const proof = (await h.api().post(at('/forms/CODES/codes/check')).send({ field: 'mobile', value: '+919812345678', code: codeIn(text.message) }).expect(200)).body.proof;
      // With a number given, it too must be proven; the email's proof does not cover it.
      await h.api().post(at('/forms/CODES/codes')).send({ field: 'email', value: 'both@example.test' }).expect(202);
      const emailProof = (await h.api().post(at('/forms/CODES/codes/check')).send({ field: 'email', value: 'both@example.test', code: codeIn(h.outbox.filter((m) => m.to === 'both@example.test').pop()!.subject) }).expect(200)).body.proof;
      const both = { name: 'Both', email: 'both@example.test', mobile: '+91 98123 45678', seats: 1 };
      expect((await h.api().post(at('/forms/CODES/submissions')).send({ values: both, proofs: { email: emailProof } }).expect(422)).body.errors).toEqual([{ field: 'mobile', message: 'Confirm this number with the code we send to it' }]);
      await h.api().post(at('/forms/CODES/submissions')).send({ values: both, proofs: { email: emailProof, mobile: proof } }).expect(201);
      // A message that does not go out is said so, without the service's own words.
      const refused = await h.api().post(at('/forms/CODES/codes')).send({ field: 'mobile', value: '+910000000000' }).expect(503);
      expect(JSON.stringify(refused.body)).not.toMatch(/99812|422/);
    });
  });

  describe('a payment', () => {
    const pay = { payment: { enabled: true, amountField: 'fee', currency: 'INR', description: 'Workshop seats' } };
    const values = { name: 'Meera', email: 'meera@example.test', seats: 2 };
    const paidFor = (code: string) => submissions.find({ formCode: code }).lean();

    beforeAll(async () => {
      for (const code of ['PAY_NONE', 'PAY_TEST', 'PAY_RZP', 'PAY_STRIPE']) await publish(code, pay);
    });

    it('a form that takes a payment is not submitted without one, and says so before the organisation has a service', async () => {
      const res = await h.api().post(at('/forms/PAY_NONE/submissions')).send({ values }).expect(402);
      expect(res.body).toMatchObject({ paymentRequired: true });
      await h.api().post(at('/forms/PAY_NONE/payments')).send({ values }).expect(503);
      // Nothing to pay: it goes straight through.
      const free = (await h.api().post(at('/forms/PAY_NONE/payments')).send({ values: { ...values, seats: 0 } }).expect(200)).body;
      expect(free.submitted.submissionId).toBeTruthy();
      expect(await submissions.countDocuments({ formCode: 'PAY_NONE' })).toBe(1);
      // A form that takes no payment has nothing to pay for.
      await publish('NO_PAY', {});
      await h.api().post(at('/forms/NO_PAY/payments')).send({ values }).expect(400);
    });

    it('the payment service is the organisation\'s setting: administrators only, the secret never shown', async () => {
      const dev = (await h.login('dev@acme.test')).token;
      await h.api().get('/org/payments').set(h.bearer(dev)).expect(403);
      await h.api().put('/org/payments').set(h.bearer(dev)).send({ provider: 'TEST' }).expect(403);
      expect((await h.api().get('/org/payments').set(h.bearer(owner)).expect(200)).body).toMatchObject({ provider: 'NONE', secretSet: false });
      await h.api().put('/org/payments').set(h.bearer(owner)).send({ provider: 'RAZORPAY' }).expect(400);
      await h.api().put('/org/payments').set(h.bearer(owner)).send({ provider: 'PAYPAL' }).expect(400);
      const saved = (await h.api().put('/org/payments').set(h.bearer(owner)).send({ provider: 'TEST' }).expect(200)).body;
      expect(saved).toMatchObject({ provider: 'TEST', secretSet: false });
      expect(saved.providers.map((p: { id: string }) => p.id)).toEqual(['NONE', 'TEST', 'RAZORPAY', 'STRIPE']);
    });

    it('practice payments: the answers are checked first, the amount is the server\'s, and paying makes one response', async () => {
      // Answers that would be refused are refused before anyone is asked to pay.
      expect((await h.api().post(at('/forms/PAY_TEST/payments')).send({ values: { email: 'meera@example.test', seats: 2 } }).expect(422)).body.errors[0].field).toBe('name');
      const started = (await h.api().post(at('/forms/PAY_TEST/payments')).send({ values: { ...values, fee: 1 } }).expect(200)).body.payment;
      expect(started).toMatchObject({ amount: 500, currency: 'INR' });
      expect(started.url).toMatch(new RegExp(`/pay/${started.id}/practice\\?org=${orgId}$`));
      expect(await paidFor('PAY_TEST')).toHaveLength(0);
      expect((await h.api().get(at(`/payments/${started.id}`)).expect(200)).body).toMatchObject({ status: 'PENDING', amount: 500, currency: 'INR', practice: true });
      // Coming back without having paid changes nothing.
      expect((await h.api().post(at(`/payments/${started.id}/confirm`)).expect(200)).body.status).toBe('PENDING');
      await h.api().post(at(`/payments/${started.id}/practice`)).send({ outcome: 'MAYBE' }).expect(400);

      const done = (await h.api().post(at(`/payments/${started.id}/practice`)).send({ outcome: 'PAID' }).expect(200)).body;
      expect(done).toMatchObject({ status: 'SUBMITTED', formCode: 'PAY_TEST' });
      const [record] = await paidFor('PAY_TEST');
      expect(record).toMatchObject({ uuid: done.submissionId, payload: { name: 'Meera', seats: 2, fee: 500 }, payment: { id: started.id, provider: 'TEST', amountMinor: 50_000, currency: 'INR' } });
      // Asked again, by a reload or a second tab: the same response, not another.
      expect((await h.api().post(at(`/payments/${started.id}/confirm`)).expect(200)).body).toMatchObject({ status: 'SUBMITTED', submissionId: done.submissionId });
      await h.api().post(at(`/payments/${started.id}/practice`)).send({ outcome: 'FAILED' }).expect(200);
      expect(await paidFor('PAY_TEST')).toHaveLength(1);
      // The answers held while paying are gone once they are a response.
      const row = await h.app.get<Model<{ held: unknown }>>(getModelToken('Payment')).findOne({ id: started.id }).lean();
      expect(row!.held).toBeNull();
    });

    it('a payment that fails makes no response; one that is not this organisation\'s is not found', async () => {
      const started = (await h.api().post(at('/forms/PAY_TEST/payments')).send({ values }).expect(200)).body.payment;
      expect((await h.api().post(at(`/payments/${started.id}/practice`)).send({ outcome: 'FAILED' }).expect(200)).body).toEqual({ status: 'FAILED', formCode: 'PAY_TEST' });
      expect(await paidFor('PAY_TEST')).toHaveLength(1);
      await h.signUp('Omar', 'omar@other.test', 'Other');
      const otherOrg = (await h.api().get('/auth/me').set(h.bearer((await h.login('omar@other.test')).token))).body.org.id;
      await h.api().get(`/public/payments/${started.id}?org=${otherOrg}`).expect(404);
      await h.api().post(`/public/payments/${started.id}/confirm?org=${otherOrg}`).expect(404);
      await h.api().post(at('/payments/not-a-payment/confirm')).expect(404);
    });

    it('Razorpay: sent to its page for the right amount, and believed only when it says the money arrived', async () => {
      const link = { status: 'created', amount_paid: 0 };
      const rzp = await standIn((req) => (req.method === 'POST' ? { json: { id: 'plink_Abc123', short_url: 'https://rzp.test/i/Abc123' } } : { json: { id: 'plink_Abc123', currency: 'INR', ...link } }));
      process.env.PAY_RAZORPAY_URL = rzp.url;
      try {
        const saved = (await h.api().put('/org/payments').set(h.bearer(owner)).send({ provider: 'RAZORPAY', keyId: 'rzp_test_key', secret: 'rzp-secret-value' }).expect(200)).body;
        expect(saved).toMatchObject({ provider: 'RAZORPAY', keyId: 'rzp_test_key', secretSet: true });
        expect(JSON.stringify(saved)).not.toContain('rzp-secret-value');

        const started = (await h.api().post(at('/forms/PAY_RZP/payments')).send({ values: { ...values, seats: 3 } }).expect(200)).body.payment;
        expect(started).toMatchObject({ url: 'https://rzp.test/i/Abc123', amount: 750, currency: 'INR' });
        const asked = rzp.seen[0]!;
        expect(asked).toMatchObject({ method: 'POST', path: '/v1/payment_links' });
        expect(asked.headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_key:rzp-secret-value').toString('base64')}`);
        expect(JSON.parse(asked.body)).toMatchObject({ amount: 75_000, currency: 'INR', description: 'Workshop seats', reference_id: started.id, callback_method: 'get' });
        expect(JSON.parse(asked.body).callback_url).toContain(`/pay/${started.id}?org=${orgId}`);
        // The practice route is not a way round a real service.
        await h.api().post(at(`/payments/${started.id}/practice`)).send({ outcome: 'PAID' }).expect(404);

        expect((await h.api().post(at(`/payments/${started.id}/confirm`)).expect(200)).body.status).toBe('PENDING');
        // Paid, but less than was due: not a response.
        Object.assign(link, { status: 'paid', amount_paid: 100 });
        await h.api().post(at(`/payments/${started.id}/confirm`)).expect(409);
        expect(await paidFor('PAY_RZP')).toHaveLength(0);
        Object.assign(link, { status: 'paid', amount_paid: 75_000 });
        const done = (await h.api().post(at(`/payments/${started.id}/confirm`)).expect(200)).body;
        expect(done.status).toBe('SUBMITTED');
        expect((await paidFor('PAY_RZP'))[0]).toMatchObject({ payload: { fee: 750 }, payment: { provider: 'RAZORPAY', reference: 'plink_Abc123', amountMinor: 75_000 } });

        // When the service is down the person is told to try again, not shown its words.
        const down = await standIn(() => ({ status: 401, json: { error: { description: 'Authentication failed for key rzp_test_key' } } }));
        process.env.PAY_RAZORPAY_URL = down.url;
        const refused = await h.api().post(at('/forms/PAY_RZP/payments')).send({ values }).expect(503);
        expect(JSON.stringify(refused.body)).not.toMatch(/rzp_test_key|Authentication/);
        await down.close();
      } finally {
        await rzp.close();
      }
    });

    it('Stripe: the same, through its own page', async () => {
      const session = { payment_status: 'unpaid', status: 'open', amount_total: 50_000 };
      const stripe = await standIn((req) => (req.method === 'POST' ? { json: { id: 'cs_test_1', url: 'https://checkout.stripe.test/c/pay/cs_test_1' } } : { json: { id: 'cs_test_1', currency: 'inr', ...session } }));
      process.env.PAY_STRIPE_URL = stripe.url;
      try {
        await h.api().put('/org/payments').set(h.bearer(owner)).send({ provider: 'STRIPE' }).expect(400);
        expect((await h.api().put('/org/payments').set(h.bearer(owner)).send({ provider: 'STRIPE', secret: 'sk_test_secret' }).expect(200)).body).toMatchObject({ provider: 'STRIPE', keyId: '', secretSet: true });
        const started = (await h.api().post(at('/forms/PAY_STRIPE/payments')).send({ values }).expect(200)).body.payment;
        expect(started.url).toBe('https://checkout.stripe.test/c/pay/cs_test_1');
        const asked = new URLSearchParams(stripe.seen[0]!.body);
        expect(stripe.seen[0]!.headers.authorization).toBe('Bearer sk_test_secret');
        expect(Object.fromEntries(asked)).toMatchObject({ mode: 'payment', client_reference_id: started.id, 'line_items[0][price_data][currency]': 'inr', 'line_items[0][price_data][unit_amount]': '50000', 'line_items[0][price_data][product_data][name]': 'Workshop seats' });
        expect((await h.api().post(at(`/payments/${started.id}/confirm`)).expect(200)).body.status).toBe('PENDING');
        session.payment_status = 'paid';
        expect((await h.api().post(at(`/payments/${started.id}/confirm`)).expect(200)).body.status).toBe('SUBMITTED');
        expect((await paidFor('PAY_STRIPE'))[0]).toMatchObject({ payment: { provider: 'STRIPE', reference: 'cs_test_1', amountMinor: 50_000, currency: 'INR' } });
        expect(stripe.seen.at(-1)).toMatchObject({ method: 'GET', path: '/v1/checkout/sessions/cs_test_1' });
      } finally {
        await stripe.close();
      }
    });

    it('what the public is given of the form says a payment is due, and nothing of how it is taken', async () => {
      const served = (await h.api().get(at('/forms/PAY_TEST')).expect(200)).body;
      const def = served.definition ?? served.data?.definition ?? served.data ?? served;
      expect(def.payment).toEqual(pay.payment);
      expect(JSON.stringify(served)).not.toMatch(/sk_test_secret|rzp-secret-value|STRIPE|RAZORPAY/);
    });
  });
});
