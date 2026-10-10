import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PayPage, { parsePayPath } from './PayPage';

const ID = '3f2a9c1e-1111-4222-8333-444455556666';
const LOOK = { status: 'PENDING', amount: 500, currency: 'INR', formCode: 'WORKSHOP', practice: false, ref: '' };
let calls: { path: string; method: string; body?: unknown }[];
let answers: Record<string, { status?: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  answers = { [`GET /public/payments/${ID}`]: { body: LOOK }, 'POST /auth/refresh': { status: 401, body: {} } };
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers[`${method} ${path}`] ?? { status: 404, body: { message: 'No such payment' } };
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, json: async () => answer.body };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('payment links', () => {
  it('are /pay/ and the payment, with the organisation; the practice page is its own address', () => {
    expect(parsePayPath(`/pay/${ID}`, '?org=org1')).toEqual({ id: ID, org: 'org1', practice: false });
    expect(parsePayPath(`/pay/${ID}/practice`, '?org=org1&x=1')).toEqual({ id: ID, org: 'org1', practice: true });
    expect(parsePayPath(`/pay/${ID}`, '')).toBeNull();
    expect(parsePayPath('/pay/not-a-payment', '?org=org1')).toBeNull();
    expect(parsePayPath('/f/org1/WORKSHOP', '?org=org1')).toBeNull();
  });
});

describe('coming back from the payment page', () => {
  it('asks the server how it went, and thanks the person with their reference', async () => {
    answers[`POST /public/payments/${ID}/confirm`] = { body: { status: 'SUBMITTED', ref: 'WS-000012', formCode: 'WORKSHOP' } };
    render(<PayPage id={ID} org="org1" practice={false} />);
    expect(await screen.findByRole('heading', { name: 'Thank you. Your payment was received.' })).toBeInTheDocument();
    expect(screen.getByText('WS-000012')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/You paid ₹\s?500/);
  });

  it('not paid yet: says so and lets the person check again', async () => {
    answers[`POST /public/payments/${ID}/confirm`] = { body: { status: 'PENDING', formCode: 'WORKSHOP' } };
    render(<PayPage id={ID} org="org1" practice={false} />);
    expect(await screen.findByRole('heading', { name: 'We have not received your payment yet' })).toBeInTheDocument();
    answers[`POST /public/payments/${ID}/confirm`] = { body: { status: 'SUBMITTED', ref: 'WS-000013', formCode: 'WORKSHOP' } };
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('WS-000013')).toBeInTheDocument();
  });

  it('a payment that failed sends the person back to the form; nothing is said to have been taken', async () => {
    answers[`POST /public/payments/${ID}/confirm`] = { body: { status: 'FAILED', formCode: 'WORKSHOP' } };
    render(<PayPage id={ID} org="org1" practice={false} />);
    expect(await screen.findByRole('heading', { name: 'The payment did not go through' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fill in the form again' })).toHaveAttribute('href', '/f/org1/WORKSHOP');
  });

  it('paid but not registered: the person is told not to pay again, and what to quote', async () => {
    answers[`POST /public/payments/${ID}/confirm`] = { body: { status: 'PAID', formCode: 'WORKSHOP', payment: ID } };
    render(<PayPage id={ID} org="org1" practice={false} />);
    expect(await screen.findByRole('heading', { name: 'Your payment was received' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(`quote this payment: ${ID}. You do not need to pay again.`);
  });

  it('a link that leads nowhere says so', async () => {
    delete answers[`GET /public/payments/${ID}`];
    render(<PayPage id={ID} org="org1" practice={false} />);
    expect(await screen.findByText('This payment was not found. Check the link, or start the form again.')).toBeInTheDocument();
  });
});

describe('the practice payment page', () => {
  beforeEach(() => {
    answers[`GET /public/payments/${ID}`] = { body: { ...LOOK, practice: true } };
  });

  it('says no money moves, and waits to be told how the payment should go', async () => {
    answers[`POST /public/payments/${ID}/practice`] = { body: { status: 'SUBMITTED', ref: 'WS-000014', formCode: 'WORKSHOP' } };
    render(<PayPage id={ID} org="org1" practice />);
    expect(await screen.findByRole('heading', { name: 'Practice payment' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('no money moves');
    expect(calls.some((c) => c.path.endsWith('/confirm'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Pay' }));
    expect(await screen.findByText('WS-000014')).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/practice'))!.body).toEqual({ outcome: 'PAID' });
  });

  it('letting it fail shows what a person whose payment failed sees', async () => {
    answers[`POST /public/payments/${ID}/practice`] = { body: { status: 'FAILED', formCode: 'WORKSHOP' } };
    render(<PayPage id={ID} org="org1" practice />);
    fireEvent.click(await screen.findByRole('button', { name: 'Let it fail' }));
    expect(await screen.findByRole('heading', { name: 'The payment did not go through' })).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/practice'))!.body).toEqual({ outcome: 'FAILED' });
  });
});
