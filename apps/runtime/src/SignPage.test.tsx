import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SignPage, { parseSignPath } from './SignPage';

const TOKEN = 'fbsig_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const VIEW = { title: 'Loan agreement', message: 'Please sign by Friday.', organisation: 'Acme', reference: 'LN-000001', email: 'asha@example.com', status: 'SENT', expiresAt: '2026-11-01T00:00:00.000Z', others: ['PENDING'] };

let calls: { url: string; method: string; body?: unknown }[];
let answers: Record<string, { status?: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  answers = { [`GET /public/sign/${TOKEN}`]: { body: VIEW } };
  // jsdom has no canvas: stand in for the calls the pad makes.
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  HTMLCanvasElement.prototype.toDataURL = () => PNG;
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = answers[`${method} ${new URL(url).pathname}`] ?? { status: 404, body: { message: 'This signing link is not valid.' } };
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, json: async () => answer.body };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('signing links', () => {
  it('are /sign/ and a token, nothing else', () => {
    expect(parseSignPath(`/sign/${TOKEN}`)).toBe(TOKEN);
    expect(parseSignPath(`/sign/${TOKEN}/`)).toBe(TOKEN);
    expect(parseSignPath('/sign/short')).toBeNull();
    expect(parseSignPath(`/sign/${TOKEN}/document`)).toBeNull();
    expect(parseSignPath('/f/org/CODE')).toBeNull();
  });
});

describe('the signing page', () => {
  it('shows what is being signed and where to read it', async () => {
    render(<SignPage token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: 'Loan agreement' })).toBeInTheDocument();
    expect(screen.getByText('Acme asks you to sign')).toBeInTheDocument();
    expect(screen.getByText('Reference LN-000001')).toBeInTheDocument();
    expect(screen.getByText('Please sign by Friday.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Read the document/ })).toHaveAttribute('href', expect.stringContaining(`/public/sign/${TOKEN}/document`));
  });

  it('will not sign without a name and the agreement, and says which is missing', async () => {
    render(<SignPage token={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type your full name');
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Asha Rao' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Tick the box');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('signs with a typed name alone, and thanks the signer', async () => {
    answers[`POST /public/sign/${TOKEN}`] = { body: { ...VIEW, status: 'SIGNED' } };
    render(<SignPage token={TOKEN} />);
    fireEvent.change(await screen.findByLabelText('Your full name'), { target: { value: '  Asha Rao ' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(await screen.findByRole('heading', { name: 'Thank you, you have signed' })).toBeInTheDocument();
    expect(screen.getByText(/One other person still has to sign/)).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { name: 'Asha Rao', signature: PNG, agreed: true } });
  });

  it('offers the signed document once everyone has signed', async () => {
    answers[`GET /public/sign/${TOKEN}`] = { body: { ...VIEW, status: 'SIGNED', others: ['SIGNED'] } };
    render(<SignPage token={TOKEN} />);
    expect(await screen.findByRole('link', { name: /Open the signed document/ })).toBeInTheDocument();
  });

  it('declines with a reason, after saying what declining does', async () => {
    answers[`POST /public/sign/${TOKEN}/decline`] = { body: { ...VIEW, status: 'DECLINED' } };
    render(<SignPage token={TOKEN} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(screen.getByText(/nobody else will be asked to sign/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Why are you declining/), { target: { value: 'Wrong amount' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decline to sign' }));
    expect(await screen.findByRole('heading', { name: 'This document was declined' })).toBeInTheDocument();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { reason: 'Wrong amount' } });
  });

  it('shows the server\'s reason when signing is refused, and keeps the form', async () => {
    answers[`POST /public/sign/${TOKEN}`] = { status: 409, body: { message: 'You have already signed this document.' } };
    render(<SignPage token={TOKEN} />);
    fireEvent.change(await screen.findByLabelText('Your full name'), { target: { value: 'Asha Rao' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('You have already signed'));
    expect(screen.getByRole('button', { name: 'Sign' })).toBeInTheDocument();
  });

  it.each([
    ['WAITING', 'It is not your turn yet'],
    ['EXPIRED', 'The time to sign has passed'],
  ])('says so plainly when the request is %s', async (status, heading) => {
    answers[`GET /public/sign/${TOKEN}`] = { body: { ...VIEW, status } };
    render(<SignPage token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
  });

  it('a link that is not known says so', async () => {
    delete answers[`GET /public/sign/${TOKEN}`];
    render(<SignPage token={TOKEN} />);
    expect(await screen.findByRole('heading', { name: "This link can't be used" })).toBeInTheDocument();
    expect(screen.getByText('This signing link is not valid.')).toBeInTheDocument();
  });

  it('asks for a code by email first, and opens the document and the form only once it is right', async () => {
    answers[`GET /public/sign/${TOKEN}`] = { body: { ...VIEW, confirm: 'EMAIL_CODE', locked: false } };
    answers[`POST /public/sign/${TOKEN}/code`] = { body: { sentTo: 'a…@example.com', minutes: 10 } };
    answers[`POST /public/sign/${TOKEN}/confirm`] = { status: 403, body: { message: 'That is not right. Check it and try again.' } };
    render(<SignPage token={TOKEN} />);
    // Nothing to read or sign yet.
    await screen.findByText(/we will email a code to asha@example.com/);
    expect(screen.queryByRole('link', { name: /Read the document/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Email me a code' }));
    await screen.findByText('We have emailed a code to a…@example.com. It works for 10 minutes.');
    fireEvent.change(screen.getByLabelText('The code from the email'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That is not right. Check it and try again.');

    answers[`POST /public/sign/${TOKEN}/confirm`] = { body: { pass: '999.mark' } };
    fireEvent.change(screen.getByLabelText('The code from the email'), { target: { value: '424242' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const link = await screen.findByRole('link', { name: /Read the document/ });
    // The pass goes with the document and with the signature.
    expect(link.getAttribute('href')).toContain(`/public/sign/${TOKEN}/document?pass=999.mark`);
    answers[`POST /public/sign/${TOKEN}`] = { body: { ...VIEW, status: 'SIGNED' } };
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Asha Rao' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }));
    await screen.findByText('Thank you, you have signed');
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith(`/sign/${TOKEN}`))!.body).toMatchObject({ name: 'Asha Rao', agreed: true, pass: '999.mark' });
  });

  it('asks for something the signer knows, in the words the organisation chose, and says when the link has stopped working', async () => {
    answers[`GET /public/sign/${TOKEN}`] = { body: { ...VIEW, confirm: 'KNOWN', asks: 'your policy number', locked: false } };
    answers[`POST /public/sign/${TOKEN}/confirm`] = { status: 403, body: { message: 'That is not right, and there were too many wrong tries: this link no longer works.' } };
    render(<SignPage token={TOKEN} />);
    await screen.findByText(/please enter your policy number/);
    expect(screen.queryByRole('button', { name: 'Email me a code' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Your policy number'), { target: { value: 'wrong' } });
    // The server now says the link is closed.
    answers[`GET /public/sign/${TOKEN}`] = { body: { ...VIEW, confirm: 'KNOWN', asks: 'your policy number', locked: true } };
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText('This link no longer works');
    expect(screen.getByText(/Ask Acme to send the document again/)).toBeTruthy();
  });
});
