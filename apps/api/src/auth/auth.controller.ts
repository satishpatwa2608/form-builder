import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config';
import { Meta, type RequestMeta } from '../common/request-meta';
import { ZodBody } from '../common/zod-body';
import { Auth, type AuthContext } from './auth-context';
import { AllowWithoutMfa, Public } from './auth.guard';
import { AuthService, type SignedIn } from './auth.service';

export const REFRESH_COOKIE = 'fb_rt';

/** Length is what matters (NIST 800-63B); no composition rules. */
export const password = z.string().min(10, 'Use at least 10 characters').max(200);
const email = z.string().trim().email().max(254);
const name = z.string().trim().min(1).max(100);

const signupBody = z.object({ name, email, password, orgName: name });
const loginBody = z.object({ email, password: z.string().max(200), code: z.string().max(20).optional(), orgId: z.string().max(64).optional() });
const tokenBody = z.object({ token: z.string().min(10).max(200) });
const emailBody = z.object({ email });
const resetBody = z.object({ token: z.string().min(10).max(200), password });
const codeBody = z.object({ code: z.string().max(20) });
const disableBody = z.object({ password: z.string().max(200), code: z.string().max(20) });
const changeBody = z.object({ currentPassword: z.string().max(200), newPassword: password });
const switchBody = z.object({ orgId: z.string().min(1).max(64) });

/** Sign-in routes get a tighter limit than the global one. */
const STRICT = { default: { limit: 10, ttl: 60_000 } };
/** Every page load and tab renews its session; the 256-bit token is the protection, so a looser limit. */
const RENEW = { default: { limit: 60, ttl: 60_000 } };
const ACCEPTED = { message: "If that address can be used, we've sent an email" };

/** The refresh token cookie (also set by the SSO callback). */
export function setRefreshCookie(res: Response, config: AppConfig, signed: SignedIn) {
  res.cookie(REFRESH_COOKIE, signed.refreshToken, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/auth',
    maxAge: 30 * 24 * 3600_000,
  });
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private setCookie(res: Response, signed: SignedIn) {
    setRefreshCookie(res, this.config, signed);
    return { accessToken: signed.accessToken, expiresIn: signed.expiresIn };
  }

  @Public()
  @Throttle(STRICT)
  @Post('signup')
  @HttpCode(202)
  async signup(@Body(new ZodBody(signupBody)) body: z.infer<typeof signupBody>, @Meta() meta: RequestMeta) {
    await this.auth.signup(body, meta);
    return ACCEPTED;
  }

  @Public()
  @Throttle(STRICT)
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body(new ZodBody(tokenBody)) body: z.infer<typeof tokenBody>, @Meta() meta: RequestMeta) {
    await this.auth.verifyEmail(body.token, meta);
    return { message: 'Email confirmed. You can sign in now.' };
  }

  @Public()
  @Throttle(STRICT)
  @Post('resend-verification')
  @HttpCode(202)
  async resend(@Body(new ZodBody(emailBody)) body: z.infer<typeof emailBody>) {
    await this.auth.resendVerification(body.email);
    return ACCEPTED;
  }

  @Public()
  @Throttle(STRICT)
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodBody(loginBody)) body: z.infer<typeof loginBody>, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    return this.setCookie(res, await this.auth.login(body, meta));
  }

  @Public()
  @Throttle(RENEW)
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Meta() meta: RequestMeta, @Res({ passthrough: true }) res: Response) {
    return this.setCookie(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], meta));
  }

  @AllowWithoutMfa()
  @Post('logout')
  @HttpCode(200)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(auth);
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return { message: 'Signed out' };
  }

  @Public()
  @Throttle(STRICT)
  @Post('forgot-password')
  @HttpCode(202)
  async forgot(@Body(new ZodBody(emailBody)) body: z.infer<typeof emailBody>) {
    await this.auth.forgotPassword(body.email);
    return ACCEPTED;
  }

  @Public()
  @Throttle(STRICT)
  @Post('reset-password')
  @HttpCode(200)
  async reset(@Body(new ZodBody(resetBody)) body: z.infer<typeof resetBody>, @Meta() meta: RequestMeta) {
    await this.auth.resetPassword(body, meta);
    return { message: 'Password changed. Sign in with the new one.' };
  }

  @AllowWithoutMfa()
  @Get('me')
  me(@Auth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @Post('switch-org')
  @HttpCode(200)
  switchOrg(@Auth() auth: AuthContext, @Body(new ZodBody(switchBody)) body: z.infer<typeof switchBody>) {
    return this.auth.switchOrg(auth, body.orgId);
  }

  @Post('password')
  @HttpCode(200)
  async changePassword(@Auth() auth: AuthContext, @Body(new ZodBody(changeBody)) body: z.infer<typeof changeBody>) {
    await this.auth.changePassword(auth, body);
    return { message: 'Password changed. Other devices were signed out.' };
  }

  @AllowWithoutMfa()
  @Post('2fa/setup')
  @HttpCode(200)
  startTwoFactor(@Auth() auth: AuthContext) {
    return this.auth.startTwoFactor(auth);
  }

  @AllowWithoutMfa()
  @Throttle(STRICT)
  @Post('2fa/enable')
  @HttpCode(200)
  enableTwoFactor(@Auth() auth: AuthContext, @Body(new ZodBody(codeBody)) body: z.infer<typeof codeBody>) {
    return this.auth.enableTwoFactor(auth, body.code);
  }

  @Throttle(STRICT)
  @Post('2fa/disable')
  @HttpCode(200)
  async disableTwoFactor(@Auth() auth: AuthContext, @Body(new ZodBody(disableBody)) body: z.infer<typeof disableBody>) {
    await this.auth.disableTwoFactor(auth, body);
    return { message: 'Two-factor sign-in is off' };
  }
}
