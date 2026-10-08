import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { FormDefinition } from '@fb/engine';
import { FormFieldErrors } from '../security/form-http';
import { MOCK_CAPTCHA_PREFIX } from '../constants';

const VERIFY_URL = {
  RECAPTCHA: 'https://www.google.com/recaptcha/api/siteverify',
  TURNSTILE: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
} as const;

const SECRET_ENV = { RECAPTCHA: 'FORM_RECAPTCHA_SECRET', TURNSTILE: 'FORM_TURNSTILE_SECRET' } as const;

/**
 * Server-side CAPTCHA verification with the provider's secret key (which
 * never reaches the browser). Fails closed: a form that asks for CAPTCHA and
 * can't be verified is rejected, never waved through.
 *
 * Env: FORM_RECAPTCHA_SECRET, FORM_TURNSTILE_SECRET, FORM_RECAPTCHA_MIN_SCORE
 * (v3, default 0.5), FORM_ALLOW_MOCK_CAPTCHA=true (development only: accepts
 * the builder's `mock-captcha-*` test tokens on forms without a site key).
 */
@Injectable()
export class CaptchaVerifierService {
  private readonly logger = new Logger(CaptchaVerifierService.name);

  async verify(def: FormDefinition, token: unknown, remoteIp?: string): Promise<void> {
    const field = def.fields.find((f) => f.type === 'CAPTCHA');
    const config = def.captcha;
    if (!field || !config?.enabled) return;

    if (typeof token !== 'string' || !token || token.length > 4096) {
      throw new FormFieldErrors(422, 'Please complete the verification', [{ field: field.name, message: 'Please complete the verification' }]);
    }

    if (!config.siteKey) {
      if (process.env.FORM_ALLOW_MOCK_CAPTCHA === 'true' && token.startsWith(MOCK_CAPTCHA_PREFIX)) return;
      throw new ServiceUnavailableException('Verification is not configured for this form');
    }
    if (token.startsWith(MOCK_CAPTCHA_PREFIX)) throw new BadRequestException('Verification failed');

    const secret = process.env[SECRET_ENV[config.provider]];
    if (!secret) {
      this.logger.error(`${SECRET_ENV[config.provider]} is not set - rejecting ${def.code} submission`);
      throw new ServiceUnavailableException('Verification is temporarily unavailable');
    }

    const body = new URLSearchParams({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) });
    let result: { success?: boolean; score?: number; action?: string; 'error-codes'?: string[] };
    try {
      const res = await fetch(VERIFY_URL[config.provider], { method: 'POST', body, signal: AbortSignal.timeout(5000) });
      result = (await res.json()) as typeof result;
    } catch (e) {
      this.logger.error(`CAPTCHA verify call failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException('Verification is temporarily unavailable');
    }

    const minScore = Number(process.env.FORM_RECAPTCHA_MIN_SCORE ?? 0.5);
    const scoreOk = config.mode !== 'V3' || ((result.score ?? 0) >= minScore && (!result.action || result.action === 'submit'));
    if (!result.success || !scoreOk) {
      this.logger.warn(`CAPTCHA rejected for ${def.code}: ${JSON.stringify(result['error-codes'] ?? [])} score=${result.score}`);
      throw new FormFieldErrors(422, 'Verification failed', [{ field: field.name, message: 'Verification failed - please try again' }]);
    }
  }
}
