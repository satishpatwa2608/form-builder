import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { newId, SecretBox, installationBox } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config';
import { orgLog } from '../logs/org-log';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { FormSubmissionService, type SubmitBody } from '../work/services/form-submission.service';
import { Payment, type PaymentDocument } from './payment.schema';
import { fromMinor, PROVIDERS, RazorpayProvider, StripeProvider, toMinor, type PaymentProvider, type ProviderId } from './providers';

interface Stored {
  provider?: ProviderId;
  keyId?: string;
  secret?: string;
}
type OptionalUser = Parameters<FormSubmissionService['submit']>[3];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const formAppUrl = () => (process.env.FORM_APP_URL ?? 'http://localhost:5174').replace(/\/+$/, '');
const fault = (field: string, message: string) => new BadRequestException({ message, errors: [{ field, message }] });

/**
 * Money taken with a response. The form says how much (a number field) and in which currency; the organisation
 * says which payment service takes it. The person's answers are checked in full, held while they pay on the
 * service's own page, and become a response only once the service itself says the money has arrived.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger('Payments');
  private readonly box: SecretBox;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly submissions: FormSubmissionService,
    private readonly audit: AuditService,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(Payment.name) private readonly payments: Model<PaymentDocument>,
  ) {
    this.box = installationBox(config);
  }

  // ── The organisation's setting ───────────────────────────────────────────

  private view(s: Stored | undefined) {
    return { provider: s?.provider ?? 'NONE', keyId: s?.keyId ?? '', secretSet: !!s?.secret, providers: Object.entries(PROVIDERS).map(([id, name]) => ({ id, name })) };
  }

  async settings(auth: AuthContext) {
    return this.view((await this.orgs.findOne({ id: auth.orgId }).select('payments').lean())?.payments as Stored | undefined);
  }

  async update(auth: AuthContext, input: { provider?: ProviderId; keyId?: string; secret?: string }) {
    const org = await this.orgs.findOne({ id: auth.orgId });
    if (!org) throw new NotFoundException('Organisation not found');
    const now = ((org.get('payments') as Stored | undefined) ?? {}) as Stored;
    const next: Stored = { ...now };
    if (input.provider !== undefined && input.provider !== now.provider) {
      // Another service's keys are no use to this one.
      next.provider = input.provider;
      next.keyId = '';
      next.secret = '';
    }
    if (input.keyId !== undefined) next.keyId = input.keyId.trim().slice(0, 200);
    if (input.secret) next.secret = this.box.seal(input.secret.trim().slice(0, 500));
    if (next.provider === 'RAZORPAY' && (!next.keyId || !next.secret)) throw fault('keyId', 'Enter the key ID and the key secret from your Razorpay dashboard');
    if (next.provider === 'STRIPE' && !next.secret) throw fault('secret', 'Enter the secret key from your Stripe dashboard');
    org.set('payments', next);
    org.markModified('payments');
    await org.save();
    await this.audit.record(actorOf(auth), { action: 'org.payments_updated', targetType: 'organization', targetId: auth.orgId, after: { provider: next.provider ?? 'NONE', secretChanged: !!input.secret } });
    return this.view(next);
  }

  private async providerOf(orgId: string): Promise<{ id: ProviderId; provider: PaymentProvider | null }> {
    const s = (await this.orgs.findOne({ id: orgId }).select('payments').lean())?.payments as Stored | undefined;
    const test = this.config.NODE_ENV !== 'production';
    if (s?.provider === 'RAZORPAY' && s.secret) return { id: 'RAZORPAY', provider: new RazorpayProvider({ keyId: s.keyId ?? '', secret: this.box.open(s.secret) }, (test && process.env.PAY_RAZORPAY_URL) || undefined) };
    if (s?.provider === 'STRIPE' && s.secret) return { id: 'STRIPE', provider: new StripeProvider({ keyId: '', secret: this.box.open(s.secret) }, (test && process.env.PAY_STRIPE_URL) || undefined) };
    // The practice service is this one: its "page" is ours, and it says what it was told to say.
    if (s?.provider === 'TEST') return { id: 'TEST', provider: null };
    throw new ServiceUnavailableException('This form cannot take payments yet. Please tell the organisation that sent you here.');
  }

  // ── The person filling in the form ───────────────────────────────────────

  /**
   * "Pay and submit". The answers are checked exactly as a submission's are; the amount is what the form's own
   * rules work out here, never what the browser says. Nothing to pay: it is simply submitted.
   */
  async start(orgId: string, code: string, body: SubmitBody, user: OptionalUser, ip?: string) {
    const checked = await this.submissions.submit(orgId, code, body, user, ip, { checkOnly: true });
    const { def, values } = checked as unknown as { def: { name: string; payment?: { enabled: boolean; amountField: string; currency: string; description?: string } }; values: Record<string, unknown> };
    const pay = def.payment;
    if (!pay?.enabled) throw new BadRequestException('This form does not take a payment');
    const amount = Number(values[pay.amountField] ?? 0);
    if (!Number.isFinite(amount) || amount < 0) throw fault(pay.amountField, 'The amount to pay could not be worked out');
    const amountMinor = toMinor(amount, pay.currency);
    // The CAPTCHA was spent on the check above; what follows is the same person.
    if (amountMinor === 0) return { submitted: await this.submissions.submit(orgId, code, body, user, ip, { humanChecked: true }) };

    const { id: providerId, provider } = await this.providerOf(orgId);
    const id = newId();
    const returnUrl = `${formAppUrl()}/pay/${id}?org=${encodeURIComponent(orgId)}`;
    const row = await this.payments.create({ id, orgId, formCode: code, amountMinor, currency: pay.currency, provider: providerId, status: 'PENDING', held: body as Record<string, unknown>, userId: user?.uuid ?? '', purgeAt: new Date(Date.now() + 48 * 3600_000) });
    let url = `${formAppUrl()}/pay/${id}/practice?org=${encodeURIComponent(orgId)}`;
    if (provider) {
      try {
        const made = await provider.create({ amountMinor, currency: pay.currency, description: pay.description?.trim() || def.name, reference: id, returnUrl });
        row.providerRef = made.providerRef;
        url = made.url;
        await row.save();
      } catch (e) {
        await this.payments.deleteOne({ orgId, id });
        this.logger.warn(`payment for ${orgId}/${code} could not start: ${(e as Error).message}`);
        orgLog.error(orgId, 'submissions', `A payment could not be started: ${(e as Error).message}`, { form: code });
        throw new ServiceUnavailableException('The payment page could not be opened. Try again in a moment.');
      }
    }
    orgLog.info(orgId, 'submissions', 'Payment asked for', { form: code, payment: id, amount: fromMinor(amountMinor, pay.currency), currency: pay.currency, through: PROVIDERS[providerId] });
    return { payment: { id, url, amount: fromMinor(amountMinor, pay.currency), currency: pay.currency } };
  }

  private async mine(orgId: string, id: string, user: OptionalUser) {
    const row = UUID.test(id) ? await this.payments.findOne({ id, orgId }) : null;
    if (!row) throw new NotFoundException('No such payment');
    if (row.userId && row.userId !== user?.uuid) throw new ForbiddenException('Sign in as the person who filled in the form');
    return row;
  }

  /** What the page shows while the person decides, before they are sent to pay (the practice page uses it). */
  async look(orgId: string, id: string, user: OptionalUser) {
    const row = await this.mine(orgId, id, user);
    return { id: row.id, status: row.status, amount: fromMinor(row.amountMinor, row.currency), currency: row.currency, formCode: row.formCode, practice: row.provider === 'TEST', ref: row.ref };
  }

  /** The practice service: the person (or the tester) says how the payment went. Refused for a real service. */
  async practice(orgId: string, id: string, outcome: unknown, user: OptionalUser) {
    const row = await this.mine(orgId, id, user);
    if (row.provider !== 'TEST') throw new NotFoundException('No such payment');
    if (outcome !== 'PAID' && outcome !== 'FAILED') throw new BadRequestException('Choose how the payment went');
    if (row.status === 'PENDING') await this.payments.updateOne({ orgId, id }, { $set: { testOutcome: outcome } });
    return this.confirm(orgId, id, user);
  }

  /**
   * Back from the payment page. The service is asked whether the money arrived, and how much; only then do the
   * held answers become a response. Asked twice, it answers the same: one payment, one response.
   */
  async confirm(orgId: string, id: string, user: OptionalUser, ip?: string) {
    const row = await this.mine(orgId, id, user);
    if (row.status === 'SUBMITTED') return { status: 'SUBMITTED' as const, ref: row.ref, submissionId: row.submissionId, formCode: row.formCode };
    if (row.status === 'FAILED') return { status: 'FAILED' as const, formCode: row.formCode };

    if (row.status === 'PENDING') {
      let state: { paid: boolean; failed?: boolean; amountMinor: number; currency: string };
      if (row.provider === 'TEST') state = { paid: row.testOutcome === 'PAID', failed: row.testOutcome === 'FAILED', amountMinor: row.amountMinor, currency: row.currency };
      else {
        const { provider } = await this.providerOf(orgId);
        try {
          state = await provider!.status(row.providerRef);
        } catch (e) {
          this.logger.warn(`payment ${id} could not be checked: ${(e as Error).message}`);
          throw new ServiceUnavailableException('We could not check the payment just now. Try again in a moment.');
        }
      }
      if (state.failed) {
        await this.payments.updateOne({ orgId, id, status: 'PENDING' }, { $set: { status: 'FAILED', held: null } });
        orgLog.warn(orgId, 'submissions', 'A payment did not go through', { form: row.formCode, payment: id });
        return { status: 'FAILED' as const, formCode: row.formCode };
      }
      if (!state.paid) return { status: 'PENDING' as const, formCode: row.formCode };
      if (state.amountMinor !== row.amountMinor || state.currency !== row.currency) {
        orgLog.error(orgId, 'submissions', 'A payment arrived for a different amount than was asked for; the response was not registered', { form: row.formCode, payment: id, asked: row.amountMinor, paid: state.amountMinor });
        throw new HttpException('The amount paid is not the amount due. Please contact the organisation, quoting your payment.', 409);
      }
      // Only one caller moves it on; a second finds it already paid and goes on to the same response.
      await this.payments.updateOne({ orgId, id, status: 'PENDING' }, { $set: { status: 'PAID', paidAt: new Date(), purgeAt: null } });
    }

    const paid = (await this.payments.findOne({ orgId, id }).lean())!;
    try {
      const result = await this.submissions.submit(orgId, row.formCode, { ...(paid.held ?? {}), idempotencyKey: id }, user, ip, {
        humanChecked: true,
        payment: { id, provider: paid.provider, reference: paid.providerRef, amountMinor: paid.amountMinor, currency: paid.currency, paidAt: paid.paidAt ?? new Date() },
      });
      const data = (result ?? {}) as { submissionId?: string; ref?: string };
      await this.payments.updateOne({ orgId, id }, { $set: { status: 'SUBMITTED', submissionId: data.submissionId ?? '', ref: data.ref ?? '', held: null } });
      orgLog.info(orgId, 'submissions', 'Payment received', { form: row.formCode, payment: id, ref: data.ref ?? '', amount: fromMinor(paid.amountMinor, paid.currency), currency: paid.currency });
      return { status: 'SUBMITTED' as const, ref: data.ref ?? '', submissionId: data.submissionId ?? '', formCode: row.formCode };
    } catch (e) {
      // The money is in and the response is not: the organisation must know, and the answers are kept for it.
      this.logger.error(`payment ${id} paid but not registered: ${(e as Error).message}`);
      orgLog.error(orgId, 'submissions', `A payment was received but the response could not be registered: ${(e as Error).message}`, { form: row.formCode, payment: id });
      return { status: 'PAID' as const, formCode: row.formCode, payment: id };
    }
  }
}
