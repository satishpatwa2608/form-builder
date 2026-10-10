import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PortalPage, { parsePortalPath } from './PortalPage';

const FRONT = { organisation: 'Acme', title: 'Acme help desk', intro: 'Ask us.', forms: [{ code: 'LAPTOP', name: 'New laptop', description: 'For staff' }] };
const MINE = {
  email: 'ravi@customer.test',
  requests: [
    { reference: 'REQ-000002', form: 'New laptop', sentAt: '2026-10-08T10:00:00.000Z', status: 'Being worked on', open: true, updatedAt: '2026-10-09T10:00:00.000Z' },
    { reference: 'REQ-000001', form: 'New laptop', sentAt: '2026-10-01T10:00:00.000Z', status: 'Completed', open: false, updatedAt: '2026-10-02T10:00:00.000Z' },
  ],
};

let calls: { path: string; method: string; body?: any; auth?: string }[];
let answers: Record<string, { status?: number; body: unknown }>;

beforeEach(() => {
  calls = [];
  answers = { 'GET /public/portal/org1': { body: FRONT }, 'GET /public/orgs/org1/branding': { body: { name: 'Acme', logo: null, primaryColor: null, poweredBy: true } } };
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/portal/org1');
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname;
    calls.push({ path, method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    const answer = answers[`${method} ${path}`] ?? { status: 404, body: { message: 'This organisation has no requests portal.' } };
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, json: async () => answer.body };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('portal links', () => {
  it('are /portal/ and the organisation, or /portal alone on a customer\'s own domain', () => {
    expect(parsePortalPath('/portal/5b1e-org')).toEqual({ org: '5b1e-org' });
    expect(parsePortalPath('/portal/')).toEqual({ org: '' });
    expect(parsePortalPath('/portal/a/b')).toBeNull();
    expect(parsePortalPath('/f/org/CODE')).toBeNull();
  });
});

describe('the requests portal', () => {
  it('shows the organisation\'s forms to anyone, and asks for an email before showing requests', async () => {
    render(<PortalPage org="org1" />);
    expect(await screen.findByRole('heading', { name: 'Acme help desk' })).toBeInTheDocument();
    expect(screen.getByText('Ask us.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New laptop' })).toHaveAttribute('href', '/f/org1/LAPTOP');
    expect(screen.getByLabelText(/enter your email address/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('asking for a link says the same thing whoever asks', async () => {
    answers['POST /public/portal/org1/link'] = { status: 202, body: { sent: true } };
    render(<PortalPage org="org1" />);
    fireEvent.change(await screen.findByLabelText(/enter your email address/), { target: { value: 'ravi@customer.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('If ravi@customer.test is an address we can write to, a link is on its way.');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { email: 'ravi@customer.test' } });
  });

  it('opening the emailed link signs in, takes the key out of the address bar, and lists the requests', async () => {
    window.history.replaceState(null, '', '/portal/org1?key=fbportal_abcdefghijklmnopqrstuvwxyz');
    answers['POST /public/portal/org1/session'] = { body: { session: 'fbps_session', email: MINE.email } };
    answers['GET /public/portal/org1/requests'] = { body: MINE };
    render(<PortalPage org="org1" />);
    const table = await screen.findByRole('table');
    expect(window.location.search).toBe('');
    expect(within(table).getAllByRole('rowheader').map((c) => c.textContent)).toEqual(['REQ-000002', 'REQ-000001']);
    expect(within(table).getByText('Being worked on')).toBeInTheDocument();
    expect(screen.getByText('1 open request.')).toBeInTheDocument();
    expect(screen.getByText(/Signed in as ravi@customer.test/)).toBeInTheDocument();
    expect(calls.find((c) => c.path.endsWith('/requests'))!.auth).toBe('Portal fbps_session');
    // The key went to the server once.
    expect(calls.filter((c) => c.path.endsWith('/session') && c.method === 'POST')).toHaveLength(1);
  });

  it('a used link says so and leaves the way to ask for another', async () => {
    window.history.replaceState(null, '', '/portal/org1?key=fbportal_abcdefghijklmnopqrstuvwxyz');
    answers['POST /public/portal/org1/session'] = { status: 401, body: { message: 'This link has been used or has run out. Ask for a new one.' } };
    render(<PortalPage org="org1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This link has been used or has run out.');
    expect(screen.getByRole('button', { name: 'Email me a link' })).toBeInTheDocument();
  });

  it('signing out forgets the session here and on the server', async () => {
    window.sessionStorage.setItem('fb-portal-org1', 'fbps_session');
    answers['GET /public/portal/org1/requests'] = { body: { ...MINE, requests: [] } };
    answers['DELETE /public/portal/org1/session'] = { status: 204, body: {} };
    render(<PortalPage org="org1" />);
    expect(await screen.findByText('Nothing has been sent from this address yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.auth === 'Portal fbps_session')).toBe(true));
    expect(window.sessionStorage.getItem('fb-portal-org1')).toBeNull();
    expect(screen.getByRole('button', { name: 'Email me a link' })).toBeInTheDocument();
  });

  it('a session that has run out goes back to asking, without an error', async () => {
    window.sessionStorage.setItem('fb-portal-org1', 'fbps_old');
    answers['GET /public/portal/org1/requests'] = { status: 401, body: { message: 'Sign in again' } };
    render(<PortalPage org="org1" />);
    expect(await screen.findByRole('button', { name: 'Email me a link' })).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem('fb-portal-org1')).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forms started and not sent are listed with Continue and Discard; without any, the heading is not shown', async () => {
    window.sessionStorage.setItem('fb-portal-org1', 'fbps_session');
    answers['GET /public/portal/org1/requests'] = { body: MINE };
    const first = render(<PortalPage org="org1" />);
    expect(await screen.findByText('Signed in as ravi@customer.test.', { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Unfinished' })).toBeNull();
    first.unmount();

    answers['GET /public/portal/org1/requests'] = { body: { ...MINE, unfinished: [{ id: 'd1', form: 'New laptop', code: 'LAPTOP', savedAt: '2026-10-09T10:00:00.000Z', expiresAt: '2026-11-08T10:00:00.000Z' }] } };
    answers['DELETE /public/portal/org1/drafts/d1'] = { status: 204, body: {} };
    answers['POST /public/portal/org1/drafts/d1/continue'] = { body: { code: 'LAPTOP', token: 'fbd_fresh' } };
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, href: window.location.href, hostname: window.location.hostname, assign });
    render(<PortalPage org="org1" />);
    const unfinished = await screen.findByRole('group', { name: 'Unfinished' });
    expect(within(unfinished).getByText('New laptop')).toBeInTheDocument();

    // Continue asks the server for a way in made now, and opens the form with it.
    fireEvent.click(within(unfinished).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/f/org1/LAPTOP?resume=fbd_fresh'));
    expect(calls.find((c) => c.path.endsWith('/drafts/d1/continue'))).toMatchObject({ method: 'POST', auth: 'Portal fbps_session' });
  });

  it('Discard removes it on the server and reads the list again', async () => {
    window.sessionStorage.setItem('fb-portal-org1', 'fbps_session');
    answers['GET /public/portal/org1/requests'] = { body: { ...MINE, unfinished: [{ id: 'd1', form: 'New laptop', code: 'LAPTOP', savedAt: '2026-10-09T10:00:00.000Z', expiresAt: '2026-11-08T10:00:00.000Z' }] } };
    answers['DELETE /public/portal/org1/drafts/d1'] = { status: 204, body: {} };
    render(<PortalPage org="org1" />);
    const unfinished = await screen.findByRole('group', { name: 'Unfinished' });
    answers['GET /public/portal/org1/requests'] = { body: MINE };
    fireEvent.click(within(unfinished).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Unfinished' })).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/drafts/d1'))).toBe(true);
  });

  it('an organisation without a portal says so', async () => {
    delete answers['GET /public/portal/org1'];
    render(<PortalPage org="org1" />);
    expect(await screen.findByRole('heading', { name: "This page isn't available" })).toBeInTheDocument();
  });
});
