import { Controller, Get, NotFoundException, Param, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CUSTOM_FIELD_KEY } from '@fb/engine';
import { Public } from '../auth/auth.guard';
import { THROTTLE } from '../work/constants';
import { FormThrottlerGuard } from '../work/controllers/form-throttler.guard';
import { FormContextService } from '../work/services/form-context.service';
import { ExtensionsService } from './extensions.service';

/**
 * What the page of a custom field may do, said to the browser itself. The
 * page is a customer's code shown inside a form, so it is given nothing: its
 * own inline script and styles, and no more.
 *   sandbox allow-scripts   an origin of its own that matches nothing: no cookies, no storage, no reading the form
 *   default-src 'none'      no requests of any kind, so nothing typed into it can be sent anywhere
 */
export const FIELD_PAGE_POLICY = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  // Forms are embedded on customers' own sites, so the field may be framed from anywhere; it holds nothing worth framing.
  'frame-ancestors *',
].join('; ');

/** The pages of custom fields, served from the copy taken when the extension was last read. */
@Public()
@Controller('public/extensions')
@UseGuards(FormThrottlerGuard)
export class ExtensionPublicController {
  constructor(
    private readonly context: FormContextService,
    private readonly extensions: ExtensionsService,
  ) {}

  @Get(':org/fields/:key')
  @Throttle({ default: THROTTLE.read })
  async fieldPage(@Param('org') org: string, @Param('key') key: string, @Res() res: Response) {
    const orgId = await this.context.resolveOrgId(org);
    const html = CUSTOM_FIELD_KEY.test(key) ? await this.extensions.fieldPage(orgId, key) : null;
    if (!html) throw new NotFoundException('Field not found');
    // The API's usual headers forbid framing and cross-origin use; this one page exists to be framed by the form.
    res.removeHeader('X-Frame-Options');
    res
      .status(200)
      .set({
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': FIELD_PAGE_POLICY,
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'public, max-age=60',
      })
      .send(html);
  }
}
