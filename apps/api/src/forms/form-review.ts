import { createHash } from 'node:crypto';

/**
 * What review before publish needs to know about a draft, with no service behind it,
 * so both the forms service and the review service can use it.
 */
export type ReviewStatus = 'NONE' | 'REQUESTED' | 'CHANGES_REQUESTED' | 'APPROVED';

/** Where a draft stands with its reviewers. Kept on the draft; a new version starts without one. */
export interface FormReview {
  status: ReviewStatus;
  requestedBy: string;
  requestedAt: Date | null;
  /** What the requester asked the reviewer to look at. */
  note: string;
  decidedBy: string;
  decidedAt: Date | null;
  /** What the reviewer said. */
  decisionNote: string;
  /** What was approved: an approval stands only for exactly this content. */
  hash: string;
}

export const NO_REVIEW: FormReview = { status: 'NONE', requestedBy: '', requestedAt: null, note: '', decidedBy: '', decidedAt: null, decisionNote: '', hash: '' };

/** A fingerprint of what a draft says, ignoring who saved it and when. */
export function definitionHash(definition: Record<string, unknown>): string {
  const { updatedAt: _at, updatedBy: _by, createdBy: _c, status: _s, ...content } = definition;
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(content))).digest('hex');
}

export const reviewOf = (row: { review?: Partial<FormReview> | null }): FormReview => ({ ...NO_REVIEW, ...(row.review ?? {}) });

/** Whether a draft may be published as it stands, when the organisation requires review. Empty when it may. */
export function reviewRefusal(row: { review?: Partial<FormReview> | null; definition: Record<string, unknown> }): string {
  const review = reviewOf(row);
  if (review.status === 'APPROVED' && review.hash === definitionHash(row.definition)) return '';
  if (review.status === 'APPROVED') return 'This form was changed after it was approved. Ask for a review again.';
  if (review.status === 'REQUESTED') return 'This form is waiting for its review. It can be published once a reviewer approves it.';
  if (review.status === 'CHANGES_REQUESTED') return 'The reviewer asked for changes. Make them, then ask for a review again.';
  return 'Your organisation requires a review before a form is published. Ask for a review.';
}
