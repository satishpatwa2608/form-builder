/**
 * What each plan allows. `null` = unlimited.
 *
 * PLACEHOLDER NUMBERS: pricing and packaging are a business decision still to
 * be made. Change them here only; everything else reads this table.
 */
export const PLAN_IDS = ['FREE', 'TEAM', 'BUSINESS', 'ENTERPRISE'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** Forms (distinct codes, any status). */
  forms: number | null;
  /** Public submissions per calendar month (UTC). */
  submissionsPerMonth: number | null;
  /** Active members plus pending invitations. */
  members: number | null;
  connectors: number | null;
  gateways: number | null;
  customDomains: number | null;
  /** The organisation's own code, each in a container we run (docs/extensions.md). */
  extensions: number | null;
  /** Hide "Powered by Form Builder" on public forms. */
  removeBranding: boolean;
  sso: boolean;
}

export const PLANS: Record<PlanId, { name: string; limits: PlanLimits }> = {
  FREE: { name: 'Free', limits: { forms: 3, submissionsPerMonth: 100, members: 2, connectors: 0, gateways: 0, customDomains: 0, extensions: 0, removeBranding: false, sso: false } },
  TEAM: { name: 'Team', limits: { forms: 25, submissionsPerMonth: 2_000, members: 10, connectors: 3, gateways: 1, customDomains: 1, extensions: 0, removeBranding: true, sso: false } },
  BUSINESS: { name: 'Business', limits: { forms: 200, submissionsPerMonth: 25_000, members: 50, connectors: 20, gateways: 5, customDomains: 5, extensions: 1, removeBranding: true, sso: true } },
  ENTERPRISE: { name: 'Enterprise', limits: { forms: null, submissionsPerMonth: null, members: null, connectors: null, gateways: null, customDomains: null, extensions: null, removeBranding: true, sso: true } },
};

export type CountedResource = 'forms' | 'members' | 'connectors' | 'gateways' | 'customDomains' | 'extensions';
