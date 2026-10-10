import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Auth, type AuthContext } from '../auth/auth-context';
import { idParam } from '../common/id-param';
import { ZodBody } from '../common/zod-body';
import { FormSubmissionService } from '../work/services/form-submission.service';
import { FormDefinitionService } from '../work/services/form-definition.service';
import { FILL_LINK_MAX_DAYS, OpenWithService } from '../work/services/open-with.service';
import { PlansService } from '../plans/plans.service';
import { FormsService } from './forms.service';

const id = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
/** The definition itself is validated by the engine (and the security guard) in the service. */
const createBody = z.object({ folderId: id, definition: z.record(z.string(), z.unknown()) });
const moveBody = z.object({ folderId: id });
const importBody = z.object({ folderId: id, package: z.record(z.string(), z.unknown()), code: z.string().regex(/^[A-Z0-9_]{1,100}$/).optional() });
const listQuery = z.object({ folderId: id.optional() });
const fillLinkBody = z.object({ value: z.string().trim().min(1).max(200), days: z.number().int().min(1).max(FILL_LINK_MAX_DAYS).optional() });

/** Permissions are checked per form (its folder) in FormsService, not per route. */
@Controller('forms')
export class FormsController {
  constructor(
    private readonly forms: FormsService,
    private readonly submissions: FormSubmissionService,
    private readonly plans: PlansService,
    private readonly openWith: OpenWithService,
    private readonly definitions: FormDefinitionService,
  ) {}

  @Get()
  list(@Auth() auth: AuthContext, @Query(new ZodBody(listQuery)) query: z.infer<typeof listQuery>) {
    return this.forms.list(auth, query.folderId);
  }

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodBody(createBody)) body: z.infer<typeof createBody>) {
    return this.forms.create(auth, body);
  }

  /** Copy a form in from a package (another org or environment). Static route before :id. */
  @Post('import')
  import(@Auth() auth: AuthContext, @Body(new ZodBody(importBody)) body: z.infer<typeof importBody>) {
    return this.forms.importPackage(auth, body);
  }

  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id') formId: string) {
    return this.forms.get(auth, idParam(formId));
  }

  /** Submissions of a form (any version), newest first. */
  @Get(':id/submissions')
  async submissionsOf(@Auth() auth: AuthContext, @Param('id') formId: string, @Query('page') page?: string, @Query('limit') limit?: string) {
    const code = await this.forms.assertCanReadSubmissions(auth, idParam(formId));
    return this.submissions.list(auth.orgId, code, Number(page) || 1, Number(limit) || 20);
  }

  @Get(':id/submissions/:submissionId/files/:uploadId')
  async submissionFile(@Auth() auth: AuthContext, @Param('id') formId: string, @Param('submissionId') sid: string, @Param('uploadId') uploadId: string) {
    const code = await this.forms.assertCanReadSubmissions(auth, idParam(formId));
    return this.submissions.fileLink(auth.orgId, idParam(sid), idParam(uploadId), code);
  }

  @Get(':id/export')
  exportPackage(@Auth() auth: AuthContext, @Param('id') formId: string) {
    return this.forms.exportPackage(auth, idParam(formId));
  }

  /** Views, starts and submissions per day (counts only). */
  @Get(':id/stats')
  async stats(@Auth() auth: AuthContext, @Param('id') formId: string, @Query('days') days?: string) {
    const code = await this.forms.codeFor(auth, idParam(formId));
    return this.plans.formStats(auth.orgId, code, Math.min(90, Math.max(1, Number(days) || 30)));
  }

  /** Per question: how many answered it, made a mistake on it, or left the form at it (counts only). */
  @Get(':id/field-stats')
  async fieldStats(@Auth() auth: AuthContext, @Param('id') formId: string, @Query('days') days?: string) {
    const { code, fields } = await this.forms.liveFieldsFor(auth, idParam(formId));
    return this.plans.fieldReport(auth.orgId, code, Math.min(90, Math.max(1, Number(days) || 30)), fields);
  }

  @Get(':id/versions')
  versions(@Auth() auth: AuthContext, @Param('id') formId: string) {
    return this.forms.versions(auth, idParam(formId));
  }

  @Put(':id')
  update(@Auth() auth: AuthContext, @Param('id') formId: string, @Body() body: unknown) {
    return this.forms.update(auth, idParam(formId), body);
  }

  /**
   * A link that opens the form filled from one record (the form's "Opens with a record" setting, found by a link).
   * For people who may read the form's responses: what the link shows is that record's mapped answers.
   */
  @Post(':id/fill-links')
  @HttpCode(200)
  async fillLink(@Auth() auth: AuthContext, @Param('id') formId: string, @Body(new ZodBody(fillLinkBody)) body: z.infer<typeof fillLinkBody>) {
    const code = await this.forms.assertCanReadSubmissions(auth, idParam(formId));
    const def = await this.definitions.findPublished(auth.orgId, code);
    if (!def?.openWith || def.openWith.by !== 'LINK') throw new BadRequestException('The published form does not open from a link made for a record. Set that under "Opens with a record" and publish it.');
    const { token, expiresAt } = this.openWith.link(def, body.value, body.days ?? 30);
    return { token, expiresAt, code: def.code };
  }

  @Post(':id/publish')
  @HttpCode(200)
  publish(@Auth() auth: AuthContext, @Param('id') formId: string) {
    return this.forms.publish(auth, idParam(formId));
  }

  /** Publish this draft by itself at `publishAt`. */
  @Post(':id/schedule')
  @HttpCode(200)
  schedule(@Auth() auth: AuthContext, @Param('id') formId: string, @Body() body: { publishAt?: unknown }) {
    return this.forms.schedule(auth, idParam(formId), body?.publishAt);
  }

  @Delete(':id/schedule')
  unschedule(@Auth() auth: AuthContext, @Param('id') formId: string) {
    return this.forms.unschedule(auth, idParam(formId));
  }

  @Post(':id/new-version')
  @HttpCode(200)
  newVersion(@Auth() auth: AuthContext, @Param('id') formId: string) {
    return this.forms.newVersion(auth, idParam(formId));
  }

  /** Bring this earlier version back as the draft (`replaceDraft` to overwrite one that is open). */
  @Post(':id/restore')
  @HttpCode(200)
  restore(@Auth() auth: AuthContext, @Param('id') formId: string, @Body() body: { replaceDraft?: unknown }) {
    return this.forms.restore(auth, idParam(formId), body?.replaceDraft === true);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Auth() auth: AuthContext, @Param('id') formId: string) {
    return this.forms.archive(auth, idParam(formId));
  }

  @Patch(':id/folder')
  move(@Auth() auth: AuthContext, @Param('id') formId: string, @Body(new ZodBody(moveBody)) body: z.infer<typeof moveBody>) {
    return this.forms.move(auth, idParam(formId), body.folderId);
  }

  @Delete(':id')
  remove(@Auth() auth: AuthContext, @Param('id') formId: string) {
    return this.forms.remove(auth, idParam(formId));
  }
}
