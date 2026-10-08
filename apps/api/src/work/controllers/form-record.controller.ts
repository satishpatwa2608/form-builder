import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, UseFilters } from '@nestjs/common';
import { RequirePermission } from '../../auth/auth.guard';
import apiResponse from '../response';
import { FormFieldErrorsFilter } from '../security/form-http';
import { FormCalendarService } from '../services/form-calendar.service';
import { FormWebhookService } from '../services/form-webhook.service';
import { WorkPortalService } from '../services/work-portal.service';
import { FormRecordService, type InboxQuery } from '../services/form-record.service';
import { FormHandlerRegistry } from '../services/form-workflow.registry';
import { FormAutomationService } from '../services/form-automation.service';
import { FormSubmissionService } from '../services/form-submission.service';
import { FormDefinitionService } from '../services/form-definition.service';

/** The records inbox: submissions being worked on through the form's workflow. */
/** Sign-in and org membership come from the global AuthGuard; each route names the permission it needs. */
@Controller()
@UseFilters(FormFieldErrorsFilter)
export class FormRecordController {
  constructor(
    private readonly records: FormRecordService,
    private readonly workflows: FormHandlerRegistry,
    private readonly automations: FormAutomationService,
    private readonly submissions: FormSubmissionService,
    private readonly calendars: FormCalendarService,
    private readonly webhooks: FormWebhookService,
    private readonly portal: WorkPortalService,
    private readonly definitions: FormDefinitionService,
  ) {}

  /** The live version of every form that tracks work items (the Inbox's filters and New work item). */
  @Get('work-forms')
  @RequirePermission('record.work')
  async workForms(@Req() req: any) {
    const latest = await this.definitions.latestByCode(req.user.orgId);
    return [...latest.values()].filter((d) => d.status === 'PUBLISHED' && d.workflow?.enabled);
  }

  @Get('work-dashboard')
  @RequirePermission('record.work')
  dashboard(@Query('formCode') formCode: string, @Query('days') days: string, @Req() req: any) {
    return this.portal.dashboard(req.user, { formCode, days });
  }

  @Get('work-views')
  @RequirePermission('record.work')
  views(@Req() req: any) {
    return this.portal.listViews(req.user);
  }

  /** `new` creates. */
  @Put('work-views/:id')
  @RequirePermission('record.work')
  saveView(@Param('id') id: string, @Body() body: { name?: unknown; shared?: unknown; filters?: unknown }, @Req() req: any) {
    return this.portal.saveView(req.user, id, body ?? {});
  }

  @Delete('work-views/:id')
  @RequirePermission('record.work')
  removeView(@Param('id') id: string, @Req() req: any) {
    return this.portal.removeView(req.user, id);
  }

  /** Org-wide Work settings (the Inbox theme): everyone reads, Form admins change. */
  @Get('work-settings')
  @RequirePermission('record.work')
  workSettings(@Req() req: any) {
    return this.portal.getSettings(req.user);
  }

  @Put('work-settings')
  @RequirePermission('org.manage')
  saveWorkSettings(@Body() body: { inboxTheme?: unknown }, @Req() req: any) {
    return this.portal.saveSettings(req.user, body ?? {});
  }

  /** The org's working-time calendar (SLAs counted in working hours). */
  @Get('calendar')
  calendar(@Req() req: any) {
    return this.calendars.read(req.user);
  }

  @Put('calendar')
  @RequirePermission('org.manage')
  saveCalendar(@Body() body: Record<string, unknown>, @Req() req: any) {
    return this.calendars.save(req.user, body ?? {});
  }

  @Get('webhooks')
  @RequirePermission('org.manage')
  listWebhooks(@Req() req: any) {
    return this.webhooks.list(req.user);
  }

  /** `new` creates. */
  @Put('webhooks/:id')
  @RequirePermission('org.manage')
  saveWebhook(@Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: any) {
    return this.webhooks.upsert(req.user, id, body ?? {});
  }

  @Delete('webhooks/:id')
  @RequirePermission('org.manage')
  removeWebhook(@Param('id') id: string, @Req() req: any) {
    return this.webhooks.remove(req.user, id);
  }

  /**
   * Raise a work item from the Work portal ("New work item") or another system
   * with a user token (source API). Same pipeline as a submission; no CAPTCHA.
   */
  @Post('work-items')
  @RequirePermission('record.work')
  createWorkItem(@Body() body: { formCode?: unknown; values?: unknown; idempotencyKey?: unknown; source?: unknown; timeZone?: unknown }, @Req() req: any) {
    const code = typeof body?.formCode === 'string' ? body.formCode : '';
    return this.submissions.submit(
      req.user.orgId,
      code,
      { values: body?.values, idempotencyKey: body?.idempotencyKey, channel: 'APP', timeZone: body?.timeZone },
      req.user,
      req.ip,
      { source: body?.source === 'API' ? 'API' : 'PORTAL', trusted: true },
    );
  }

  /** Custom workflow APIs (@FormWorkflow methods) for the builder's dropdown. */
  @Get('custom-workflows')
  @RequirePermission('form.edit')
  async customWorkflows(@Req() req: any) {
    return apiResponse(true, 200, 'Custom workflows fetched', await this.workflows.listFor(req.user.orgId));
  }

  /** People records can be assigned to (for pickers in the inbox and the builder). */
  @Get('people')
  people(@Query('q') q: string, @Query('formCode') formCode: string, @Req() req: any) {
    return this.records.people(req.user, q, formCode);
  }

  @Get('records')
  @RequirePermission('record.work')
  inbox(@Query() query: InboxQuery, @Req() req: any) {
    return this.records.inbox(req.user, query ?? {});
  }

  @Get('records/:id')
  @RequirePermission('record.work')
  get(@Param('id') id: string, @Req() req: any) {
    return this.records.get(req.user, id);
  }

  /** A short-lived download link for an attachment - only for people who can see the record. */
  @Get('records/:id/files/:uploadId')
  @RequirePermission('record.work')
  async fileLink(@Param('id') id: string, @Param('uploadId') uploadId: string, @Req() req: any) {
    await this.records.get(req.user, id); // 404 unless the caller may see this record
    return this.submissions.fileLink(req.user.orgId, id, uploadId);
  }

  @Post('records/:id/status')
  @HttpCode(200)
  @RequirePermission('record.work')
  status(@Param('id') id: string, @Body() body: { to?: unknown; note?: unknown }, @Req() req: any) {
    return this.records.changeStatus(req.user, id, body ?? {});
  }

  @Post('records/:id/assign')
  @HttpCode(200)
  @RequirePermission('record.work')
  assign(@Param('id') id: string, @Body() body: { userId?: unknown }, @Req() req: any) {
    return this.records.changeAssignee(req.user, id, body ?? {});
  }

  /** Approve / reject a flow waiting at an approval step; the flow then carries on. */
  @Post('records/:id/approvals/:runId')
  @HttpCode(200)
  @RequirePermission('record.work')
  async decide(@Param('id') id: string, @Param('runId') runId: string, @Body() body: { decision?: unknown; comment?: unknown }, @Req() req: any) {
    await this.automations.decide(req.user, id, runId, body ?? {});
    return this.records.getAfterChange(req.user, id);
  }

  /** A named move ("Resolve", "Request info"): checks required work fields and comment. */
  @Post('records/:id/actions/:key')
  @HttpCode(200)
  @RequirePermission('record.work')
  act(@Param('id') id: string, @Param('key') key: string, @Body() body: { comment?: unknown }, @Req() req: any) {
    return this.records.act(req.user, id, key, body ?? {});
  }

  /** Reopen a closed item (within the form's window); a comment is required. */
  @Post('records/:id/reopen')
  @HttpCode(200)
  @RequirePermission('record.work')
  reopen(@Param('id') id: string, @Body() body: { comment?: unknown }, @Req() req: any) {
    return this.records.reopen(req.user, id, body ?? {});
  }

  /** Email the requester (outbound only); `requestInfo` also moves it to the form's waiting status. */
  @Post('records/:id/email')
  @HttpCode(200)
  @RequirePermission('record.work')
  email(@Param('id') id: string, @Body() body: { subject?: unknown; body?: unknown; templateKey?: unknown; requestInfo?: unknown }, @Req() req: any) {
    return this.records.sendEmail(req.user, id, body ?? {});
  }

  @Put('records/:id/work')
  @RequirePermission('record.work')
  updateWork(@Param('id') id: string, @Body() body: { values?: unknown }, @Req() req: any) {
    return this.records.updateWork(req.user, id, body ?? {});
  }

  @Post('records/:id/priority')
  @HttpCode(200)
  @RequirePermission('record.work')
  setPriority(@Param('id') id: string, @Body() body: { priority?: unknown }, @Req() req: any) {
    return this.records.setPriority(req.user, id, body ?? {});
  }

  @Post('records/:id/comments')
  @HttpCode(200)
  @RequirePermission('record.work')
  comment(@Param('id') id: string, @Body() body: { message?: unknown }, @Req() req: any) {
    return this.records.comment(req.user, id, body ?? {});
  }
}
