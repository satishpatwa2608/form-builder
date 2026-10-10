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
      // A last look before sending, except on the one-minute report where it would only slow the person down.
      expect(t.definition.layout, t.key).toEqual({ mode: 'steps', review: t.key !== 'energy-supply-complaint' });
      const steps = (t.definition.fields as FormField[]).filter((f) => f.type === 'SECTION' && !f.parentId);
      expect(steps.length, t.key).toBeGreaterThanOrEqual(3);
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

  it('vehicle registration: tax by price and kind, none for electric, and the fees added', () => {
    const car = state('gov-vehicle-registration', { vehicleClass: 'CAR', price: 1_200_000, fuel: 'PETROL', ownerType: 'PERSON', hsrp: true, numberChoice: 'FANCY', financed: true });
    expect(car.values).toMatchObject({ roadTax: 132_000, fees: 600 + 1100 + 5000 + 1500, totalDue: 132_000 + 8200 });
    expect(state('gov-vehicle-registration', { vehicleClass: 'SCOOTER', price: 150_000, fuel: 'ELECTRIC', ownerType: 'PERSON', hsrp: true, numberChoice: 'NEXT' }).values).toMatchObject({ roadTax: 0, fees: 750, totalDue: 750 });
    expect(refused('gov-vehicle-registration', { invoiceDate: '2026-08-01' }).invoiceDate).toMatch(/within 30 days/);
  });

  it('ownership transfer: a late application costs more, and each case asks for its own papers', () => {
    expect(state('gov-vehicle-transfer', { reason: 'SALE', vehicleClass: 'CAR', hypothecated: 'YES', soldOn: '2026-09-01' }).values.transferFee).toBe(300 + 500 + 500);
    expect(state('gov-vehicle-transfer', { reason: 'SALE', vehicleClass: 'MOTORCYCLE', hypothecated: 'NO', soldOn: '2026-10-05' }).values.transferFee).toBe(150);
    expect(refused('gov-vehicle-transfer', { reason: 'DEATH' }).deathCertificate).toBeTruthy();
    expect(refused('gov-vehicle-transfer', { reason: 'SALE' }).deathCertificate).toBeUndefined();
  });

  it('driving licence: the age for each class of vehicle', () => {
    expect(refused('gov-driving-licence', { dob: '2010-01-01', classes: ['MCWOG'] }).dob).toBeUndefined();
    expect(refused('gov-driving-licence', { dob: '2010-01-01', classes: ['LMV'] }).classes).toMatch(/Under 18/);
    expect(refused('gov-driving-licence', { dob: '2007-06-01', classes: ['TRANSPORT'] }).classes).toMatch(/20 or older/);
    expect(state('gov-driving-licence', { service: 'PERMANENT', classes: ['MCWG', 'LMV'] }).values.fee).toBe(800);
  });

  it('electricity connection: the load is added up from the appliances, and decides the phase and the charges', () => {
    const home = state('energy-new-connection', { category: 'DOMESTIC', prepaid: false, appliances: [{ count: 10, watts: 60 }, { count: 2, watts: 1500 }, { count: 1, watts: 2000 }] });
    expect((home.values.appliances as { lineWatts: number }[]).map((a) => a.lineWatts)).toEqual([600, 3000, 2000]);
    expect(home.values).toMatchObject({ loadKw: 5.6, phase: 'Single phase', serviceCharge: 1500 + Math.round(4.6 * 900), deposit: Math.round(5.6 * 600) });
    const factory = state('energy-new-connection', { category: 'INDUSTRIAL', prepaid: true, appliances: [{ count: 4, watts: 15000 }] });
    expect(factory.values).toMatchObject({ loadKw: 60, phase: 'High tension', deposit: 0 });
  });

  it('rooftop solar: no larger than the sanctioned load or the roof allows', () => {
    expect(refused('energy-rooftop-solar', { plantKw: 8, sanctionedKw: 5, roofSqFt: 1000 }).plantKw).toMatch(/sanctioned load/);
    expect(refused('energy-rooftop-solar', { plantKw: 5, sanctionedKw: 5, roofSqFt: 300 }).roofSqFt).toMatch(/100 sq ft/);
    expect(state('energy-rooftop-solar', { plantKw: 5 }).values).toMatchObject({ unitsPerYear: 5840, fee: 500 });
  });

  it('money transfer: each route has its limits, and the two account numbers must agree', () => {
    expect(refused('bank-fund-transfer', { mode: 'RTGS', amount: 50_000 }).amount).toMatch(/2,00,000/);
    expect(refused('bank-fund-transfer', { mode: 'IMPS', amount: 600_000 }).amount).toMatch(/5,00,000/);
    expect(refused('bank-fund-transfer', { mode: 'SWIFT', currency: 'USD', amount: 100_000, sentThisYear: 200_000 }).amount).toMatch(/250,000/);
    expect(refused('bank-fund-transfer', { payeeAccount: '123456789', payeeAccountAgain: '123456780' }).payeeAccountAgain).toBe('The two account numbers are not the same');
    expect(state('bank-fund-transfer', { mode: 'NEFT', amount: 150_000, currency: 'USD' }).values).toMatchObject({ charges: 15, currency: 'INR' });
  });

  it('credit card: an indicative limit, and each card has its income', () => {
    expect(state('bank-credit-card', { yearlyIncome: 1_800_000 }).values.indicativeLimit).toBe(450_000);
    expect(refused('bank-credit-card', { cardChoice: 'TRAVEL', yearlyIncome: 900_000 }).cardChoice).toMatch(/12 lakh/);
    expect(refused('bank-credit-card', { cardChoice: 'REWARDS', yearlyIncome: 900_000 }).cardChoice).toBeUndefined();
  });

  it('card dispute: the total is added up, and a card used without its owner is blocked', () => {
    const s = state('bank-card-dispute', { reason: 'FRAUD', blockCard: false, items: [{ txnAmount: 4999 }, { txnAmount: 12000 }] });
    expect(s.values).toMatchObject({ disputedTotal: 16_999, blockCard: true });
  });

  it('farm subsidy: land is added up, the farmer is classed, and the subsidy keeps to its ceiling', () => {
    const s = state('gov-farm-subsidy', { plots: [{ areaAcres: 1.5 }, { areaAcres: 2 }], category: 'GENERAL', scheme: 'DRIP', cost: 200_000 });
    expect(s.values).toMatchObject({ totalAcres: 3.5, farmerClass: 'Small', subsidy: 60_000 });
    expect(state('gov-farm-subsidy', { plots: [{ areaAcres: 12 }], category: 'GENERAL', scheme: 'MACHINERY', cost: 100_000 }).values).toMatchObject({ farmerClass: 'Other', subsidy: 40_000 });
  });

  it('job application: the joining date follows the notice period, and the rise asked for is worked out', () => {
    const s = state('hire-job-application', { fresher: 'NO', notice: '30', currentPay: 1_000_000, expectedPay: 1_300_000 });
    expect(s.values).toMatchObject({ rise: 30, canJoinOn: '2026-11-09' });
    expect(refused('hire-job-application', { position: 'SALES_MANAGER', fresher: 'NO', experienceYears: 3 }).position).toMatch(/five years/);
  });

  it('expense claim: bills and mileage, less the advance', () => {
    const s = state('hr-expense-claim', { lines: [{ billAmount: 4200 }, { billAmount: 1800.5 }], kilometres: 120, ownVehicle: 'CAR', advance: 5000 });
    expect(s.values).toMatchObject({ billsTotal: 6000.5, mileage: 1440, amountDue: 2440.5 });
  });

  it('access request: the risk follows the level and who it is for', () => {
    expect(state('it-access-request', { system: 'ERP', level: 'APPROVER', staffType: 'AN_EMPLOYEE' }).values.risk).toBe('High');
    expect(state('it-access-request', { system: 'CRM', level: 'VIEWER', staffType: 'A_VENDOR' }).values).toMatchObject({ risk: 'Medium', temporary: true });
    expect(state('it-access-request', { system: 'CRM', level: 'VIEWER', staffType: 'AN_EMPLOYEE' }).values.risk).toBe('Low');
  });

  it('rental application: the rent against income, with a guarantor counted', () => {
    expect(state('property-rental-application', { monthlyRent: 30_000, monthlyIncome: 60_000, furnishing: 'FURNISHED' }).values).toMatchObject({ rentShare: 50, deposit: 90_000 });
    expect(refused('property-rental-application', { monthlyRent: 30_000, monthlyIncome: 60_000 }).monthlyIncome).toMatch(/40%/);
    expect(refused('property-rental-application', { monthlyRent: 30_000, monthlyIncome: 60_000, hasGuarantor: true, guarantorIncome: 40_000 }).monthlyIncome).toBeUndefined();
  });

  it('visa: the fee by kind, entries and speed, and a passport that lasts', () => {
    expect(state('travel-visa-application', { visaType: 'TOURIST', entries: 'MULTIPLE', express: true, arrival: '2026-12-01', departure: '2026-12-15' }).values).toMatchObject({ stayDays: 14, visaFee: 24_000 });
    expect(refused('travel-visa-application', { arrival: '2026-12-01', departure: '2026-12-15', expiresOn: '2027-03-01' }).expiresOn).toMatch(/six months/);
    expect(refused('travel-visa-application', { visaType: 'TOURIST', arrival: '2026-12-01', departure: '2027-04-01', expiresOn: '2030-01-01' }).departure).toMatch(/90 days/);
  });

  it('conference: passes for everyone, a group discount, a code and tax', () => {
    const people = Array.from({ length: 5 }, (_, i) => ({ attendeeName: `Person ${i + 1}` }));
    const s = state('event-registration', { passType: 'FULL', attendees: people, workshops: ['AI'], dinner: true, promoCode: ' early10 ' });
    const subtotal = 5 * (12_000 + 2000 + 1500);
    expect(s.values).toMatchObject({ headcount: 5, subtotal, discount: Math.round(subtotal * 0.2), tax: Math.round(subtotal * 0.8 * 0.18) });
    expect(s.values.totalDue).toBe(subtotal - Math.round(subtotal * 0.2) + Math.round(subtotal * 0.8 * 0.18));
    expect(refused('event-registration', { promoCode: 'FREE' }).promoCode).toBe('This code is not valid');
  });

  it('warranty: in or out by the kind of product, and a refund only at first', () => {
    expect(state('retail-warranty-claim', { productType: 'ELECTRONICS', boughtOn: '2026-01-10' }).values.warrantyStatus).toBe('Under warranty');
    expect(state('retail-warranty-claim', { productType: 'ELECTRONICS', boughtOn: '2025-01-10' }).values.warrantyStatus).toMatch(/Out of warranty/);
    expect(state('retail-warranty-claim', { productType: 'ELECTRONICS', boughtOn: '2025-01-10', extended: true }).values.warrantyStatus).toBe('Under warranty');
    expect([...(state('retail-warranty-claim', { boughtOn: '2026-01-10' }).options.get('remedy') ?? [])]).toEqual(['REPAIR', 'REPLACE']);
  });

  it('shipment: charged on the heavier of real and volumetric weight', () => {
    const s = state('logistics-shipment-booking', { destination: 'DOMESTIC', speed: 'EXPRESS', declaredValue: 20_000, insure: true, codAmount: 0, boxes: [{ weightKg: 2, lengthCm: 50, widthCm: 40, heightCm: 30 }, { weightKg: 10, lengthCm: 20, widthCm: 20, heightCm: 20 }] });
    expect((s.values.boxes as { chargedKg: number }[]).map((b) => b.chargedKg)).toEqual([12, 10]);
    const freight = Math.round(22 * 55 * 1.6);
    expect(s.values).toMatchObject({ totalKg: 22, freight, surcharges: 400, totalCharge: Math.round((freight + 400) * 1.18) });
    expect(state('logistics-shipment-booking', { declaredValue: 80_000, insure: false }).values.insure).toBe(true);
  });

  it('diagnostic tests: each person is charged for their tests, or the package covers everyone', () => {
    const s = state('care-diagnostic-booking', { healthPackage: 'NONE', where: 'HOME', patients: [{ patientName: 'A', patientAge: 34, patientTests: ['CBC', 'SUGAR'] }, { patientName: 'B', patientAge: 66, patientTests: ['THYROID'] }] });
    expect((s.values.patients as { patientCharge: number }[]).map((p) => p.patientCharge)).toEqual([500, 550]);
    expect(s.values).toMatchObject({ testsTotal: 1050, homeCharge: 0, payable: 945 });
    expect(state('care-diagnostic-booking', { healthPackage: 'BASIC', where: 'CENTRE', patients: [{ patientName: 'A', patientAge: 30 }, { patientName: 'B', patientAge: 31 }] }).values).toMatchObject({ testsTotal: 2998, payable: 2998 });
  });

  it('scholarship: the family is counted and its income shared out, and the score rewards marks and need', () => {
    const s = state('edu-scholarship', { lastMarks: 80, firstGraduate: 'YES', household: [{ memberName: 'Father', memberIncome: 120_000 }, { memberName: 'Mother', memberIncome: 0 }, { memberName: 'Sister', memberIncome: 0 }] });
    expect(s.values).toMatchObject({ familyIncome: 120_000, familySize: 4, incomePerHead: 30_000, score: 40 + 24 + 8 });
    expect(refused('edu-scholarship', { scholarshipFor: 'MERIT', lastMarks: 60 }).lastMarks).toMatch(/75%/);
  });
});
