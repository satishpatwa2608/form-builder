import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Model } from 'mongoose';
import { newId as uuidv4 } from '../../common/crypto';
import apiResponse from '../response';
import type { FormDefinition, FormValues, WorkItemSource } from '@fb/engine';
import {
  buildPayload,
  buildZodSchema,
  computeFormState,
  formAvailability,
  isEmptyValue,
  prefillValue,
  resolveParams,
  resolveSystemValue,
  systemContextFor,
  localize,
  pickLanguage,
  uiText,
} from '@fb/engine';
import { CHANNELS, FORM_SUBMITTED_EVENT, LIMITS } from '../constants';
import { checkSubmissionShape, isPlainObject } from '../../forms/payload-guard';
import { FormFieldErrors } from '../security/form-http';
import { FormSubmission, FormSubmissionDocument } from '../schemas/form-submission.schema';
import type { FormUpload } from '../schemas/upload.schema';
import { FormDefinitionService } from './form-definition.service';
import { DataSourceQueryService } from './data-source-query.service';
import { ExtensionsService } from '../../extensions/extensions.service';
import { CaptchaVerifierService } from './captcha-verifier.service';
import { FormUploadService } from './form-upload.service';
import { FormContextService, type OptionalUser } from './form-context.service';
import { FormRecordService } from './form-record.service';

/** What the browser sends. Everything in it is untrusted. */
export interface SubmitBody {
  values?: unknown;
  idempotencyKey?: unknown;
  channel?: unknown;
  urlParams?: unknown;
  /** The browser's IANA time zone, so `today()` in a rule is the same day the person saw. */
  timeZone?: unknown;
  /** The language the form was filled in (one the form offers; its own otherwise). */
  language?: unknown;
}

export interface FormSubmittedEvent {
  orgId: string;
  businessId: string;
  formCode: string;
  formVersion: number;
  submissionId: string;
  endpointId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const reject = (errors: { field: string; message: string }[], message = 'Please check the form') =>
  new FormFieldErrors(422, message, errors);

/**
 * One submit pipeline for every form, org and business. No per-form code:
 * the published definition decides what's valid. Order matters - cheapest
 * and most hostile-input checks first, provider calls and writes last.
 */
@Injectable()
export class FormSubmissionService {
  private readonly logger = new Logger(FormSubmissionService.name);

  constructor(
    @InjectModel(FormSubmission.name) private readonly submissions: Model<FormSubmissionDocument>,
    private readonly definitions: FormDefinitionService,
    private readonly master: DataSourceQueryService,
    private readonly captcha: CaptchaVerifierService,
    private readonly uploads: FormUploadService,
    private readonly events: EventEmitter2,
    private readonly context: FormContextService,
    private readonly records: FormRecordService,
    private readonly extensions: ExtensionsService,
  ) {}

  /** The published form a public caller may open (sign-in-only forms need a user of the same org). */
  /**
   * `use` is what the caller is about to do: `fill` (the public submitting,
   * uploading, saving) is refused outside the form's opening times; `show`
   * (displaying it, or staff raising an item from inside) is not.
   */
  async publishedFor(orgId: string, code: string, user: OptionalUser | undefined, use: 'fill' | 'show' = 'fill'): Promise<FormDefinition> {
    if (!/^[A-Z0-9_]{1,100}$/.test(code)) throw new NotFoundException('Form not found');
    const def = await this.definitions.findPublished(orgId, code);
    if (!def) throw new NotFoundException('Form not found');
    if (def.access === 'AUTHENTICATED') {
      if (!user) throw new UnauthorizedException('Please sign in to open this form');
      if (user.orgId !== orgId) throw new ForbiddenException('This form belongs to another organisation');
    }
    if (use === 'fill') {
      const state = formAvailability(def);
      if (state === 'NOT_YET') throw new ForbiddenException('This form is not open yet');
      if (state === 'CLOSED') throw new ForbiddenException(def.closedMessage?.trim() || 'This form is closed');
    }
    return def;
  }

  /** Only a zone this runtime knows; anything else falls back to UTC. */
  private static cleanTimeZone(input: unknown): string | undefined {
    if (typeof input !== 'string' || input.length > 64) return undefined;
    try {
      new Intl.DateTimeFormat('en', { timeZone: input });
      return input;
    } catch {
      return undefined;
    }
  }

  /** URL params are client-controlled (they feed URL_PARAMETER hidden fields): strings only, bounded. */
  private static cleanUrlParams(input: unknown): Record<string, string> {
    if (!isPlainObject(input)) return {};
    return Object.fromEntries(
      Object.entries(input)
        .filter(([k, v]) => /^[A-Za-z0-9_-]{1,50}$/.test(k) && typeof v === 'string')
        .slice(0, LIMITS.urlParams)
        .map(([k, v]) => [k, (v as string).slice(0, LIMITS.urlParamLength)]),
    );
  }

  /**
   * `source` says where the work item came from. Trusted sources (the portal
   * with a signed-in user, other modules) skip the CAPTCHA - it's there to stop
   * bots on public links - but go through every other check.
   */
  async submit(
    orgId: string,
    code: string,
    body: SubmitBody,
    user: OptionalUser | undefined,
    ip?: string,
    opts: { source?: WorkItemSource; trusted?: boolean } = {},
  ) {
    // Other modules act for the org itself; everyone else goes through the form's access rule.
    const def = opts.source === 'MODULE' ? await this.definitions.findPublished(orgId, code) : await this.publishedFor(orgId, code, user, opts.source ? 'show' : 'fill');
    if (!def) throw new NotFoundException('Form not found');
    const source: WorkItemSource = opts.source ?? 'PUBLIC_FORM';

    // 1. Idempotency: a retried / double-clicked submit returns the first result.
    const idempotencyKey = typeof body.idempotencyKey === 'string' && UUID.test(body.idempotencyKey) ? body.idempotencyKey : null;
    if (idempotencyKey) {
      const existing = await this.submissions.findOne({ orgId, idempotencyKey }).lean();
      if (existing) return apiResponse(true, 200, 'Already submitted', { submissionId: existing.uuid, ref: existing.ref, payload: existing.payload });
    }

    // 2. Shape: plain object, only this form's fields, right types, no markup / operator keys.
    const shapeIssues = checkSubmissionShape(def, body.values);
    if (shapeIssues.length) throw reject(shapeIssues);
    const values: FormValues = { ...(body.values as FormValues) };

    // 3. System values are the server's, never the browser's.
    const channel = CHANNELS.includes(body.channel as (typeof CHANNELS)[number]) ? (body.channel as string) : 'WEB';
    const needsPhone = !!user && def.fields.some((f) => f.systemSource === 'USER_PHONE' || f.prefill?.source === 'USER_PHONE');
    const ctx = systemContextFor(def, {
      userId: user?.uuid,
      userEmail: user?.email,
      userName: user?.name,
      employeeId: user?.employeeId,
      userPhone: needsPhone ? await this.context.userPhone(user!) : undefined,
      sourceChannel: channel,
      now: new Date(),
      urlParams: FormSubmissionService.cleanUrlParams(body.urlParams),
      timeZone: FormSubmissionService.cleanTimeZone(body.timeZone),
    });
    // Messages go back in the language the person is reading the form in, if the form has it.
    const language = pickLanguage(def, typeof body.language === 'string' ? body.language.slice(0, 20) : undefined);
    ctx.language = language;
    const say = uiText(language, def);
    for (const f of def.fields) {
      if (f.type === 'HIDDEN') values[f.name] = f.systemSource ? resolveSystemValue(f, ctx) : f.defaultValue;
      // Locked prefill for a signed-in person: the real value wins over whatever was sent.
      const locked = f.prefill?.lock ? prefillValue(f, ctx) : undefined;
      if (locked !== undefined) values[f.name] = locked;
    }

    // 4. CAPTCHA before any heavier work (bots stop here). Trusted callers have no widget to solve.
    const captchaField = def.fields.find((f) => f.type === 'CAPTCHA');
    if (!opts.trusted) await this.captcha.verify(def, captchaField ? values[captchaField.name] : undefined, ip);

    // 5. The same validation the browser ran: required, lengths, patterns, options, conditional rules.
    const checked = opts.trusted ? { ...def, fields: def.fields.filter((f) => f.type !== 'CAPTCHA') } : def;
    const result = buildZodSchema(localize(checked, language), ctx).safeParse(values);
    if (!result.success) {
      // A mistake in a repeating section's row is reported at `section.row.field`.
      throw reject(result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
    }

    // 6. Options that come from data sources must be real options for the chosen parents.
    // Calculated fields are the server's as well: whatever was sent for them is replaced here,
    // so the option checks, the stored record, assignment and automations all see the real value.
    const computed = computeFormState(def, values, ctx);
    Object.assign(values, computed.values);
    const states = computed.states;
    const optionIssues: { field: string; message: string }[] = [];
    for (const f of def.fields) {
      const api = f.dataSource?.type === 'API' ? f.dataSource.api : undefined;
      if (!api || !states.get(f.name)?.visible || isEmptyValue(values[f.name])) continue;
      const { params, unresolved } = resolveParams(api.params, values, ctx);
      const rows = unresolved.length ? [] : await this.master.queryDataSource(orgId, api.url, params, user).catch(() => []);
      const allowed = new Set(rows.map((r) => String(r[api.valueField] ?? '')));
      const chosen = Array.isArray(values[f.name]) ? (values[f.name] as unknown[]) : [values[f.name]];
      if (!chosen.every((v) => allowed.has(String(v)))) optionIssues.push({ field: f.name, message: say('option') });
    }
    if (optionIssues.length) throw reject(optionIssues);

    // 6b. The organisation's own checks (its extension), once everything the form itself can judge has passed.
    if (def.submitChecks?.length) {
      const objection = await this.extensions.runChecks(orgId, def, values);
      if (objection) throw reject(objection.errors, objection.message || 'Please check the form');
    }

    // 7. Files: every reference must be a verified upload for this form + field.
    const pendingFiles: FormUpload[] = [];
    for (const f of def.fields) {
      if (f.type !== 'FILE' || !states.get(f.name)?.visible) continue;
      const refs = (values[f.name] as { uploadId: string }[] | undefined) ?? [];
      if (refs.length) pendingFiles.push(...(await this.uploads.checkAttachable(orgId, def, f.name, refs.map((r) => r.uploadId))));
    }

    // 8. Store as a record: reference number, first status, assignee, SLA. Captcha tokens are never kept.
    const payload = buildPayload(def, values, ctx);
    if (captchaField) delete payload[captchaField.name];
    const uuid = uuidv4();
    const state = await this.records.initialState(def, orgId, values);
    let doc: FormSubmissionDocument;
    try {
      doc = await this.submissions.create({
        ...state,
        uuid,
        orgId,
        businessId: def.businessId,
        formCode: def.code,
        formVersion: def.version,
        formId: def.id,
        payload,
        files: [],
        submittedBy: user?.uuid ?? '',
        requesterEmail: (await this.records.contactEmail(orgId, { payload, submittedBy: user?.uuid ?? '' }, def)).toLowerCase(),
        channel,
        language,
        source,
        idempotencyKey,
      });
    } catch (e) {
      // Two concurrent submits with the same key: the other one won.
      if ((e as { code?: number }).code === 11000 && idempotencyKey) {
        const existing = await this.submissions.findOne({ orgId, idempotencyKey }).lean();
        if (existing) return apiResponse(true, 200, 'Already submitted', { submissionId: existing.uuid, ref: existing.ref, payload: existing.payload });
      }
      throw e;
    }

    if (pendingFiles.length) {
      const files = await this.uploads.attach(uuid, pendingFiles);
      for (const f of def.fields.filter((x) => x.type === 'FILE')) {
        const mine = files.filter((x) => x.fieldName === f.name);
        if (f.name in payload) payload[f.name] = mine.map(({ name, size, contentType, uploadId }) => ({ name, size, contentType, uploadId }));
      }
      doc.set({ files, payload });
      doc.markModified('payload');
      await doc.save();
    }

    // 9. Automations run from here, after the response is on its way.
    const event: FormSubmittedEvent = {
      orgId,
      businessId: def.businessId,
      formCode: def.code,
      formVersion: def.version,
      submissionId: uuid,
      endpointId: def.submission.endpointId,
    };
    this.events.emit(FORM_SUBMITTED_EVENT, event);
    this.logger.log(`submission ${uuid} form=${def.code} v${def.version} org=${orgId} by=${user?.uuid ?? 'anonymous'} channel=${channel}`);

    return apiResponse(true, 201, def.submission.success?.message ?? 'Submitted', { submissionId: uuid, ref: state.ref ?? '', payload });
  }

  /** Newest first, paginated, org-scoped. */
  async list(orgId: string, code: string, page = 1, limit = 20) {
    if (!/^[A-Z0-9_]{1,100}$/.test(code)) throw new BadRequestException('Invalid form code');
    const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), 100);
    const safePage = Math.max(1, Math.floor(page) || 1);
    const filter = { orgId, formCode: code, isDeleted: false };
    const [rows, total] = await Promise.all([
      this.submissions
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((safePage - 1) * safeLimit)
        .limit(safeLimit)
        .select('-_id -__v -idempotencyKey -files.key')
        .lean(),
      this.submissions.countDocuments(filter),
    ]);
    return apiResponse(true, 200, 'Submissions fetched', { rows, total, page: safePage, limit: safeLimit });
  }

  /** A short-lived download link for one attachment, org-scoped. */
  /** `formCode` narrows it to one form's submissions (the Submissions page). */
  async fileLink(orgId: string, submissionId: string, uploadId: string, formCode?: string) {
    const doc = await this.submissions.findOne({ uuid: submissionId, orgId, isDeleted: false, ...(formCode ? { formCode } : {}) }).lean();
    const file = doc?.files.find((f) => f.uploadId === uploadId);
    if (!file) throw new NotFoundException('File not found');
    return apiResponse(true, 200, 'Link created', { url: await this.uploads.downloadUrl(file.key, file.name) });
  }
}
