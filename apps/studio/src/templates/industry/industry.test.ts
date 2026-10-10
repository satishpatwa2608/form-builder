import { describe, expect, it } from 'vitest';
import { validateFormDefinition } from '@fb/engine';
import { INDUSTRY_TEMPLATES } from './index';

const whole = (t: (typeof INDUSTRY_TEMPLATES)[number]) => ({ businessId: '', ...t.definition, id: 'x', orgId: 'o', version: 1, status: 'DRAFT', name: t.name, code: 'T', createdBy: 'u', updatedBy: 'u' });

describe('industry templates', () => {
  it.each(INDUSTRY_TEMPLATES.map((t) => [t.key, t] as const))('%s can be published as it comes', (_key, t) => {
    const result = validateFormDefinition(whole(t));
    expect(result.success ? [] : result.issues.map((i) => `${i.path}: ${i.message}`)).toEqual([]);
  });
});

// ── The forms at work: what they calculate, show and refuse ──────────────────
import { buildSteps, buildZodSchema, computeFormState, descendantFields, isValueField } from '@fb/engine';
import type { FormField, FormRule } from '@fb/engine';

const NOW = new Date('2026-10-10T06:00:00Z');
const form = (key: string) => {
  const t = INDUSTRY_TEMPLATES.find((x) => x.key === key)!;
  return { fields: t.definition.fields as FormField[], rules: (t.definition.rules ?? []) as FormRule[] };
};
const state = (key: string, values: Record<string, unknown>) => computeFormState(form(key), values, { now: NOW });
const refused = (key: string, values: Record<string, unknown>) => {
  const result = buildZodSchema(form(key), { now: NOW }).safeParse(values);
  return result.success ? {} : Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
};

describe('industry templates at work', () => {
  it('between them they use every kind of field there is (but the one that needs an extension)', () => {
    const used = new Set(INDUSTRY_TEMPLATES.flatMap((t) => (t.definition.fields as FormField[]).map((f) => f.type)));
    const all = ['TEXT', 'TEXTAREA', 'NUMBER', 'EMAIL', 'PHONE', 'DATE', 'DATETIME', 'TIME', 'MONTH', 'URL', 'COLOR', 'SLIDER', 'CHECKBOX', 'RADIO', 'DROPDOWN', 'MULTI_SELECT', 'FILE', 'HIDDEN', 'HTML', 'BUTTON', 'CAPTCHA', 'SWITCH', 'CHECKBOX_GROUP', 'STEPPER', 'SIGNATURE', 'CONSENT', 'IMAGE', 'COLUMNS', 'SECTION', 'TABS', 'ACCORDION', 'REPEAT'];
    expect(all.filter((t) => !used.has(t as FormField['type']))).toEqual([]);
  });

  it('every one is laid out in steps, with a last look before sending, and has several', () => {
    for (const t of INDUSTRY_TEMPLATES) {
      expect(t.definition.layout, t.key).toEqual({ mode: 'steps', review: true });
      const steps = (t.definition.fields as FormField[]).filter((f) => f.type === 'SECTION' && !f.parentId);
      expect(steps.length, t.key).toBeGreaterThanOrEqual(4);
    }
  });

  it('no step is empty: each has something for the person to see or fill in', () => {
    for (const t of INDUSTRY_TEMPLATES) {
      const fields = t.definition.fields as FormField[];
      for (const step of buildSteps(fields)) {
        const inside = step.items.flatMap((item) => [item, ...descendantFields(fields, item.id)]);
        expect(inside.some((f) => f.type !== 'HIDDEN' && (isValueField(f) || f.type === 'HTML')), `${t.key}: ${step.title}`).toBe(true);
        expect(step.section, `${t.key}: a step made of loose fields ("${step.title}")`).toBeDefined();
      }
    }
  });

  it('car insurance: the insured value falls with age, a claim loses the bonus, and the premium follows', () => {
    const base = { proposalFor: 'RENEWAL', policyType: 'COMPREHENSIVE', exShowroom: 1_000_000, idvPercent: 90, regDate: '2023-10-01', engineCc: 1197, addOns: ['ZERO_DEP', 'RSA'], ownerPa: true, ncb: '20', claimed: 'NO', make: 'TATA' };
    const s = state('ins-car', base);
    expect(s.values).toMatchObject({ carAge: 3, idv: 684_000 });
    // (2.5% of the value + third party for 1001-1500 cc + two add-ons + owner cover) less a 20% bonus.
    expect(s.values.premiumEstimate).toBe(Math.round((684_000 * 0.025 + 3416 + 2 * 684_000 * 0.003 + 750) * 0.8));
    const claimed = state('ins-car', { ...base, claimed: 'YES', ncb: '50' });
    expect(claimed.values.ncb).toBe('0');
    expect(claimed.values.premiumEstimate).toBeGreaterThan(s.values.premiumEstimate as number);
    expect(refused('ins-car', { ...base, policyStart: '2026-10-01' }).policyStart).toBe('Cover cannot start in the past');
    expect(refused('ins-car', { ...base, ownerType: 'PERSON', dob: '2012-01-01' }).dob).toBe('The owner must be 18 or older');
  });

  it('health claim: counts the days, and refuses a stay that ends before it starts or a late claim', () => {
    expect(state('ins-health-claim', { admittedAt: '2026-10-01T09:00', dischargedAt: '2026-10-05T11:00' }).values.daysInHospital).toBe(4);
    // The total is added up from the bills, not typed.
    expect(state('ins-health-claim', { expenses: [{ billAmount: 42_000 }, { billAmount: 8_500.5 }, { billAmount: 1_200 }] }).values).toMatchObject({ amountClaimed: 51_700.5, billCount: 3 });
    expect(refused('ins-health-claim', { admittedAt: '2026-10-05T09:00', dischargedAt: '2026-10-01T09:00' }).dischargedAt).toBe('Discharge cannot be before admission');
    expect(refused('ins-health-claim', { admittedAt: '2026-08-01T09:00', dischargedAt: '2026-08-03T09:00' }).dischargedAt).toMatch(/within 30 days/);
  });

  it('health proposal: each person gets their own body-mass index', () => {
    const s = state('ins-health', { insured: [{ heightCm: 170, weightKg: 70 }, { heightCm: 155, weightKg: 82 }] });
    expect((s.values.insured as { bmi: number }[]).map((m) => m.bmi)).toEqual([24.2, 34.1]);
  });

  it('hospital: works out the age, and a child brings the guardian and a deposit follows the room', () => {
    const child = state('care-hospital', { dob: '2019-03-01', visitType: 'ADMISSION', payer: 'SELF', roomChoice: 'PRIVATE', expectedDays: 3 });
    expect(child.values).toMatchObject({ age: 7, deposit: 24_000 });
    const adult = state('care-hospital', { dob: '1980-03-01', visitType: 'OPD', payer: 'SELF' });
    expect(adult.values).toMatchObject({ age: 46, deposit: 0 });
    expect(refused('care-hospital', { dob: '2019-03-01' }).guardianName).toBeTruthy();
    expect(refused('care-hospital', { dob: '1980-03-01' }).guardianName).toBeUndefined();
  });

  it('school: the age on 1 June decides who may join a class', () => {
    expect(state('edu-school', { childDob: '2021-08-15', academicYear: '2027' }).values.ageOnJune1).toBe(5);
    expect(refused('edu-school', { childDob: '2021-08-15', academicYear: '2027', applyingFor: 'C1' }).childDob).toBe('A child must be 6 by 1 June to join Class 1');
    expect(refused('edu-school', { childDob: '2021-05-15', academicYear: '2027', applyingFor: 'C1' }).childDob).toBeUndefined();
  });

  it('university: the fee depends on who applies and for what, and an MBA needs experience', () => {
    expect(state('edu-university', { residency: 'INDIAN', level: 'PG', category: 'GENERAL' }).values.applicationFee).toBe(1800);
    expect(state('edu-university', { residency: 'INDIAN', level: 'PG', category: 'SC' }).values.applicationFee).toBe(900);
    expect(state('edu-university', { residency: 'FOREIGN', level: 'UG', category: 'GENERAL' }).values.applicationFee).toBe(6000);
    expect(refused('edu-university', { programmeChoice: 'MBA', experienceMonths: 10 }).experienceMonths).toMatch(/24 months/);
  });

  it('loan: the instalment and the share of income, and a home loan keeps to 80% of the price', () => {
    const s = state('bank-loan', { loanType: 'HOME', amount: 4_000_000, termMonths: 240, monthlyIncome: 150_000, otherIncome: 0, existingLoans: [{ monthlyPayment: 6_000 }, { monthlyPayment: 4_000 }], dob: '1990-01-01' });
    // ₹40 lakh over 20 years at 8.6%: the instalment any loan calculator gives.
    const r = 8.6 / 1200;
    const emi = Math.round((4_000_000 * r * Math.pow(1 + r, 240)) / (Math.pow(1 + r, 240) - 1));
    expect(emi).toBe(34_967);
    expect(s.values).toMatchObject({ ratePercent: 8.6, instalment: emi, totalPayable: emi * 240, existingPayments: 10_000 });
    expect(s.values.burden).toBe(Math.round(((emi + 10_000) / 150_000) * 100));
    expect(refused('bank-loan', { loanType: 'HOME', amount: 4_000_000, propertyValue: 4_500_000, termMonths: 240 }).amount).toMatch(/80%/);
    expect(refused('bank-loan', { loanType: 'PERSONAL', amount: 500_000, termMonths: 120 }).termMonths).toMatch(/84 months/);
  });

  it('trade licence: the fee comes from the area, the trade and the years; a late renewal costs a quarter more', () => {
    expect(state('gov-trade-licence', { tradeGroup: 'FOOD', areaSqFt: 800, years: '3', applicationType: 'NEW' }).values).toMatchObject({ fee: 12_000, lateFee: 0, servesFood: 'YES' });
    expect(state('gov-trade-licence', { tradeGroup: 'RETAIL', areaSqFt: 100, years: '1', applicationType: 'RENEWAL', validUntil: '2026-09-01' }).values).toMatchObject({ fee: 500, lateFee: 125 });
  });

  it('bank account: an adult for an ordinary account, a child for a child\'s, and a floor for a current account', () => {
    expect(refused('bank-account', { accountType: 'SAVINGS', dob: '2015-01-01' }).dob).toMatch(/18 or older/);
    expect(refused('bank-account', { accountType: 'MINOR', dob: '1990-01-01' }).dob).toBe('This account is for someone under 18');
    expect(refused('bank-account', { accountType: 'CURRENT', firstDeposit: 5000, dob: '1990-01-01' }).firstDeposit).toMatch(/10,000/);
  });
});
