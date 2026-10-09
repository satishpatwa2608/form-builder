import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { User, type UserDocument } from '../auth/auth.schemas';
import { newId } from '../common/crypto';
import { MAILER, type Mailer } from '../common/mailer';
import { APP_CONFIG, type AppConfig } from '../config';
import { Organization, type OrganizationDocument } from '../orgs/org.schemas';
import { FormComment, type FormCommentDocument } from './form-comment.schema';
import { Form, type FormDocument } from './form.schema';
import { definitionHash, NO_REVIEW, reviewOf, type FormReview } from './form-review';
import { FormsService } from './forms.service';

const MAX_OPEN_COMMENTS = 200;

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Review before publish: a designer asks, someone who may publish approves
 * or asks for changes, and both leave comments on the form or its fields.
 * An organisation can make approval a condition of publishing; then the one
 * who approves must be someone other than the one who asked or last edited.
 */
@Injectable()
export class FormReviewService {
  private readonly logger = new Logger(FormReviewService.name);

  constructor(
    private readonly formsService: FormsService,
    private readonly audit: AuditService,
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
    @InjectModel(FormComment.name) private readonly comments: Model<FormCommentDocument>,
    @InjectModel(Organization.name) private readonly orgs: Model<OrganizationDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async required(orgId: string): Promise<boolean> {
    const org = await this.orgs.findOne({ id: orgId }).select('security').lean();
    return !!(org as { security?: { requireReview?: boolean } } | null)?.security?.requireReview;
  }

  private async draft(auth: AuthContext, id: string, permission: 'form.view' | 'form.edit' | 'form.publish') {
    const row = await this.formsService.access(auth, id, permission);
    if (row.status !== 'DRAFT') throw new ConflictException('Only a draft is reviewed. Start a new version to change this form.');
    return row;
  }

  private async names(ids: string[]): Promise<Map<string, string>> {
    const rows = await this.users.find({ id: { $in: [...new Set(ids.filter(Boolean))] } }).select('id name').lean();
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  /** Everything the builder shows about a draft's review. */
  async get(auth: AuthContext, id: string) {
    const row = await this.formsService.access(auth, id, 'form.view');
    const review = reviewOf(row);
    const comments = await this.comments.find({ orgId: auth.orgId, formId: row.id }).sort({ createdAt: 1 }).lean();
    const names = await this.names([review.requestedBy, review.decidedBy, ...comments.flatMap((c) => [c.authorId, c.resolvedBy])]);
    const person = (userId: string) => (userId ? { id: userId, name: names.get(userId) ?? 'Someone who has left' } : null);
    const perms = await this.formsService.permissionsOn(auth, row);
    const required = await this.required(auth.orgId);
    const draft = row.status === 'DRAFT';
    const own = review.requestedBy === auth.userId || row.updatedBy === auth.userId;
    return {
      required,
      review: {
        status: review.status,
        requestedBy: person(review.requestedBy),
        requestedAt: review.requestedAt,
        note: review.note,
        decidedBy: person(review.decidedBy),
        decidedAt: review.decidedAt,
        decisionNote: review.decisionNote,
        /** Approved, but the draft has been changed since. */
        stale: review.status === 'APPROVED' && review.hash !== definitionHash(row.definition),
      },
      comments: comments.map((c) => ({ id: c.id, fieldId: c.fieldId, fieldLabel: c.fieldLabel, text: c.text, author: person(c.authorId), createdAt: c.createdAt, resolvedAt: c.resolvedAt, resolvedBy: person(c.resolvedBy) })),
      can: {
        request: draft && perms.includes('form.edit') && review.status !== 'REQUESTED',
        decide: draft && perms.includes('form.publish') && review.status === 'REQUESTED' && !(required && own),
        /** Shown instead of the buttons, so the reason is not a mystery. */
        decideBlocked: draft && perms.includes('form.publish') && review.status === 'REQUESTED' && required && own ? 'Someone other than the person who asked for the review, or last changed the form, must decide.' : '',
        comment: draft && (perms.includes('form.edit') || perms.includes('form.publish')),
      },
    };
  }

  /**
   * Tells people by email that a review needs them, or has been decided. Never the reason an
   * action fails: the review itself is already recorded, and the Forms list shows it.
   */
  private async tell(userIds: string[], row: Pick<Form, 'id' | 'name' | 'code' | 'version'>, subject: string, lines: string[]) {
    try {
      const people = await this.users.find({ id: { $in: [...new Set(userIds.filter(Boolean))] } }).select('email name').lean();
      const link = `${this.config.APP_URL}/forms/${row.id}/edit`;
      for (const p of people) {
        // A subject is one line, whatever a form is called.
        await this.mailer.send({ to: p.email, subject: subject.replace(/[\r\n]+/g, ' ').slice(0, 200), text: [`Hello ${p.name || ''},`.replace(' ,', ','), '', ...lines, '', `Open it: ${link}`].join('\n') });
      }
    } catch (e) {
      this.logger.warn(`could not send review mail for ${row.code} v${row.version}: ${(e as Error).name}`);
    }
  }

  private async setReview(row: FormDocument, review: FormReview) {
    row.set({ review });
    row.markModified('review');
    // Saving the review must not look like an edit of the form.
    await this.forms.updateOne({ id: row.id }, { $set: { review } }, { timestamps: false });
  }

  async request(auth: AuthContext, id: string, body: unknown) {
    const row = await this.draft(auth, id, 'form.edit');
    if (reviewOf(row).status === 'REQUESTED') throw new ConflictException('A review has already been asked for');
    await this.setReview(row, { ...NO_REVIEW, status: 'REQUESTED', requestedBy: auth.userId, requestedAt: new Date(), note: clean((body as { note?: unknown })?.note, 1000) });
    await this.audit.record(actorOf(auth), { action: 'form.review_requested', targetType: 'form', targetId: row.id, after: { code: row.code, version: row.version } });
    // Everyone who could approve it, except the one asking.
    const note = clean((body as { note?: unknown })?.note, 1000);
    const who = (await this.names([auth.userId])).get(auth.userId) ?? 'A colleague';
    const reviewers = (await this.formsService.membersWho(row, 'form.publish')).filter((id) => id !== auth.userId);
    await this.tell(reviewers, row, `Review requested: ${row.name}`, [`${who} asked for a review of "${row.name}" (${row.code}, version ${row.version}) before it is published.`, ...(note ? ['', `Their note: ${note}`] : [])]);
    return this.get(auth, id);
  }

  async cancel(auth: AuthContext, id: string) {
    const row = await this.draft(auth, id, 'form.edit');
    if (reviewOf(row).status !== 'REQUESTED') throw new ConflictException('No review is waiting');
    await this.setReview(row, { ...NO_REVIEW });
    await this.audit.record(actorOf(auth), { action: 'form.review_cancelled', targetType: 'form', targetId: row.id, after: { code: row.code, version: row.version } });
    return this.get(auth, id);
  }

  async decide(auth: AuthContext, id: string, decision: 'APPROVED' | 'CHANGES_REQUESTED', body: unknown) {
    const row = await this.draft(auth, id, 'form.publish');
    const review = reviewOf(row);
    if (review.status !== 'REQUESTED') throw new ConflictException('No review is waiting for a decision');
    const note = clean((body as { note?: unknown })?.note, 1000);
    if (decision === 'CHANGES_REQUESTED' && !note) throw new BadRequestException('Say what needs to change');
    // Four eyes, where the organisation has asked for them.
    if ((await this.required(auth.orgId)) && (review.requestedBy === auth.userId || row.updatedBy === auth.userId)) {
      throw new ForbiddenException('Someone other than the person who asked for the review, or last changed the form, must decide.');
    }
    await this.setReview(row, { ...review, status: decision, decidedBy: auth.userId, decidedAt: new Date(), decisionNote: note, hash: decision === 'APPROVED' ? definitionHash(row.definition) : '' });
    await this.audit.record(actorOf(auth), { action: decision === 'APPROVED' ? 'form.review_approved' : 'form.review_changes_requested', targetType: 'form', targetId: row.id, after: { code: row.code, version: row.version } });
    const who = (await this.names([auth.userId])).get(auth.userId) ?? 'The reviewer';
    await this.tell(
      [review.requestedBy].filter((id) => id !== auth.userId),
      row,
      decision === 'APPROVED' ? `Approved: ${row.name}` : `Changes asked: ${row.name}`,
      [decision === 'APPROVED' ? `${who} approved "${row.name}" (${row.code}, version ${row.version}). It can be published now.` : `${who} asked for changes to "${row.name}" (${row.code}, version ${row.version}).`, ...(note ? ['', `Their note: ${note}`] : [])],
    );
    return this.get(auth, id);
  }

  // ── Comments ─────────────────────────────────────────────────────────────

  private async commenter(auth: AuthContext, id: string) {
    const row = await this.draft(auth, id, 'form.view');
    const perms = await this.formsService.permissionsOn(auth, row);
    if (!perms.includes('form.edit') && !perms.includes('form.publish')) throw new ForbiddenException('Only people who design or publish this form comment on it');
    return row;
  }

  async addComment(auth: AuthContext, id: string, body: unknown) {
    const row = await this.commenter(auth, id);
    const text = clean((body as { text?: unknown })?.text, 2000);
    if (!text) throw new BadRequestException('Write the comment');
    const fieldId = clean((body as { fieldId?: unknown })?.fieldId, 64);
    const field = fieldId ? ((row.definition as { fields?: { id: string; label?: string; name: string }[] }).fields ?? []).find((f) => f.id === fieldId) : undefined;
    if (fieldId && !field) throw new BadRequestException('That field is not on this form');
    if ((await this.comments.countDocuments({ orgId: auth.orgId, formId: row.id, resolvedAt: null })) >= MAX_OPEN_COMMENTS) throw new ConflictException('Resolve some comments before adding more');
    await this.comments.create({ id: newId(), orgId: auth.orgId, formId: row.id, fieldId, fieldLabel: field ? field.label || field.name : '', text, authorId: auth.userId });
    return this.get(auth, id);
  }

  async resolveComment(auth: AuthContext, id: string, commentId: string, resolved: boolean) {
    const row = await this.commenter(auth, id);
    const done = await this.comments.findOneAndUpdate({ orgId: auth.orgId, formId: row.id, id: commentId }, { $set: resolved ? { resolvedAt: new Date(), resolvedBy: auth.userId } : { resolvedAt: null, resolvedBy: '' } });
    if (!done) throw new NotFoundException('Comment not found');
    return this.get(auth, id);
  }

  /** Only its author takes a comment back. */
  async removeComment(auth: AuthContext, id: string, commentId: string) {
    const row = await this.commenter(auth, id);
    const gone = await this.comments.findOneAndDelete({ orgId: auth.orgId, formId: row.id, id: commentId, authorId: auth.userId });
    if (!gone) throw new NotFoundException('Comment not found');
    return this.get(auth, id);
  }
}
