import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { FormDefinition } from '@fb/engine';
import type { Model } from 'mongoose';
import { hashToken, randomToken } from '../common/crypto';
import { checkSubmissionShape } from '../forms/payload-guard';
import type { OptionalUser } from '../work/services/form-context.service';
import { FormDraft, type FormDraftDocument } from './draft.schema';

export const DRAFT_TTL_DAYS = 30;
const TOKEN = /^fbd_[A-Za-z0-9_-]{20,100}$/;

@Injectable()
export class DraftsService {
  constructor(@InjectModel(FormDraft.name) private readonly drafts: Model<FormDraftDocument>) {}

  private static owner(def: FormDefinition, user: OptionalUser | undefined) {
    return def.access === 'AUTHENTICATED' ? (user?.uuid ?? '') : '';
  }

  /**
   * Save the values so far; same shape checks as a submission. Every save gets
   * a fresh token and retires the one sent (if any), so a token someone else
   * planted in a link can't be used to read what the respondent saves next.
   */
  async save(orgId: string, def: FormDefinition, values: unknown, token: string | undefined, user: OptionalUser | undefined) {
    const issues = checkSubmissionShape(def, values);
    if (issues.length) throw new BadRequestException({ message: 'Some answers could not be saved', errors: issues });
    const expiresAt = new Date(Date.now() + DRAFT_TTL_DAYS * 86_400_000);
    const userId = DraftsService.owner(def, user);
    if (token && TOKEN.test(token)) await this.drafts.deleteOne({ tokenHash: hashToken(token), orgId, code: def.code, userId });
    const fresh = `fbd_${randomToken()}`;
    await this.drafts.create({ tokenHash: hashToken(fresh), orgId, code: def.code, userId, values: values as Record<string, unknown>, expiresAt });
    return { token: fresh, expiresAt };
  }

  async load(orgId: string, def: FormDefinition, token: string, user: OptionalUser | undefined) {
    const row = TOKEN.test(token) ? await this.drafts.findOne({ tokenHash: hashToken(token), orgId, code: def.code, userId: DraftsService.owner(def, user), expiresAt: { $gt: new Date() } }).lean() : null;
    if (!row) throw new NotFoundException('Saved answers not found. They may have expired or already been submitted.');
    // Only fields the current version still has (the form may have changed since).
    const keep = new Set(def.fields.map((f) => f.name));
    return { values: Object.fromEntries(Object.entries(row.values).filter(([k]) => keep.has(k))), savedAt: row.updatedAt, expiresAt: row.expiresAt };
  }

  async discard(orgId: string, code: string, token: string) {
    if (TOKEN.test(token)) await this.drafts.deleteOne({ tokenHash: hashToken(token), orgId, code });
  }
}
