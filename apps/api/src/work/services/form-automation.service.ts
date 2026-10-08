import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { OnEvent } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { newId as uuidv4 } from '../../common/crypto';
import { MailService } from './mail.service';
import type { Automation, AutomationAction, AutomationTrigger, FormDefinition, FormValues, RecipientRef } from '@fb/engine';
import {
  conditionValues,
  escapeHtml,
  evaluateCondition,
  findStatus,
  renderTemplate,
  stepKey,
  valuesFromPayload,
  workflowOf,
  type TemplateContext,
} from '@fb/engine';
import { FORM_RECORD_FIELDS_EVENT, FORM_RECORD_STATUS_EVENT, FORM_SUBMITTED_EVENT, WORKFLOW } from '../constants';
import { FormSubmission, FormSubmissionDocument } from '../schemas/form-submission.schema';
import { FormFlowRun, FormFlowRunDocument } from '../schemas/form-record.schema';
import { FormRecordService, isRecordAdmin, recordPath, type RecordFieldsEvent, type RecordStatusEvent } from './form-record.service';
import { escalationAt } from './sla';
import { FormHandlerRegistry, type FormHandlerContext, type FormHandlerResult } from './form-workflow.registry';
import { postWebhook } from './webhook-client';
import type { FormSubmittedEvent } from './form-submission.service';

type RecordRow = FormSubmission & { createdAt?: Date };
type StepResult = string | { summary: string; data?: Record<string, unknown> };

const STEP_NAME: Record<AutomationAction['type'], string> = {
  EMAIL: 'Email',
  NOTIFY: 'Notification',
  CREATE_TASK: 'Task',
  ASSIGN: 'Assign',
  SET_STATUS: 'Status change',
  WEBHOOK: 'Webhook',
  HANDLER: 'Custom API',
  APPROVAL: 'Approval',
};
const stepName = (a: AutomationAction) => a.label || STEP_NAME[a.type];

/** What's kept of a step's output on the timeline (the full value only lives for the run). */
function boundedOutput(data: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(data);
  return json.length <= 2_000 ? data : { truncated: true, preview: json.slice(0, 2_000) };
}

/** A custom API's return value -> summary + output. */
function fromHandler(key: string, result: FormHandlerResult): StepResult {
  if (!result) return `ran ${key}`;
  if (typeof result === 'string') return result;
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : undefined;
  return { summary: result.summary || `ran ${key}`, data };
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Runs a form's automations: when (submitted / status changed / overdue)
 * -> if (condition on the answers + $status) -> then (actions). Every action
 * outcome is written to the record's timeline; one failing action never
 * stops the others or the submission.
 */
@Injectable()
export class FormAutomationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FormAutomationService.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @InjectModel(FormSubmission.name) private readonly submissions: Model<FormSubmissionDocument>,
    @InjectModel(FormFlowRun.name) private readonly runs: Model<FormFlowRunDocument>,
    private readonly records: FormRecordService,
    private readonly mail: MailService,
    private readonly handlers: FormHandlerRegistry,
  ) {}

  // ---------------------------------------------------------------- triggers

  @OnEvent(FORM_SUBMITTED_EVENT, { async: true })
  async onSubmitted(e: FormSubmittedEvent) {
    try {
      const { record, definition } = await this.records.load(e.orgId, e.submissionId);
      await this.records.log(e.orgId, record.uuid, 'CREATED', record.submittedBy, `Submitted via ${record.channel}`, {
        status: record.status,
        ref: record.ref,
      });
      if (record.assigneeId) {
        await this.records.log(e.orgId, record.uuid, 'ASSIGNED', '', 'Assigned by the form\'s rule', { from: '', to: record.assigneeId });
        this.records.notify(e.orgId, [record.assigneeId], `New ${definition.name}: ${record.ref}`, record.uuid, record.ref, definition.name);
      }
      await this.run('SUBMITTED', e.orgId, record.uuid, 0, record.submittedBy);
    } catch (err) {
      this.logger.error(`automations after submission ${e.submissionId} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent(FORM_RECORD_FIELDS_EVENT, { async: true })
  async onFieldsUpdated(e: RecordFieldsEvent) {
    try {
      await this.run('FIELD_UPDATED', e.orgId, e.recordId, 0, e.by, e.fields);
    } catch (err) {
      this.logger.error(`automations after work field update of ${e.recordId} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent(FORM_RECORD_STATUS_EVENT, { async: true })
  async onStatusChanged(e: RecordStatusEvent) {
    try {
      await this.run('STATUS_CHANGED', e.orgId, e.recordId, e.depth, e.by);
    } catch (err) {
      this.logger.error(`automations after status change of ${e.recordId} failed: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- SLA sweep

  onModuleInit() {
    // On by default; FORM_WORKFLOW_SWEEP=false turns it off (tests call sweep() directly).
    if (process.env.FORM_WORKFLOW_SWEEP === 'false' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.sweep(), WORKFLOW.sweepEveryMs);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Records past their SLA fire SLA_BREACHED once per status. Each record is
   * claimed with a conditional write, so several API instances can sweep
   * the same database without double-firing.
   */
  async sweep(now = new Date()): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let fired = 0;
    try {
      const due = await this.submissions
        .find({ dueAt: { $lte: now }, slaBreachedAt: null, isDeleted: false })
        .limit(WORKFLOW.sweepBatch)
        .select('uuid orgId dueAt status')
        .lean();
      for (const r of due) {
        const claimed = await this.submissions.updateOne(
          { uuid: r.uuid, slaBreachedAt: null, dueAt: r.dueAt, status: r.status },
          { $set: { slaBreachedAt: now } },
        );
        if (!claimed.modifiedCount) continue;
        fired++;
        await this.records.log(r.orgId, r.uuid, 'SLA', '', 'Overdue', { kind: 'STATUS', status: r.status, dueAt: r.dueAt });
        await this.run('SLA_BREACHED', r.orgId, r.uuid, 0, '', [], 'STATUS').catch((err) =>
          this.logger.error(`SLA automations for ${r.uuid} failed: ${(err as Error).message}`),
        );
      }
      fired += await this.sweepResponse(now);
      fired += await this.sweepApproaching(now);
      fired += await this.sweepEscalation(now);
    } finally {
      this.sweeping = false;
    }
    return fired;
  }

  private safeRun(trigger: AutomationTrigger, orgId: string, id: string, sla?: 'RESPONSE' | 'RESOLUTION') {
    return this.run(trigger, orgId, id, 0, '', [], sla).catch((err) => this.logger.error(`${trigger} automations for ${id} failed: ${(err as Error).message}`));
  }

  /** No one acted within the response time. */
  private async sweepResponse(now: Date): Promise<number> {
    let fired = 0;
    const due = await this.submissions
      .find({ responseDueAt: { $lte: now }, respondedAt: null, responseBreachedAt: null, resolvedAt: null, isDeleted: false })
      .limit(WORKFLOW.sweepBatch)
      .select('uuid orgId responseDueAt')
      .lean();
    for (const r of due) {
      const claimed = await this.submissions.updateOne({ uuid: r.uuid, respondedAt: null, responseBreachedAt: null }, { $set: { responseBreachedAt: now } });
      if (!claimed.modifiedCount) continue;
      fired++;
      await this.records.log(r.orgId, r.uuid, 'SLA', '', 'No response in time', { kind: 'RESPONSE', dueAt: r.responseDueAt });
      await this.safeRun('SLA_BREACHED', r.orgId, r.uuid, 'RESPONSE');
    }
    return fired;
  }

  /** Most of the resolution time is used up (warnAtPercent). */
  private async sweepApproaching(now: Date): Promise<number> {
    let fired = 0;
    const due = await this.submissions
      .find({ resolutionWarnAt: { $lte: now }, resolvedAt: null, slaPausedAt: null, isDeleted: false })
      .limit(WORKFLOW.sweepBatch)
      .select('uuid orgId resolutionWarnAt resolutionDueAt')
      .lean();
    for (const r of due) {
      const claimed = await this.submissions.updateOne({ uuid: r.uuid, resolutionWarnAt: r.resolutionWarnAt }, { $set: { resolutionWarnAt: null } });
      if (!claimed.modifiedCount) continue;
      fired++;
      await this.records.log(r.orgId, r.uuid, 'SLA', '', 'Resolution due soon', { kind: 'APPROACHING', dueAt: r.resolutionDueAt });
      await this.safeRun('SLA_APPROACHING', r.orgId, r.uuid);
    }
    return fired;
  }

  /**
   * Resolution missed: step 0 = the breach (SLA_BREACHED automations), then
   * each escalation level when its time comes (notify / reassign / raise
   * priority). Each step is claimed on (nextEscalationAt, escalationStep), so
   * several instances never run a step twice.
   */
  private async sweepEscalation(now: Date): Promise<number> {
    let fired = 0;
    const due = await this.submissions
      .find({ nextEscalationAt: { $lte: now }, resolvedAt: null, slaPausedAt: null, isDeleted: false })
      .limit(WORKFLOW.sweepBatch)
      .select('uuid orgId')
      .lean();
    for (const { uuid, orgId } of due) {
      for (let guard = 0; guard < 6; guard++) {
        const { record, definition } = await this.records.load(orgId, uuid);
        if (!record.nextEscalationAt || record.nextEscalationAt > now || record.resolvedAt || record.slaPausedAt) break;
        const step = record.escalationStep ?? 0;
        const ctx = await this.records.slaContext(orgId, definition);
        const next = escalationAt(ctx, step + 1, record.resolutionDueAt);
        const claimed = await this.submissions.updateOne(
          { uuid, nextEscalationAt: record.nextEscalationAt, escalationStep: step },
          { $set: { escalationStep: step + 1, nextEscalationAt: next, ...(step === 0 ? { resolutionBreachedAt: now } : {}) } },
        );
        if (!claimed.modifiedCount) break;
        fired++;
        if (step === 0) {
          await this.records.log(orgId, uuid, 'SLA', '', 'Resolution time missed', { kind: 'RESOLUTION', dueAt: record.resolutionDueAt });
          await this.safeRun('SLA_BREACHED', orgId, uuid, 'RESOLUTION');
          continue;
        }
        const level = definition.workflow?.escalation?.levels?.[step - 1];
        if (!level) break;
        const done: string[] = [];
        const notify = await this.records.resolveUsers(orgId, level.notify, record);
        if (notify.length) {
          this.records.notify(orgId, notify, `Escalated (level ${step}): ${record.ref || definition.name} is past its resolution time`, uuid, record.ref, definition.name);
          done.push(`notified ${notify.length}`);
        }
        if (level.reassignTo && level.reassignTo !== record.assigneeId) {
          await this.records.assign(orgId, uuid, level.reassignTo, '').then(
            () => done.push('reassigned'),
            (err) => done.push(`reassign failed: ${(err as Error).message}`),
          );
        }
        if (level.raisePriority) {
          await this.records.bumpPriority(orgId, uuid, '');
          done.push('priority raised');
        }
        await this.records.log(orgId, uuid, 'ESCALATED', '', `Escalation level ${step}: ${done.join(', ') || 'nothing to do'}`, { level: step, notified: notify });
      }
    }
    return fired;
  }

  // ---------------------------------------------------------------- engine

  private matching(def: FormDefinition, trigger: AutomationTrigger, status: string, changed: string[] = []): Automation[] {
    return (def.automations ?? []).filter(
      (a) =>
        a.enabled &&
        a.when === trigger &&
        (trigger !== 'STATUS_CHANGED' || !a.toStatus || a.toStatus === status) &&
        (trigger !== 'FIELD_UPDATED' || !a.field || changed.includes(a.field)),
    );
  }

  /** `actor` is who caused this (the submitter, the person who moved it) - used as the task creator. */
  async run(trigger: AutomationTrigger, orgId: string, recordId: string, depth: number, actor: string, changed: string[] = [], sla?: 'STATUS' | 'RESPONSE' | 'RESOLUTION') {
    const { record, definition } = await this.records.load(orgId, recordId);
    const automations = this.matching(definition, trigger, record.status, changed).filter((a) => trigger !== 'SLA_BREACHED' || !a.sla || a.sla === sla);
    if (!automations.length) return;
    if (depth >= WORKFLOW.maxAutomationDepth) {
      await this.records.log(orgId, recordId, 'AUTOMATION', '', 'Stopped: automations kept changing the status', { ok: false, depth });
      return;
    }

    const values = valuesFromPayload(definition, record.payload as FormValues);
    for (const automation of automations) {
      if (automation.if && !evaluateCondition(automation.if, conditionValues(values, record.status, {}, { priority: record.priority, work: record.work }))) continue;
      await this.runFlow(automation, { orgId, trigger, definition, values, recordId }, depth, actor);
    }
  }

  /**
   * One flow, top to bottom - like an AEM workflow instance. Every step gets
   * the payload and the outputs of the steps above it (`steps`); its own
   * output is added for the next. A failed step stops the flow unless it's
   * marked "continue on error". All of it lands on the record's timeline
   * under one runId.
   */
  private async runFlow(
    automation: Automation,
    run: { orgId: string; trigger: AutomationTrigger; definition: FormDefinition; values: FormValues; recordId: string },
    depth: number,
    actor: string,
    resume?: { runId: string; from: number; steps: Record<string, unknown> },
  ) {
    const { orgId, recordId } = run;
    const runId = resume?.runId ?? uuidv4();
    const steps: Record<string, unknown> = { ...(resume?.steps ?? {}) };
    const log = (message: string, data: Record<string, unknown>) =>
      this.records.log(orgId, recordId, 'AUTOMATION', '', `${automation.name}: ${message}`, { runId, automationId: automation.id, ...data });
    const finish = (status: 'DONE' | 'STOPPED') =>
      resume ? this.runs.updateOne({ uuid: runId }, { $set: { status, steps } }) : Promise.resolve();

    for (let index = resume?.from ?? 0; index < automation.actions.length; index++) {
      const action = automation.actions[index];
      const key = stepKey(action, index);
      const base = { stepKey: key, stepIndex: index, action: action.type };
      // Earlier steps (ASSIGN, SET_STATUS) may have changed the record.
      const live = (await this.records.load(orgId, recordId)).record;
      if (action.if && !evaluateCondition(action.if, conditionValues(run.values, live.status, steps, { priority: live.priority, work: live.work }))) {
        await log(`${stepName(action)} skipped (condition not met)`, { ...base, ok: true, skipped: true });
        continue;
      }
      if (action.type === 'APPROVAL') {
        // Participant step: save where we are and stop; a decision resumes from the next step.
        const approvers = await this.userIds(action.to, { orgId: run.orgId, record: live });
        if (approvers.length) {
          const title = await this.pause(automation, run, { runId, depth, actor, index, key, steps, approvers, action, live });
          await log(`waiting for approval: ${title}`, { ...base, ok: true, waiting: true, approvers });
          return;
        }
        await log('APPROVAL failed - no one to approve', { ...base, ok: false, error: 'no one to approve' });
        if (action.continueOnError) continue;
        await log(`stopped after step ${index + 1} failed`, { ok: false, stopped: true, stepIndex: index });
        return finish('STOPPED');
      }
      try {
        const result = await this.execute(action, { ...run, record: live, steps: { ...steps }, stepKey: key }, depth, actor);
        const { summary, data } = typeof result === 'string' ? { summary: result, data: undefined } : result;
        if (data) steps[key] = data;
        await log(summary, { ...base, ok: true, ...(data ? { output: boundedOutput(data) } : {}) });
      } catch (err) {
        const error = ((err as Error).message ?? 'failed').slice(0, 300);
        this.logger.warn(`automation "${automation.name}" step ${key} (${action.type}) on ${recordId}: ${error}`);
        await log(`${action.type} failed - ${error}`, { ...base, ok: false, error });
        if (!action.continueOnError) {
          await log(`stopped after step ${index + 1} failed`, { ok: false, stopped: true, stepIndex: index });
          return finish('STOPPED');
        }
      }
    }
    await finish('DONE');
  }

  /** Store the paused flow and tell the approvers. Returns the approval's title as shown to them. */
  private async pause(
    automation: Automation,
    run: { orgId: string; trigger: AutomationTrigger; definition: FormDefinition; recordId: string },
    p: {
      runId: string;
      depth: number;
      actor: string;
      index: number;
      key: string;
      steps: Record<string, unknown>;
      approvers: string[];
      action: Extract<AutomationAction, { type: 'APPROVAL' }>;
      live: RecordRow;
    },
  ) {
    const now = new Date();
    const tctx = this.templateContext({ ...run, record: p.live, values: {}, steps: p.steps, stepKey: p.key });
    const title = renderTemplate(p.action.title, { ...tctx, values: valuesFromPayload(run.definition, p.live.payload as FormValues) }, false).slice(0, 200);
    await this.runs.updateOne(
      { uuid: p.runId },
      {
        $set: {
          orgId: run.orgId,
          recordId: run.recordId,
          formId: run.definition.id,
          automationId: automation.id,
          trigger: run.trigger,
          depth: p.depth,
          actor: p.actor,
          status: 'WAITING',
          stepIndex: p.index,
          steps: p.steps,
          approval: {
            stepKey: p.key,
            title,
            instructions: (p.action.instructions ?? '').slice(0, 2000),
            approvers: p.approvers,
            requestedAt: now,
            dueAt: p.action.dueInHours ? new Date(now.getTime() + p.action.dueInHours * 3600_000) : null,
            decision: null,
            decidedBy: '',
            comment: '',
            decidedAt: null,
          },
        },
      },
      { upsert: true },
    );
    this.records.notify(run.orgId, p.approvers, `Approval needed: ${title}${p.live.ref ? ` (${p.live.ref})` : ''}`, run.recordId, p.live.ref, run.definition.name);
    return title;
  }

  /**
   * An approver decides. The run is claimed atomically (two approvers
   * clicking at once: one wins, the other gets 409), then the flow resumes
   * from the next step with { decision, decidedBy, comment } as this step's output.
   */
  async decide(user: { uuid: string; orgId: string; name?: string; modules?: string[] }, recordId: string, runId: string, body: { decision?: unknown; comment?: unknown }) {
    const decision = body?.decision === 'APPROVED' || body?.decision === 'REJECTED' ? body.decision : null;
    if (!decision) throw new BadRequestException('Choose approve or reject');
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, WORKFLOW.commentLength) : '';
    const run = await this.runs.findOne({ uuid: runId, orgId: user.orgId, recordId }).lean();
    if (!run?.approval) throw new NotFoundException('Approval not found');
    if (!run.approval.approvers.includes(user.uuid) && !isRecordAdmin(user)) throw new ForbiddenException('You are not an approver for this step');

    const decidedAt = new Date();
    const claimed = await this.runs.findOneAndUpdate(
      { uuid: runId, orgId: user.orgId, status: 'WAITING' },
      { $set: { status: 'RUNNING', 'approval.decision': decision, 'approval.decidedBy': user.uuid, 'approval.comment': comment, 'approval.decidedAt': decidedAt } },
      { new: true },
    );
    if (!claimed) throw new ConflictException('This approval was already decided');

    if (run.kind === 'ACTION') {
      // A named action waiting for approval: the decision makes (or refuses) the move.
      await this.runs.updateOne({ uuid: runId }, { $set: { status: 'DONE' } });
      await this.records.completeActionApproval(user.orgId, recordId, run.actionKey, decision, user.uuid, comment, runId);
      return;
    }
    const { record, definition } = await this.records.load(user.orgId, recordId);
    const automation = (definition.automations ?? []).find((a) => a.id === run.automationId);
    const output = { decision, decidedBy: user.uuid, decidedByName: user.name ?? '', comment, decidedAt: decidedAt.toISOString() };
    await this.records.log(user.orgId, recordId, 'AUTOMATION', user.uuid, `${automation?.name ?? 'Automation'}: ${decision === 'APPROVED' ? 'approved' : 'rejected'}${comment ? ` - "${comment}"` : ''}`, {
      runId,
      automationId: run.automationId,
      stepKey: run.approval.stepKey,
      stepIndex: run.stepIndex,
      action: 'APPROVAL',
      ok: true,
      output,
    });
    if (!automation) {
      await this.runs.updateOne({ uuid: runId }, { $set: { status: 'STOPPED' } });
      return;
    }
    // Carry on in the background, like after a submission.
    void this.runFlow(
      automation,
      { orgId: user.orgId, trigger: run.trigger as AutomationTrigger, definition, values: valuesFromPayload(definition, record.payload as FormValues), recordId },
      run.depth,
      user.uuid,
      { runId, from: run.stepIndex + 1, steps: { ...(run.steps ?? {}), [run.approval.stepKey]: output } },
    ).catch((err) => this.logger.error(`resuming flow ${runId} failed: ${(err as Error).message}`));
  }

  private templateContext(ctx: FormHandlerContext): TemplateContext {
    const base = (process.env.FORM_APP_URL ?? '').replace(/\/+$/, '');
    const status = findStatus(workflowOf(ctx.definition), ctx.record.status);
    return {
      values: ctx.values,
      work: ctx.record.work ?? {},
      record: { ref: ctx.record.ref, status: status?.label ?? ctx.record.status, link: base ? `${base}/app2${recordPath(ctx.record.uuid)}` : '' },
      form: { name: ctx.definition.name },
      steps: ctx.steps,
    };
  }

  /** Members for notifications / tasks. */
  /** Members (assignee, submitter, a user, the assignee's manager). */
  private userIds(to: RecipientRef[], ctx: { orgId: string; record: RecordRow }): Promise<string[]> {
    return this.records.resolveUsers(ctx.orgId, to, ctx.record);
  }

  /** Email addresses: users' emails from their records, answers of EMAIL fields, fixed addresses. */
  private async emails(to: RecipientRef[], ctx: FormHandlerContext): Promise<string[]> {
    const people = await this.records.contacts(ctx.orgId, await this.userIds(to, ctx));
    const out = [...people.values()].map((p) => p.email);
    for (const r of to) {
      if (r.kind === 'EMAIL') out.push(r.email);
      if (r.kind === 'FIELD' && typeof ctx.values[r.field] === 'string') out.push(ctx.values[r.field] as string);
    }
    return [...new Set(out.map((e) => e.trim().toLowerCase()).filter((e) => EMAIL.test(e)))].slice(0, 20);
  }

  private async execute(action: AutomationAction, ctx: FormHandlerContext, depth: number, actor: string): Promise<StepResult> {
    const tctx = this.templateContext(ctx);
    const { orgId, record, definition } = ctx;

    switch (action.type) {
      case 'EMAIL': {
        const to = await this.emails(action.to, ctx);
        if (!to.length) throw new Error('no one to email');
        // Header injection: a subject is one line. The body is plain text made safe for HTML.
        const subject = renderTemplate(action.subject, tctx, false).replace(/[\r\n]+/g, ' ').slice(0, 200);
        const body = escapeHtml(renderTemplate(action.body, tctx, false)).replace(/\r?\n/g, '<br>');
        const template = `<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333;">${body}</div>`;
        for (const email of to) {
          const sent = await this.mail.sendMail({
            to: email,
            subject,
            template,
            orgId,
            sourceModule: 'FORMS',
            entityType: 'form-record',
            entityId: record.uuid,
          });
          if (!sent?.success) throw new Error(`email to ${email} failed`);
        }
        return { summary: `emailed ${to.length} recipient${to.length === 1 ? '' : 's'}`, data: { sent: to.length } };
      }

      case 'NOTIFY': {
        const to = await this.userIds(action.to, ctx);
        if (!to.length) throw new Error('no one to notify');
        this.records.notify(orgId, to, renderTemplate(action.message, tctx, false), record.uuid, record.ref, definition.name);
        return { summary: `notified ${to.length} user${to.length === 1 ? '' : 's'}`, data: { notified: to.length } };
      }

      case 'CREATE_TASK':
        // Tasks were Sangam's Tasks app; Form Builder refuses this step at publish.
        throw new Error('Task steps are not available in Form Builder');

      case 'ASSIGN':
        await this.records.assign(orgId, record.uuid, action.userId, '');
        return 'assigned';

      case 'SET_STATUS':
        if (record.status === action.status) return 'already in that status';
        await this.records.transition(orgId, record.uuid, action.status, '', depth + 1);
        return `moved to ${findStatus(workflowOf(definition), action.status)?.label ?? action.status}`;

      case 'WEBHOOK':
        return this.webhook(action.url, ctx);

      case 'APPROVAL':
        // Pausing is the flow's job (runFlow); reaching here would be a bug.
        throw new Error('approval steps are handled by the flow');

      case 'HANDLER': {
        const handler = this.handlers.get(action.key);
        if (!handler) throw new Error(`no handler registered as "${action.key}"`);
        return fromHandler(action.key, await handler(ctx));
      }
    }
  }

  /**
   * POST the record to an allow-listed https host. No redirects (they could
   * point anywhere), a short timeout, and an HMAC signature when
   * FORM_WEBHOOK_SECRET is set so the receiver can trust the body.
   */
  private async webhook(url: string, ctx: FormHandlerContext): Promise<StepResult> {
    const { host, status, reply } = await postWebhook(
      url,
      {
        event: ctx.trigger,
        form: { code: ctx.definition.code, version: ctx.definition.version, name: ctx.definition.name },
        record: {
          id: ctx.record.uuid,
          ref: ctx.record.ref,
          status: ctx.record.status,
          assigneeId: ctx.record.assigneeId,
          submittedAt: ctx.record.createdAt,
        },
        values: ctx.record.payload,
        // What earlier steps produced in this flow (AEM-style metadata).
        steps: ctx.steps,
      },
      process.env.FORM_WEBHOOK_SECRET,
    );
    // A JSON object reply becomes this step's output, e.g. {{$steps.crm.leadId}}.
    return { summary: `posted to ${host}`, data: { ...reply, httpStatus: status } };
  }
}
