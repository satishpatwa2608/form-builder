import { Body, Controller, Get, Headers, HttpCode, Ip, Param, Post, Put, Query, UseFilters, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { Public, RequirePermission } from '../auth/auth.guard';
import { ZodBody } from '../common/zod-body';
import { isPlainObject } from '../forms/payload-guard';
import { PlansService } from '../plans/plans.service';
import { SmsService } from '../verify/sms.service';
import { VerifyService } from '../verify/verify.service';
import { THROTTLE } from '../work/constants';
import { FormThrottlerGuard } from '../work/controllers/form-throttler.guard';
import { FormFieldErrorsFilter } from '../work/security/form-http';
import { FormContextService } from '../work/services/form-context.service';
import type { SubmitBody } from '../work/services/form-submission.service';
import { PaymentsService } from './payments.service';

const paymentsBody = z.object({ provider: z.enum(['NONE', 'TEST', 'RAZORPAY', 'STRIPE']).optional(), keyId: z.string().max(200).optional(), secret: z.string().max(500).optional() });
const smsBody = z.object({
  url: z.string().max(1000).optional(),
  method: z.enum(['POST', 'GET']).optional(),
  format: z.enum(['JSON', 'FORM']).optional(),
  body: z.string().max(4000).optional(),
  headers: z.array(z.object({ name: z.string().max(60), value: z.string().max(2000).optional() })).max(3).optional(),
});
const smsTestBody = z.object({ to: z.string().min(1).max(30) });

/** The organisation's payment service and SMS service: set once, used by every form that asks for them. */
@Controller('org')
export class CheckoutSettingsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly sms: SmsService,
  ) {}

  @Get('payments')
  @RequirePermission('org.manage')
  paymentSettings(@Auth() auth: AuthContext) {
    return this.payments.settings(auth);
  }

  @Put('payments')
  @RequirePermission('org.manage')
  updatePayments(@Auth() auth: AuthContext, @Body(new ZodBody(paymentsBody)) body: z.infer<typeof paymentsBody>) {
    return this.payments.update(auth, body);
  }

  @Get('sms')
  @RequirePermission('org.manage')
  smsSettings(@Auth() auth: AuthContext) {
    return this.sms.settings(auth);
  }

  @Put('sms')
  @RequirePermission('org.manage')
  updateSms(@Auth() auth: AuthContext, @Body(new ZodBody(smsBody)) body: z.infer<typeof smsBody>) {
    return this.sms.update(auth, body);
  }

  /** Each test calls an address of the admin's choosing: a few a minute is plenty. */
  @Post('sms/test')
  @HttpCode(200)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @RequirePermission('org.manage')
  testSms(@Auth() auth: AuthContext, @Body(new ZodBody(smsTestBody)) body: z.infer<typeof smsTestBody>) {
    return this.sms.test(auth, body.to);
  }
}

/** What the public form page uses to confirm an address with a code and to pay. No session is needed for a public form. */
@Public()
@Controller('public')
@UseGuards(FormThrottlerGuard)
@UseFilters(FormFieldErrorsFilter)
export class CheckoutPublicController {
  constructor(
    private readonly context: FormContextService,
    private readonly verify: VerifyService,
    private readonly payments: PaymentsService,
    private readonly plans: PlansService,
  ) {}

  @Post('forms/:code/codes')
  @HttpCode(202)
  @Throttle({ default: THROTTLE.submit })
  async sendCode(@Query('org') org: string, @Param('code') code: string, @Body() body: { field?: unknown; value?: unknown }) {
    return this.verify.send(await this.context.resolveOrgId(org), code, isPlainObject(body) ? body : {});
  }

  @Post('forms/:code/codes/check')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.upload })
  async checkCode(@Query('org') org: string, @Param('code') code: string, @Body() body: { field?: unknown; value?: unknown; code?: unknown }) {
    return this.verify.check(await this.context.resolveOrgId(org), code, isPlainObject(body) ? body : {});
  }

  /** "Pay and submit": checks the answers, then gives the page to pay on (or, with nothing to pay, submits). */
  @Post('forms/:code/payments')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  async pay(@Query('org') org: string, @Param('code') code: string, @Body() body: SubmitBody, @Ip() ip: string, @Headers('authorization') auth?: string) {
    const orgId = await this.context.resolveOrgId(org);
    const user = await this.context.optionalUser(auth);
    const result = await this.payments.start(orgId, code, isPlainObject(body) ? body : {}, user, ip);
    if ('submitted' in result) await this.plans.recordSubmission(orgId, code);
    return result;
  }

  @Get('payments/:id')
  @Throttle({ default: THROTTLE.read })
  async look(@Query('org') org: string, @Param('id') id: string, @Headers('authorization') auth?: string) {
    return this.payments.look(await this.context.resolveOrgId(org), id, await this.context.optionalUser(auth));
  }

  @Post('payments/:id/confirm')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.upload })
  async confirm(@Query('org') org: string, @Param('id') id: string, @Ip() ip: string, @Headers('authorization') auth?: string) {
    const orgId = await this.context.resolveOrgId(org);
    const result = await this.payments.confirm(orgId, id, await this.context.optionalUser(auth), ip);
    return result;
  }

  @Post('payments/:id/practice')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  async practice(@Query('org') org: string, @Param('id') id: string, @Body() body: { outcome?: unknown }, @Headers('authorization') auth?: string) {
    return this.payments.practice(await this.context.resolveOrgId(org), id, body?.outcome, await this.context.optionalUser(auth));
  }
}
