import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { resolveSharedWorkflow, usedStyleIds, validateFormDefinition, type FormDefinition, type FormStyle } from '@fb/engine';
import type { Model } from 'mongoose';
import { Grant, type GrantDocument } from '../access/access.schemas';
import { PermissionService } from '../access/permission.service';
import { isAllowed, type Permission, type ResourceRef } from '../access/roles';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { newId } from '../common/crypto';
import { StylesService } from '../styles/styles.service';
import { FormDefinitionService } from '../work/services/form-definition.service';
import { FormHandlerRegistry } from '../work/services/form-workflow.registry';
import { PlansService } from '../plans/plans.service';
import { Form, type FormDocument } from './form.schema';
import { checkDefinitionSecurity } from './payload-guard';
import { JobQueue } from '../jobs/job-queue.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { ExtensionsService } from '../extensions/extensions.service';
import { Membership, type MembershipDocument } from '../orgs/org.schemas';

export interface FormSummary {
  id: string;
  code: string;
  name: string;
  folderId: string;
  version: number;
  status: Form['status'];
  /** The published version's number, when a draft is being worked on above it. */
  publishedVersion: number | null;
  updatedAt: Date;
  permissions: Permission[];
  /** Set on a draft that will publish itself. */
  publishAt: Date | null;
  /** Why its last scheduled publish did not happen. */
  scheduleError: string;
}

/** How far ahead a publish can be scheduled. */
const MAX_SCHEDULE_DAYS = 365;

interface ScheduledPublish {
  orgId: string;
  formId: string;
  /** The time the draft was scheduled for when this job was queued. */
  publishAt: string;
}

export const PACKAGE_FORMAT = 'form-builder/form';
export interface FormPackage {
  format: typeof PACKAGE_FORMAT;
  formatVersion: 1;
  exportedAt: string;
  source: { code: string; version: number; status: string };
  definition: Record<string, unknown>;
  styles: FormStyle[];
  /** Connector refs the form reads or writes; the target org needs connectors with the same refs (or edit the bindings). */
  requires: { connectors: string[] };
}

class FormProblems extends BadRequestException {
  constructor(issues: { field: string; message: string }[]) {
    super({ message: 'The form has problems', errors: issues });
  }
}

/**
 * Form definitions and their lifecycle (ported from Sangam):
 * DRAFT --publish--> PUBLISHED --archive / superseded--> ARCHIVED.
 * A published version is never edited; a new version is drafted instead.
 * Every action checks the caller's permission on the form's folder.
 */
@Injectable()
export class FormsService implements OnModuleInit {
  private readonly logger = new Logger(FormsService.name);

  constructor(
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly styles: StylesService,
    private readonly definitions: FormDefinitionService,
    private readonly handlers: FormHandlerRegistry,
    private readonly plans: PlansService,
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
    @InjectModel(Grant.name) private readonly grants: Model<GrantDocument>,
    @InjectModel(Membership.name) private readonly memberships: Model<MembershipDocument>,
    private readonly jobs: JobQueue,
    private readonly workflows: WorkflowsService,
    private readonly extensions: ExtensionsService,
  ) {}

  private live(orgId: string) {
    return { orgId, isDeleted: false };
  }

  /** The stored definition, with identity and status taken from the row (the row is authoritative). */
  private static toDefinition(row: Form): FormDefinition {
    return { ...(row.definition as unknown as FormDefinition), id: row.id, orgId: row.orgId, code: row.code, version: row.version, status: row.status };
  }

  private validate(input: unknown, level: 'shape' | 'publish'): FormDefinition {
    const result = validateFormDefinition(input, level);
    if ('issues' in result) throw new FormProblems(result.issues.map((i) => ({ field: i.path, message: i.message })));
    const security = checkDefinitionSecurity(result.data);
    if (security.length) throw new FormProblems(security);
    return result.data;
  }

  private async ref(orgId: string, folderId: string, code: string): Promise<ResourceRef> {
    const folder = await this.permissions.folderRef(orgId, folderId);
    return { type: 'form', id: code, folderPath: folder.folderPath };
  }

  private async mustGet(auth: AuthContext, id: string, permission: Permission): Promise<FormDocument> {
    const row = await this.forms.findOne({ id, ...this.live(auth.orgId) });
    // Not found and not allowed look the same: don't reveal forms outside the caller's folders.
    if (!row || !(await this.permissions.can(auth, 'form.view', await this.ref(auth.orgId, row.folderId, row.code)))) throw new NotFoundException('Form not found');
    await this.permissions.assert(auth, permission, await this.ref(auth.orgId, row.folderId, row.code));
    return row;
  }

  private async assertCodeFree(orgId: string, code: string) {
    const clash = await this.forms.findOne({ ...this.live(orgId), code }).lean();
    if (clash) throw new ConflictException({ message: 'The form has problems', errors: [{ field: 'code', message: `Code ${code} is already used by "${clash.name}"` }] });
  }

  // ---------------------------------------------------------------- reading

  /** The latest version of every form the caller may view, optionally in one folder (not its sub-folders). */
  async list(auth: AuthContext, folderId?: string): Promise<FormSummary[]> {
    const rows = await this.forms
      .find({ ...this.live(auth.orgId), ...(folderId ? { folderId } : {}) })
      .sort({ code: 1, version: -1 })
      .select('id code name folderId version status updatedAt publishAt scheduleError')
      .lean();
    const latest = new Map<string, (typeof rows)[number]>();
    const published = new Map<string, number>();
    for (const r of rows) {
      if (!latest.has(r.code)) latest.set(r.code, r);
      if (r.status === 'PUBLISHED' && !published.has(r.code)) published.set(r.code, r.version);
    }
    const grants = await this.grants.find({ orgId: auth.orgId, userId: auth.userId }).lean();
    const out: FormSummary[] = [];
    const paths = new Map<string, string[]>();
    for (const r of latest.values()) {
      if (!paths.has(r.folderId)) paths.set(r.folderId, (await this.permissions.folderRef(auth.orgId, r.folderId).catch(() => null))?.folderPath ?? []);
      const ref: ResourceRef = { type: 'form', id: r.code, folderPath: paths.get(r.folderId) };
      const perms = (['form.view', 'form.edit', 'form.publish'] as Permission[]).filter((p) => isAllowed(auth.role, grants, p, ref));
      if (!perms.includes('form.view')) continue;
      out.push({ id: r.id, code: r.code, name: r.name, folderId: r.folderId, version: r.version, status: r.status, publishedVersion: published.get(r.code) ?? null, updatedAt: r.updatedAt, publishAt: r.publishAt ?? null, scheduleError: r.scheduleError ?? '', permissions: perms });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(auth: AuthContext, id: string) {
    const row = await this.mustGet(auth, id, 'form.view');
    const perms = await this.permissions.effective(auth, await this.ref(auth.orgId, row.folderId, row.code));
    return {
      definition: FormsService.toDefinition(row),
      folderId: row.folderId,
      permissions: perms.filter((p) => p.startsWith('form.')),
      publishAt: row.publishAt ?? null,
      scheduleError: row.scheduleError ?? '',
    };
  }

  async versions(auth: AuthContext, id: string) {
    const row = await this.mustGet(auth, id, 'form.view');
    const rows = await this.forms.find({ ...this.live(auth.orgId), code: row.code }).sort({ version: -1 }).select('id version status updatedAt publishedAt publishedBy updatedBy').lean();
    return rows.map((r) => ({ id: r.id, version: r.version, status: r.status, updatedAt: r.updatedAt, publishedAt: r.publishedAt, publishedBy: r.publishedBy, updatedBy: r.updatedBy }));
  }

  // ---------------------------------------------------------------- lifecycle

  /** A new form: version 1, DRAFT, a server-issued id, in a folder the caller can edit. */
  async create(auth: AuthContext, body: { folderId: string; definition: unknown }) {
    const input = body.definition as Record<string, unknown> | null;
    // Identity and authorship are the server's to set, never the caller's.
    const def = this.validate({ ...(input ?? {}), id: 'new', orgId: auth.orgId, version: 1, status: 'DRAFT', createdBy: auth.userId, updatedBy: auth.userId }, 'shape');
    await this.permissions.assert(auth, 'form.edit', await this.ref(auth.orgId, body.folderId, def.code));
    await this.assertCodeFree(auth.orgId, def.code);
    await this.plans.assertCanAdd(auth.orgId, 'forms');
    const id = newId();
    await this.forms.create({
      id,
      orgId: auth.orgId,
      folderId: body.folderId,
      code: def.code,
      version: 1,
      status: 'DRAFT',
      name: def.name,
      definition: { ...def, id, orgId: auth.orgId, version: 1, status: 'DRAFT', styles: undefined, createdBy: auth.userId, updatedBy: auth.userId },
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    await this.audit.record(actorOf(auth), { action: 'form.created', targetType: 'form', targetId: id, after: { code: def.code, name: def.name } });
    return this.get(auth, id);
  }

  /** Save a draft. Published and archived versions are read-only; the code is fixed once other versions exist. */
  async update(auth: AuthContext, id: string, input: unknown) {
    const row = await this.mustGet(auth, id, 'form.edit');
    if (row.status !== 'DRAFT') throw new ConflictException(`${row.code} v${row.version} is ${row.status.toLowerCase()} and can't be changed. Start a new version instead.`);
    const def = this.validate({ ...((input as object) ?? {}), id: row.id, orgId: auth.orgId, version: row.version, status: 'DRAFT', createdBy: row.createdBy, updatedBy: auth.userId }, 'shape');
    if (def.code !== row.code) {
      if (await this.forms.exists({ ...this.live(auth.orgId), code: row.code, id: { $ne: row.id } })) throw new ConflictException('The code is fixed once a form has other versions');
      await this.assertCodeFree(auth.orgId, def.code);
    }
    row.set({ code: def.code, name: def.name, definition: { ...def, styles: undefined, updatedBy: auth.userId }, updatedBy: auth.userId });
    row.markModified('definition');
    await row.save();
    return this.get(auth, id);
  }

  /** Full validation, then this version goes live and the previous published one is archived. */
  async publish(auth: AuthContext, id: string) {
    const row = await this.mustGet(auth, id, 'form.publish');
    if (row.status !== 'DRAFT') throw new ConflictException(`Only drafts can be published (this is ${row.status.toLowerCase()})`);
    const draft = await this.withSharedWorkflow(auth.orgId, FormsService.toDefinition(row));
    // Custom APIs (HANDLER steps) are code; none are deployed in this product yet. Tasks were a Sangam app.
    const steps = (draft.automations ?? []).flatMap((a) => a.actions);
    if (steps.some((x) => x.type === 'CREATE_TASK')) throw new FormProblems([{ field: 'automations', message: "Task steps aren't available in Form Builder" }]);
    // Custom API steps must be runnable here: a code handler or an exposed, writable connector operation.
    for (const step of steps) {
      if (step.type === 'HANDLER' && !(step.key && (await this.handlers.exists(auth.orgId, step.key)))) {
        const why = step.key?.startsWith('c-')
          ? 'its connector or operation was removed, or writes are off'
          : step.key?.startsWith('x-')
            ? 'your extension was removed, or no longer offers it'
            : "it isn't installed on this server";
        throw new FormProblems([{ field: 'automations', message: `Custom API step "${step.label || step.key}" isn't available: ${why}` }]);
      }
    }
    for (const key of draft.submitChecks ?? []) {
      if (!(await this.extensions.checkExists(auth.orgId, key))) {
        throw new FormProblems([{ field: 'submitChecks', message: 'A check this form runs before accepting a submission is no longer offered by your extension. Remove it in the form settings.' }]);
      }
    }
    // Freeze the library styles this version uses into it: later edits to a style don't change live forms.
    const ids = usedStyleIds(draft);
    const styles = await this.styles.byKeys(auth.orgId, ids);
    const missing = ids.filter((key) => !styles.some((st) => st.id === key));
    if (missing.length) throw new FormProblems(missing.map((key) => ({ field: 'styles', message: `Style "${key}" no longer exists in the style library` })));
    const now = new Date();
    const def = this.validate({ ...draft, styles: styles.length ? styles : undefined, status: 'PUBLISHED', updatedAt: now.toISOString(), updatedBy: auth.userId }, 'publish');
    await this.forms.updateMany(
      { ...this.live(auth.orgId), code: row.code, status: 'PUBLISHED', id: { $ne: row.id } },
      { $set: { status: 'ARCHIVED', 'definition.status': 'ARCHIVED', updatedBy: auth.userId } },
    );
    row.set({ status: 'PUBLISHED', definition: def, publishedAt: now, publishedBy: auth.userId, updatedBy: auth.userId, publishAt: null, scheduledBy: '', scheduleError: '' });
    row.markModified('definition');
    await row.save();
    this.definitions.forget(auth.orgId);
    await this.audit.record(actorOf(auth), { action: 'form.published', targetType: 'form', targetId: id, after: { code: row.code, version: row.version } });
    return this.get(auth, id);
  }

  /**
   * A form that uses a workflow from the library gets a copy of it as it is
   * now, naming this form's own fields. That copy is what is published, so a
   * later change to the library reaches this form only when it is next published.
   */
  private async withSharedWorkflow(orgId: string, draft: FormDefinition): Promise<FormDefinition> {
    if (!draft.workflowRef) return draft;
    const shared = await this.workflows.find(orgId, draft.workflowRef.id);
    if (!shared) throw new FormProblems([{ field: 'workflowRef', message: 'The shared workflow this form uses is no longer in the library. Choose another, or give the form its own.' }]);
    const { definition, missing } = resolveSharedWorkflow(draft, shared);
    if (missing.length) {
      throw new FormProblems(missing.map((m) => ({ field: 'workflowRef', message: `"${shared.name}" needs "${m.label}". Choose which of this form's fields that is.` })));
    }
    return definition;
  }

  // ------------------------------------------------------- scheduled publishing

  onModuleInit() {
    this.jobs.register('form.publish', (p: ScheduledPublish) => this.runScheduled(p), { maxAttempts: 3 });
  }

  /**
   * Sets a draft to publish itself at `when`. The same checks as publishing
   * run now, so problems show while someone is looking; they run again at the
   * time, with the rights the scheduler has then.
   */
  async schedule(auth: AuthContext, id: string, when: unknown) {
    const row = await this.mustGet(auth, id, 'form.publish');
    if (row.status !== 'DRAFT') throw new ConflictException(`Only drafts can be scheduled (this is ${row.status.toLowerCase()})`);
    const at = typeof when === 'string' ? new Date(when) : new Date(NaN);
    if (Number.isNaN(at.getTime())) throw new BadRequestException('Choose a date and time');
    if (at.getTime() <= Date.now()) throw new BadRequestException('Choose a time in the future, or publish now');
    if (at.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) throw new BadRequestException(`Choose a time within ${MAX_SCHEDULE_DAYS} days`);
    this.validate({ ...(await this.withSharedWorkflow(auth.orgId, FormsService.toDefinition(row))), status: 'PUBLISHED' }, 'publish');

    row.set({ publishAt: at, scheduledBy: auth.userId, scheduleError: '' });
    await row.save();
    await this.jobs.enqueue('form.publish', { orgId: auth.orgId, formId: id, publishAt: at.toISOString() }, { orgId: auth.orgId, runAt: at });
    await this.audit.record(actorOf(auth), { action: 'form.publish_scheduled', targetType: 'form', targetId: id, after: { code: row.code, version: row.version, publishAt: at.toISOString() } });
    return this.get(auth, id);
  }

  async unschedule(auth: AuthContext, id: string) {
    const row = await this.mustGet(auth, id, 'form.publish');
    if (row.publishAt) {
      row.set({ publishAt: null, scheduledBy: '' });
      await row.save();
      await this.audit.record(actorOf(auth), { action: 'form.publish_unscheduled', targetType: 'form', targetId: id, after: { code: row.code, version: row.version } });
    }
    return this.get(auth, id);
  }

  /**
   * The job behind a schedule. It publishes only if the draft is still set
   * for exactly this time (rescheduling or cancelling leaves the old job with
   * nothing to do), and as the person who scheduled it, with the role they
   * hold now. A publish that is refused is recorded on the form, not retried.
   */
  private async runScheduled({ orgId, formId, publishAt }: ScheduledPublish) {
    const row = await this.forms.findOne({ id: formId, ...this.live(orgId) }).lean();
    if (!row || row.status !== 'DRAFT' || !row.publishAt || row.publishAt.toISOString() !== publishAt) return;
    const member = await this.memberships.findOne({ orgId, userId: row.scheduledBy, status: 'ACTIVE' }).lean();
    const fail = async (reason: string) => {
      await this.forms.updateOne({ id: formId }, { $set: { publishAt: null, scheduleError: reason.slice(0, 500) } });
      this.logger.warn(`scheduled publish of ${row.code} v${row.version} did not happen: ${reason}`);
    };
    if (!member) return fail('The person who scheduled it is no longer a member of the organisation');
    const auth: AuthContext = { userId: row.scheduledBy, orgId, sessionId: 'scheduled-publish', role: member.role, mfa: true, ip: '', userAgent: 'scheduled publish' };
    try {
      await this.publish(auth, formId);
    } catch (e) {
      // Refused for a reason a person has to fix (a problem in the form, rights withdrawn): say so on the form.
      if (e instanceof HttpException && e.getStatus() < 500) {
        const body = e.getResponse() as { message?: string; errors?: { message: string }[] } | string;
        const detail = typeof body === 'string' ? body : [body.message, ...(body.errors ?? []).map((x) => x.message)].filter(Boolean).join(': ');
        return fail(detail || e.message);
      }
      throw e;
    }
  }

  /** Copy a published or archived version into the next draft, or return the draft already open. */
  async newVersion(auth: AuthContext, id: string) {
    const source = await this.mustGet(auth, id, 'form.edit');
    if (source.status === 'DRAFT') return this.get(auth, id);
    const open = await this.forms.findOne({ ...this.live(auth.orgId), code: source.code, status: 'DRAFT' }).lean();
    if (open) return this.get(auth, open.id);
    const latest = await this.forms.findOne({ ...this.live(auth.orgId), code: source.code }).sort({ version: -1 }).lean();
    const version = (latest?.version ?? source.version) + 1;
    const newIdValue = newId();
    await this.forms.create({
      id: newIdValue,
      orgId: auth.orgId,
      folderId: source.folderId,
      code: source.code,
      version,
      status: 'DRAFT',
      name: source.name,
      definition: { ...FormsService.toDefinition(source), id: newIdValue, version, status: 'DRAFT', styles: undefined, createdBy: auth.userId, updatedBy: auth.userId },
      createdBy: auth.userId,
      updatedBy: auth.userId,
    });
    await this.audit.record(actorOf(auth), { action: 'form.version_created', targetType: 'form', targetId: newIdValue, after: { code: source.code, version } });
    return this.get(auth, newIdValue);
  }

  /**
   * Bring an earlier version back as the draft. With no draft open this is a
   * new version copied from it. With one open, that draft's content is
   * replaced - only when the caller says so, since its edits are lost.
   */
  async restore(auth: AuthContext, id: string, replaceDraft: boolean) {
    const source = await this.mustGet(auth, id, 'form.edit');
    if (source.status === 'DRAFT') throw new ConflictException('This version is the draft itself');
    const open = await this.forms.findOne({ ...this.live(auth.orgId), code: source.code, status: 'DRAFT' });
    if (!open) {
      const made = await this.newVersion(auth, id);
      await this.audit.record(actorOf(auth), { action: 'form.version_restored', targetType: 'form', targetId: made.definition.id, after: { code: source.code, from: source.version, to: made.definition.version } });
      return made;
    }
    if (!replaceDraft) {
      throw new ConflictException({ message: `A draft (v${open.version}) is already open. Restoring v${source.version} replaces what is in it.`, draftId: open.id, draftVersion: open.version });
    }
    await this.permissions.assert(auth, 'form.edit', await this.ref(auth.orgId, open.folderId, open.code));
    // A draft set to publish itself was scheduled for different content: the schedule goes with it.
    open.set({
      name: source.name,
      definition: { ...FormsService.toDefinition(source), id: open.id, version: open.version, status: 'DRAFT', styles: undefined, createdBy: open.createdBy, updatedBy: auth.userId },
      updatedBy: auth.userId,
      publishAt: null,
      scheduledBy: '',
      scheduleError: '',
    });
    open.markModified('definition');
    await open.save();
    await this.audit.record(actorOf(auth), { action: 'form.version_restored', targetType: 'form', targetId: open.id, after: { code: source.code, from: source.version, to: open.version } });
    return this.get(auth, open.id);
  }

  async archive(auth: AuthContext, id: string) {
    const row = await this.mustGet(auth, id, 'form.publish');
    if (row.status !== 'PUBLISHED') throw new ConflictException('Only a published form can be archived');
    row.set({ status: 'ARCHIVED', definition: { ...row.definition, status: 'ARCHIVED' }, updatedBy: auth.userId });
    row.markModified('definition');
    await row.save();
    this.definitions.forget(auth.orgId);
    await this.audit.record(actorOf(auth), { action: 'form.archived', targetType: 'form', targetId: id, after: { code: row.code, version: row.version } });
    return this.get(auth, id);
  }

  /** Drafts only, soft delete: published versions stay for the submissions made against them. */
  async remove(auth: AuthContext, id: string) {
    const row = await this.mustGet(auth, id, 'form.edit');
    if (row.status !== 'DRAFT') throw new ConflictException('Only drafts can be deleted');
    row.set({ isDeleted: true, updatedBy: auth.userId });
    await row.save();
    await this.audit.record(actorOf(auth), { action: 'form.deleted', targetType: 'form', targetId: id, before: { code: row.code, version: row.version } });
    return { deleted: true };
  }

  /** Move every version of a form to another folder; needs edit rights in both. */
  async move(auth: AuthContext, id: string, folderId: string) {
    const row = await this.mustGet(auth, id, 'form.edit');
    await this.permissions.assert(auth, 'form.edit', await this.ref(auth.orgId, folderId, row.code));
    const from = row.folderId;
    await this.forms.updateMany({ ...this.live(auth.orgId), code: row.code }, { $set: { folderId, updatedBy: auth.userId } });
    await this.audit.record(actorOf(auth), { action: 'form.moved', targetType: 'form', targetId: id, before: { folderId: from }, after: { folderId } });
    return this.get(auth, id);
  }

  /** A form's submissions (personal data): editors and publishers of its folder only. */
  async assertCanReadSubmissions(auth: AuthContext, id: string): Promise<string> {
    const row = await this.forms.findOne({ id, ...this.live(auth.orgId) }).lean();
    if (!row) throw new NotFoundException('Form not found');
    const ref = await this.ref(auth.orgId, row.folderId, row.code);
    if (!(await this.permissions.can(auth, 'form.edit', ref)) && !(await this.permissions.can(auth, 'form.publish', ref))) throw new NotFoundException('Form not found');
    return row.code;
  }

  // ---------------------------------------------------------------- packages (copy between orgs / environments)

  /** A self-contained copy of one version: definition, the styles it uses, and what it needs in the target. */
  async exportPackage(auth: AuthContext, id: string): Promise<FormPackage> {
    const row = await this.mustGet(auth, id, 'form.view');
    const def = FormsService.toDefinition(row);
    const { id: _id, orgId: _org, createdBy: _c, updatedBy: _u, status: _s, version: _v, styles: frozen, ...portable } = def as FormDefinition & Record<string, unknown>;
    const keys = usedStyleIds(def);
    // A published version carries its frozen styles; a draft uses the live library.
    const styles = (frozen as FormStyle[] | undefined)?.length ? (frozen as FormStyle[]) : await this.styles.byKeys(auth.orgId, keys);
    const json = JSON.stringify(portable);
    const connectors = [...new Set([...json.matchAll(/\/connectors\/([a-z0-9]{6,32})\//g)].map((m) => m[1]!))].sort();
    await this.audit.record(actorOf(auth), { action: 'form.exported', targetType: 'form', targetId: id, after: { code: row.code, version: row.version } });
    return { format: PACKAGE_FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), source: { code: row.code, version: row.version, status: row.status }, definition: portable, styles, requires: { connectors } };
  }

  /**
   * Copy a package in: a new form (v1 draft), or the next draft version when
   * the code exists here. Nothing is published - the importer reviews first.
   * Styles are created when missing (org admins only) and never overwritten.
   */
  async importPackage(auth: AuthContext, body: { folderId: string; package: unknown; code?: string }) {
    const pkg = body.package as Partial<FormPackage> | null;
    if (!pkg || pkg.format !== PACKAGE_FORMAT || pkg.formatVersion !== 1 || !pkg.definition || typeof pkg.definition !== 'object') throw new BadRequestException('This is not a form package');
    const code = body.code ?? String((pkg.definition as { code?: unknown }).code ?? '');
    const existing = await this.forms.findOne({ ...this.live(auth.orgId), code }).sort({ version: -1 }).lean();
    const folderId = existing?.folderId ?? body.folderId;
    await this.permissions.assert(auth, 'form.edit', await this.ref(auth.orgId, folderId, code));
    if (existing && (await this.forms.exists({ ...this.live(auth.orgId), code, status: 'DRAFT' }))) {
      throw new ConflictException(`${code} already has an unpublished draft here. Publish or delete it, then import again.`);
    }
    if (!existing) await this.plans.assertCanAdd(auth.orgId, 'forms');
    const version = (existing?.version ?? 0) + 1;
    const id = newId();
    const def = this.validate({ ...pkg.definition, code, id, orgId: auth.orgId, version, status: 'DRAFT', createdBy: auth.userId, updatedBy: auth.userId }, 'shape');

    // A shared workflow from the other organisation's library is not in ours: the copy that came
    // inside the form becomes this form's own workflow.
    if (def.workflowRef && !(await this.workflows.find(auth.orgId, def.workflowRef.id))) delete def.workflowRef;

    // Styles: create the missing ones (validated by the engine schema), keep ours when the key exists.
    const wanted = usedStyleIds(def);
    const have = new Set((await this.styles.byKeys(auth.orgId, wanted)).map((st) => st.id));
    const incoming = new Map((Array.isArray(pkg.styles) ? pkg.styles : []).map((st) => [st?.id, st]));
    const stylesCreated: string[] = [];
    const stylesMissing: string[] = [];
    for (const key of wanted.filter((k) => !have.has(k))) {
      const st = incoming.get(key);
      if (st && isAllowed(auth.role, [], 'org.manage')) {
        await this.styles.upsert(auth, key, st);
        stylesCreated.push(key);
      } else stylesMissing.push(key);
    }
    const refs = new Set((await this.connectorRefs(auth.orgId)).map((c) => c));
    const connectorsMissing = (Array.isArray(pkg.requires?.connectors) ? pkg.requires.connectors : []).filter((r) => typeof r === 'string' && !refs.has(r));

    await this.forms.create({ id, orgId: auth.orgId, folderId, code, version, status: 'DRAFT', name: def.name, definition: { ...def, styles: undefined }, createdBy: auth.userId, updatedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'form.imported', targetType: 'form', targetId: id, after: { code, version, from: pkg.source ?? null } });
    return { id, code, version, stylesCreated, stylesMissing, connectorsMissing };
  }

  private async connectorRefs(orgId: string): Promise<string[]> {
    const rows = await this.forms.db.collection('connectors').find({ orgId, isDeleted: false }, { projection: { ref: 1 } }).toArray();
    return rows.map((r) => String(r.ref));
  }

  /** The code of a form the caller may view (for its analytics). */
  async codeFor(auth: AuthContext, id: string) {
    return (await this.mustGet(auth, id, 'form.view')).code;
  }

  /** For folder deletion: a folder with forms in it can't go. */
  async folderHasForms(orgId: string, folderId: string) {
    return !!(await this.forms.exists({ ...this.live(orgId), folderId }));
  }
}

