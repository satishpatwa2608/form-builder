import { hashToken, randomToken } from '../../common/crypto';

/** How long a link in an approval email can be used. */
export const APPROVAL_KEY_DAYS = 7;
export const APPROVAL_KEY = /^fbap_[A-Za-z0-9_-]{20,200}$/;

/**
 * One private key per approver, for the link in their email. What is stored is the hash; the key itself exists
 * only in the email. `raw` is by user id, for the mail; `stored` goes on the approval.
 */
export function approvalKeys(approvers: string[], now = new Date()) {
  const raw: Record<string, string> = {};
  const stored: { userId: string; hash: string }[] = [];
  for (const userId of approvers) {
    const key = `fbap_${randomToken()}`;
    raw[userId] = key;
    stored.push({ userId, hash: hashToken(key) });
  }
  return { raw, stored, until: new Date(now.getTime() + APPROVAL_KEY_DAYS * 86_400_000) };
}
