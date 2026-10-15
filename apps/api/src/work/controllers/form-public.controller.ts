import { orgLog } from '../../logs/org-log';
import { eventSources, formAvailability, publicCopy } from '@fb/engine';
import { Body, Controller, UseFilters, Get, Headers, HttpCode, Ip, NotFoundException, Param, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { FormDefinitionService } from '../services/form-definition.service';
import { Public } from '../../auth/auth.guard';
import { Throttle } from '@nestjs/throttler';
import apiResponse from '../response';
import { THROTTLE } from '../constants';
import { FormFieldErrorsFilter } from '../security/form-http';
import { isPlainObject } from '../../forms/payload-guard';
import { countedFields } from '../../forms/counted-fields';
import { FormContextService } from '../services/form-context.service';
import { DataSourceQueryService } from '../services/data-source-query.service';
import { OpenWithService } from '../services/open-with.service';
import { FormSubmissionService, SubmitBody } from '../services/form-submission.service';
import { FormUploadService } from '../services/form-upload.service';
import { FormThrottlerGuard } from './form-throttler.guard';
import { PlansService } from '../../plans/plans.service';
import { DraftsService } from '../../drafts/drafts.service';
import { PortalService } from '../../portal/portal.service';
import { metrics } from '../../common/metrics';

/**
 * Endpoints the public form page uses. No AuthGuard: anonymous callers are
 * allowed for PUBLIC forms; a bearer token, if sent, is verified and required
 * for sign-in-only forms. `org` is the subdomain (or org uuid) the form was
 * opened under. Every route is rate-limited.
 */
@Public()
@Controller('public')
@UseGuards(FormThrottlerGuard)
@UseFilters(FormFieldErrorsFilter)
export class FormPublicController {
  constructor(
    private readonly context: FormContextService,
    private readonly submissions: FormSubmissionService,
    private readonly uploads: FormUploadService,
    private readonly master: DataSourceQueryService,
    private readonly definitions: FormDefinitionService,
    private readonly plans: PlansService,
    private readonly drafts: DraftsService,
    private readonly portal: PortalService,
    private readonly openWith: OpenWithService,
  ) {}

  // Static routes first.
  @Post('data-sources/query')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.read })
  async queryDataSource(@Query('org') org: string, @Body() body: Record<string, unknown>, @Headers('authorization') auth?: string) {
    const orgId = await this.context.resolveOrgId(org);
    const user = await this.context.optionalUser(auth);
    // A public caller may only read a source that a published form binds, with that field's own parameters.
    const code = typeof body?.formCode === 'string' ? body.formCode : '';
    const def = /^[A-Z0-9_]{1,100}$/.test(code) ? await this.definitions.findPublished(orgId, code) : null;
    const key = typeof body?.key === 'string' ? body.key.split('?')[0] : '';
    // Each binding: a field's option list, or a "look up" event. Every one names the parameters it may send.
    const bindings = !def
      ? []
      : [
          ...[...def.fields, ...(def.workflow?.workFields ?? [])].flatMap((f) =>
            f.dataSource?.type === 'API' && f.dataSource.api ? [{ key: f.dataSource.api.url.split('?')[0], params: Object.keys(f.dataSource.api.params ?? {}) }] : [],
          ),
          ...eventSources(def),
        ].filter((b) => b.key === key);
    if (!def || !bindings.length) throw new NotFoundException('No data source is available here');
    if (def.access === 'AUTHENTICATED' && user?.orgId !== orgId) throw new UnauthorizedException('Sign in to see these options');
    const params = body?.params && typeof body.params === 'object' ? (body.params as Record<string, unknown>) : {};
    if (!bindings.some((b) => Object.keys(params).every((k) => b.params.includes(k)))) throw new NotFoundException('No data source is available here');
    const rows = await this.master.queryDataSource(orgId, key, params, user, `form:${code}`);
    return apiResponse(true, 200, 'Rows fetched', rows);
  }

  @Post('uploads/:uploadId/verify')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.upload })
  async verifyUpload(@Query('org') org: string, @Param('uploadId') uploadId: string) {
    const orgId = await this.context.resolveOrgId(org);
    return apiResponse(true, 200, 'File verified', await this.uploads.verify(orgId, uploadId));
  }

  @Get('forms/:code')
  @Throttle({ default: THROTTLE.read })
  async getForm(@Query('org') org: string, @Param('code') code: string, @Headers('authorization') auth?: string) {
    const orgId = await this.context.resolveOrgId(org);
    const user = await this.context.optionalUser(auth);
    const def = await this.submissions.publishedFor(orgId, code, user, 'show');
    const state = formAvailability(def);
    // Only what draws the form and checks its answers: nothing about what happens to a response afterwards.
    if (state === 'OPEN') return apiResponse(true, 200, 'Form fetched', publicCopy(def));
    // Not taking answers: enough to explain that, and none of the questions.
    return apiResponse(true, 200, 'Form is not open', {
      unavailable: state,
      name: def.name,
      code: def.code,
      orgId: def.orgId,
      theme: def.theme,
      opensAt: def.opensAt,
      closesAt: def.closesAt,
      message: state === 'CLOSED' ? def.closedMessage : undefined,
    });
  }

  /**
   * The answers a form opens with, when it opens filled from a record: read on the server from the record the
   * link (or the signed-in person) stands for. Only the mapped answers are returned, never the record.
   */
  @Get('forms/:code/opens-with')
  @Throttle({ default: THROTTLE.read })
  async opensWith(@Query('org') org: string, @Param('code') code: string, @Query('fill') fill?: string, @Headers('authorization') auth?: string) {
    const orgId = await this.context.resolveOrgId(org);
    const user = await this.context.optionalUser(auth);
    const def = await this.submissions.publishedFor(orgId, code, user, 'show');
    if (formAvailability(def) !== 'OPEN') return apiResponse(true, 200, 'Form is not open', { values: {}, found: false, locked: [] });
    try {
      return apiResponse(true, 200, 'Answers fetched', await this.openWith.answers(def, { fill, user }));
    } catch (e) {
      // A form that opens only from a link says why it cannot. One that can also be filled by hand must not be
      // stopped by the other system being down: it opens empty, and says the record could not be read.
      if (def.openWith?.only) throw e;
      orgLog.warn(orgId, 'connectors', `${def.name}: could not read the record it opens with`, { form: def.code });
      return apiResponse(true, 200, 'The record could not be read', { values: {}, found: false, locked: [], unavailable: true });
    }
  }

  @Post('forms/:code/submissions')
  @Throttle({ default: THROTTLE.submit })
  async submit(
    @Query('org') org: string,
    @Param('code') code: string,
    @Body() body: SubmitBody,
    @Ip() ip: string,
    @Headers('authorization') auth?: string,
  ) {
    const orgId = await this.context.resolveOrgId(org);
    const user = await this.context.optionalUser(auth);
    const reserved = await this.plans.reserveSubmission(orgId);
    try {
      const result = await this.submissions.submit(orgId, code, isPlainObject(body) ? body : {}, user, ip);
      await this.plans.recordSubmission(orgId, code);
      metrics.submissionsAccepted.inc();
      return result;
    } catch (e) {
      await this.plans.releaseSubmission(orgId, reserved);
      // Which questions were at fault, never what was answered.
      const faults = (e as { errors?: { field: string }[] })?.errors;
      const status = (e as { getStatus?: () => number })?.getStatus?.();
      if (Array.isArray(faults)) orgLog.debug(orgId, 'submissions', 'Response sent back with mistakes', { form: code, mistakes: faults.length, fields: [...new Set(faults.map((f) => f.field))].slice(0, 10).join(', ') });
      else if (!status || status >= 500) orgLog.error(orgId, 'submissions', 'A response could not be stored', { form: code });
      else orgLog.debug(orgId, 'submissions', 'Response refused', { form: code, status });
      metrics.submissionsRefused.inc({ why: Array.isArray(faults) ? 'mistakes' : !status || status >= 500 ? 'error' : String(status) });
      throw e;
    }
  }

  /** Analytics from the form page: opened, started, and a visit's per-question summary. Counts only, for published forms. */
  @Post('forms/:code/events')
  @HttpCode(204)
  @Throttle({ default: THROTTLE.read })
  async event(@Query('org') org: string, @Param('code') code: string, @Body() body: Record<string, unknown>) {
    const orgId = await this.context.resolveOrgId(org);
    const type = body?.type;
    if ((type !== 'view' && type !== 'start' && type !== 'fields') || !/^[A-Z0-9_]{1,100}$/.test(code)) return;
    const def = await this.definitions.findPublished(orgId, code);
    if (!def) throw new NotFoundException('Form not found');
    if (type !== 'fields') return this.plans.recordEvent(orgId, code, type, body.loadMs);
    // One visit's summary, sent as the person leaves: which questions they answered, where a mistake showed, where they stopped.
    const names = (v: unknown) => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []);
    await this.plans.recordFields(orgId, code, countedFields(def).map((f) => f.name), { answered: names(body.answered), mistakes: names(body.mistakes), leftAt: typeof body.leftAt === 'string' ? body.leftAt : undefined });
  }

  /** Save and continue later: returns a token the respondent keeps (it's the only way back in). */
  @Post('forms/:code/drafts')
  @Throttle({ default: THROTTLE.submit })
  async saveDraft(@Query('org') org: string, @Param('code') code: string, @Body() body: Record<string, unknown>, @Headers('authorization') auth?: string, @Headers('x-portal-session') portalSession?: string) {
    const orgId = await this.context.resolveOrgId(org);
    const user = await this.context.optionalUser(auth);
    const def = await this.submissions.publishedFor(orgId, code, user);
    const token = typeof body?.token === 'string' ? body.token : undefined;
    if (def.saveForLater === false) throw new NotFoundException('This form cannot be saved for later');
    // Saved by someone signed in to the requests portal: it is theirs there too.
    const email = portalSession ? await this.portal.emailOf(orgId, `Portal ${portalSession}`) : '';
    return this.drafts.save(orgId, def, body?.values, token, user, email);
  }

  /** The token travels in the body, not the path, so it stays out of access logs. */
  @Post('forms/:code/drafts/load')
  @HttpCode(200)
  @Throttle({ default: THROTTLE.submit })
  async loadDraft(@Query('org') org: string, @Param('code') code: string, @Body() body: Record<string, unknown>, @Headers('authorization') auth?: string) {
    const orgId = await this.context.resolveOrgId(org);
    const user = await this.context.optionalUser(auth);
    const def = await this.submissions.publishedFor(orgId, code, user);
    if (def.saveForLater === false) throw new NotFoundException('This form cannot be saved for later');
    return this.drafts.load(orgId, def, typeof body?.token === 'string' ? body.token : '', user);
  }

  @Post('forms/:code/drafts/discard')
  @HttpCode(204)
  @Throttle({ default: THROTTLE.submit })
  async discardDraft(@Query('org') org: string, @Param('code') code: string, @Body() body: Record<string, unknown>) {
    await this.drafts.discard(await this.context.resolveOrgId(org), code, typeof body?.token === 'string' ? body.token : '');
  }

  @Post('forms/:code/uploads')
  @Throttle({ default: THROTTLE.upload })
  async presignUpload(
    @Query('org') org: string,
    @Param('code') code: string,
    @Body() body: Record<string, unknown>,
    @Headers('authorization') auth?: string,
  ) {
    const orgId = await this.context.resolveOrgId(org);
    const user = await this.context.optionalUser(auth);
    const def = await this.submissions.publishedFor(orgId, code, user);
    return apiResponse(true, 201, 'Upload ready', await this.uploads.presign(orgId, def, isPlainObject(body) ? body : {}));
  }
}
