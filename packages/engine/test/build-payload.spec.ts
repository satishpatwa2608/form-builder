import { describe, expect, it } from 'vitest';
import { buildDefaultValues, buildPayload, resolveSystemValue, systemContextFor, withLetters } from '../src';
import { fixtureDefinitions } from './fixtures';
import type { FormDefinition, FormField } from '../src/types';

const basic = fixtureDefinitions.find((d) => d.code === 'CUSTOMER_COMPLAINT_BASIC')!;

describe('buildDefaultValues / system values', () => {
  const now = new Date('2026-09-29T08:00:00.000Z');

  it('fills system fields from context and gives every value field a starting value', () => {
    const values = buildDefaultValues(basic, systemContextFor(basic, { now }));
    expect(values.businessId).toBe('BUSINESS001');
    expect(values.submittedAt).toBe('2026-09-29T08:00:00.000Z');
    expect(values.name).toBe('');
    expect(values.severity).toBe('MEDIUM');
    expect(values.contactMe).toBe(false);
    expect(values.amountDisputed).toBeUndefined();
  });

  it('host context overrides form context', () => {
    const ctx = systemContextFor(basic, { businessId: 'FROM_URL' });
    expect(buildDefaultValues(basic, ctx).businessId).toBe('FROM_URL');
  });

  it('reads URL parameters by systemParam', () => {
    const f: FormField = { id: 'u', type: 'HIDDEN', name: 'src', systemSource: 'URL_PARAMETER', systemParam: 'source' };
    expect(resolveSystemValue(f, { urlParams: { source: 'QR' } })).toBe('QR');
    expect(resolveSystemValue(f, {})).toBeUndefined();
  });
});

describe('buildPayload', () => {
  const values = {
    businessId: 'BUSINESS001',
    submittedAt: '2026-09-29T08:00:00.000Z',
    name: 'Asha',
    email: 'asha@example.com',
    category: 'BILLING',
    productName: 'left over from when category was PRODUCT',
    serialNumber: '',
    incidentDate: '',
    severity: 'HIGH',
    amountDisputed: 1200,
    description: 'Charged twice for the same order in September.',
    contactMe: false,
    phone: '',
  };

  it('drops hidden-by-rule and unfilled fields, keeps system fields and false', () => {
    expect(buildPayload(basic, values)).toEqual({
      businessId: 'BUSINESS001',
      submittedAt: '2026-09-29T08:00:00.000Z',
      name: 'Asha',
      email: 'asha@example.com',
      category: 'BILLING',
      severity: 'HIGH',
      amountDisputed: 1200,
      description: 'Charged twice for the same order in September.',
      contactMe: false,
    });
  });

  it('applies submission.mapping', () => {
    const mapped: FormDefinition = {
      ...basic,
      submission: { ...basic.submission, mapping: { name: 'customerName' } },
    };
    const payload = buildPayload(mapped, values);
    expect(payload.customerName).toBe('Asha');
    expect(payload).not.toHaveProperty('name');
  });
});

describe('letters of a text answer', () => {
  it('are stored as the question asks, however they were typed, in rows too; other kinds of answer are left alone', () => {
    const def = {
      ...(basic as FormDefinition),
      fields: [
        { id: 'p', type: 'TEXT', name: 'pan', label: 'PAN', props: { letters: 'upper' } },
        { id: 'n', type: 'TEXT', name: 'fullName', label: 'Name', props: { letters: 'title' } },
        { id: 'e', type: 'EMAIL', name: 'mail', label: 'Email', props: { letters: 'upper' } },
        { id: 'r', type: 'REPEAT', name: 'cars', label: 'Cars' },
        { id: 'v', type: 'TEXT', name: 'plate', label: 'Plate', parentId: 'r', props: { letters: 'upper' } },
        { id: 'c', type: 'TEXT', name: 'code', label: 'Code', props: { letters: 'lower' } },
        { id: 'x', type: 'TEXT', name: 'free', label: 'Free' },
      ],
      rules: [],
      events: [],
    } as FormDefinition;
    const payload = buildPayload(def, { pan: 'abcde1234f', fullName: "aSHA o'brien-rAO", mail: 'Asha@Acme.test', cars: [{ plate: 'mh12ab1234' }], code: 'ABC', free: 'As Typed' });
    expect(payload).toEqual({ pan: 'ABCDE1234F', fullName: "Asha O'Brien-Rao", mail: 'Asha@Acme.test', cars: [{ plate: 'MH12AB1234' }], code: 'abc', free: 'As Typed' });
    expect(withLetters({ type: 'TEXT', props: { letters: 'title' } }, 'देवनागरी नाम')).toBe('देवनागरी नाम');
    expect(withLetters({ type: 'TEXT', props: { letters: 'upper' } }, 42)).toBe(42);
  });
});
