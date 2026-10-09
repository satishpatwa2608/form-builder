import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ORG_ROLES } from '../access/roles';
import { Auth, type AuthContext } from '../auth/auth-context';
import { setRefreshCookie } from '../auth/auth.controller';
import { Public, RequirePermission } from '../auth/auth.guard';
import { APP_CONFIG, type AppConfig } from '../config';
import { Meta, type RequestMeta } from '../common/request-meta';
import { ZodBody } from '../common/zod-body';
import { SsoError, SsoService } from './sso.service';

const settingsBody = z.object({
  enabled: z.boolean().optional(),
  protocol: z.enum(['OIDC', 'SAML']).optional(),
  saml: z.object({ entryPoint: z.string().max(1000).optional(), idpIssuer: z.string().max(1000).optional(), cert: z.string().max(12_000).optional() }).optional(),
  issuer: z.string().max(300).optional(),
  clientId: z.string().max(300).optional(),
  clientSecret: z.string().max(1000).optional(),
  domains: z.array(z.string().max(253)).max(20).optional(),
  autoProvision: z.boolean().optional(),
  defaultRole: z.enum(ORG_ROLES).optional(),
  enforce: z.boolean().optional(),
});
const startQuery = z.object({ email: z.string().trim().email().max(254) });
const callbackQuery = z.object({ code: z.string().max(4000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() });
const STRICT = { default: { limit: 10, ttl: 60_000 } };
const SSO_COOKIE = 'fb_sso';

@Controller()
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('org/sso')
  @RequirePermission('org.manage')
  settings(@Auth() auth: AuthContext) {
    return this.sso.settings(auth);
  }

  @Post('org/sso/domains/:domain/verify')
  @HttpCode(200)
  @RequirePermission('org.manage')
  verifyDomain(@Auth() auth: AuthContext, @Param('domain', new ZodBody(z.string().regex(/^[a-z0-9.-]{3,253}$/))) domain: string) {
    return this.sso.verifyDomain(auth, domain);
  }

  @Put('org/sso')
  @RequirePermission('org.manage')
  update(@Auth() auth: AuthContext, @Body(new ZodBody(settingsBody)) body: z.infer<typeof settingsBody>) {
    return this.sso.update(auth, body);
  }

  /**
   * Called by the studio's sign-in page (a POST from a studio origin only, so another site can't start a
   * sign-in in someone's browser and log them in to an account it controls). Returns where to send the browser.
   */
  @Public()
  @Throttle(STRICT)
  @Post('auth/sso/start')
  @HttpCode(200)
  async start(@Body(new ZodBody(startQuery)) body: z.infer<typeof startQuery>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const studio = this.config.CORS_ORIGINS.split(',').map((o) => o.trim());
    if (!studio.includes(String(req.headers.origin ?? ''))) throw new ForbiddenException('Start single sign-on from the Form Builder sign-in page');
    try {
      const { url, browserKey, crossSite } = await this.sso.start(body.email);
      // Lax: it must come back on the provider's top-level redirect to the callback. A SAML provider answers with a
      // form posted from its own site, which only a SameSite=None (and so Secure) cookie comes back with.
      res.cookie(SSO_COOKIE, browserKey, { httpOnly: true, secure: crossSite ? true : this.config.COOKIE_SECURE, sameSite: crossSite ? 'none' : 'lax', path: '/auth/sso', maxAge: 10 * 60_000 });
      return { url };
    } catch (e) {
      if (e instanceof SsoError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** The provider redirects here. On success the refresh cookie is set and the studio finishes signing in. */
  @Public()
  @Throttle(STRICT)
  @Get('auth/sso/callback')
  async callback(@Query(new ZodBody(callbackQuery)) q: z.infer<typeof callbackQuery>, @Meta() meta: RequestMeta, @Req() req: Request, @Res() res: Response) {
    const browserKey = req.cookies?.[SSO_COOKIE] as string | undefined;
    res.clearCookie(SSO_COOKIE, { path: '/auth/sso' });
    try {
      if (q.error || !q.code || !q.state) throw new SsoError('Sign-in was cancelled or refused by your identity provider');
      const signed = await this.sso.callback(q.code, q.state, browserKey, meta);
      setRefreshCookie(res, this.config, signed);
      res.redirect(302, `${this.config.APP_URL}/sso/complete`);
    } catch (e) {
      this.fail(res, e);
    }
  }

  /** What an organisation's SAML provider needs to know about us, in the form providers import. */
  @Public()
  @Throttle(STRICT)
  @Get('auth/sso/saml/:org/metadata')
  async samlMetadata(@Param('org') org: string, @Res() res: Response) {
    res.status(200).type('application/samlmetadata+xml').send(await this.sso.samlMetadata(org));
  }

  /** A SAML provider posts its answer here, through the person's browser. */
  @Public()
  @Throttle(STRICT)
  @Post('auth/sso/saml/:org/acs')
  async samlAcs(@Param('org') org: string, @Body() body: Record<string, unknown>, @Meta() meta: RequestMeta, @Req() req: Request, @Res() res: Response) {
    const browserKey = req.cookies?.[SSO_COOKIE] as string | undefined;
    res.clearCookie(SSO_COOKIE, { path: '/auth/sso', secure: true, sameSite: 'none' });
    try {
      const response = typeof body?.SAMLResponse === 'string' ? body.SAMLResponse : '';
      const relay = typeof body?.RelayState === 'string' ? body.RelayState.slice(0, 200) : '';
      if (!response || response.length > 400_000 || !/^[A-Za-z0-9-]{1,64}$/.test(org)) throw new SsoError('Sign-in was cancelled or refused by your identity provider');
      const signed = await this.sso.samlCallback(org, response, relay, browserKey, meta);
      setRefreshCookie(res, this.config, signed);
      res.redirect(302, `${this.config.APP_URL}/sso/complete`);
    } catch (e) {
      this.fail(res, e);
    }
  }

  private fail(res: Response, e: unknown) {
    const message = e instanceof SsoError || (e as { status?: number })?.status === 400 || (e as { status?: number })?.status === 402 ? (e as Error).message : 'Single sign-on failed. Please try again.';
    res.redirect(302, `${this.config.APP_URL}/login?sso_error=${encodeURIComponent(message)}`);
  }
}
