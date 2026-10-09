import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import { AuthProvider } from '../lib/auth';
import { setAccessToken } from '../lib/api';
import { fakeApi, ME } from './fake-api';

beforeAll(() => {
  window.confirm = () => true;
});
afterEach(() => {
  cleanup();
  setAccessToken(null);
});

function renderApp(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const signedOut = { 'POST /auth/refresh': () => ({ status: 401, body: {} }) };
const signedIn = (me = ME) => ({
  'POST /auth/refresh': () => ({ body: { accessToken: 't' } }),
  'GET /auth/me': () => ({ body: me }),
  'GET /members': () => ({ body: [{ userId: 'u1', name: 'Asha Rao', email: 'asha@acme.test', role: 'OWNER', status: 'ACTIVE', department: '', managerId: '', twoFactorEnabled: false }] }),
  'GET /invitations': () => ({ body: [] }),
  'GET /folders': () => ({ body: [] }),
});

describe('studio', () => {
  it('sign-in asks for the two-factor code when the account has it, then opens the app', async () => {
    const user = userEvent.setup();
    const { calls } = fakeApi({
      ...signedOut,
      'POST /auth/login': (body) => ((body as { code?: string }).code === '123456' ? { body: { accessToken: 't' } } : { status: 401, body: { message: 'Enter the code', code: 'TWO_FACTOR_REQUIRED' } }),
      'GET /auth/me': () => ({ body: ME }),
      'GET /members': () => ({ body: [] }),
      'GET /folders': () => ({ body: [] }),
    });
    renderApp('/members');
    await user.type(await screen.findByLabelText('Work email'), 'asha@acme.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.type(await screen.findByLabelText('Authentication code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    // Back to the page they asked for.
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/auth/login').map((c) => (c.body as { code?: string }).code)).toEqual([undefined, '123456']);
  });

  it('an unconfirmed email gets a way to resend the link', async () => {
    const user = userEvent.setup();
    const { calls } = fakeApi({
      ...signedOut,
      'POST /auth/login': () => ({ status: 403, body: { message: 'Confirm your email first', code: 'EMAIL_NOT_VERIFIED' } }),
      'POST /auth/resend-verification': () => ({ status: 202, body: {} }),
    });
    renderApp('/login');
    await user.type(await screen.findByLabelText('Work email'), 'new@acme.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await user.click(await screen.findByRole('button', { name: 'Send it again' }));
    expect(await screen.findByText(/sent a new confirmation link/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/resend-verification')?.body).toEqual({ email: 'new@acme.test' });
  });

  it('when the org requires two-factor and this session has none, every page leads to set-up', async () => {
    fakeApi({ ...signedIn({ ...ME, org: { ...ME.org, require2fa: true } }), 'POST /auth/2fa/setup': () => ({ body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/x' } }) });
    renderApp('/members');
    expect(await screen.findByRole('heading', { name: 'Account & security' })).toBeInTheDocument();
    expect(screen.getByText(/requires two-factor sign-in. Set it up below/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Password' })).not.toBeInTheDocument();
  });

  it('menus and controls follow permissions', async () => {
    const viewer = { ...ME, org: { ...ME.org, role: 'DESIGNER', permissions: ['members.view', 'form.view', 'form.edit'] } };
    fakeApi(signedIn(viewer as typeof ME));
    renderApp('/members');
    expect(await screen.findByRole('heading', { name: 'Members' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: /Audit trail/ })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: /Organisation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send invitation/ })).not.toBeInTheDocument();
  });

  it('owners invite with a role; the list refreshes', async () => {
    const user = userEvent.setup();
    const { calls } = fakeApi({ ...signedIn(), 'POST /invitations': () => ({ status: 201, body: [] }) });
    renderApp('/members');
    await user.type(await screen.findByLabelText('Email'), 'dev@acme.test');
    await user.selectOptions(screen.getByLabelText('Role'), 'PUBLISHER');
    await user.click(screen.getByRole('button', { name: /Send invitation/ }));
    expect(await screen.findByText('Invitation sent to dev@acme.test.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/invitations')?.body).toEqual({ email: 'dev@acme.test', role: 'PUBLISHER' });
  });

  it('forms: a live public form has its link, a way to open it and its embed code right on its row; others do not', async () => {
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    const form = (over: object) => ({ id: 'x', code: 'X', name: 'X', folderId: 'f1', version: 1, status: 'PUBLISHED', publishedVersion: 1, publicLink: false, updatedAt: '2026-09-30T10:00:00Z', permissions: ['form.view'], ...over });
    fakeApi({
      ...signedIn(),
      'GET /folders': () => ({ body: [{ id: 'f1', name: 'Quality', parentId: null, path: ['f1'] }] }),
      'GET /forms': () => ({
        body: [
          form({ id: 'a', code: 'PLANT_ISSUE', name: 'Plant issue', publicLink: true }),
          form({ id: 'b', code: 'STAFF_ONLY', name: 'Staff only' }),
          form({ id: 'c', code: 'DRAFTED', name: 'Drafted', status: 'DRAFT', publishedVersion: null }),
        ],
      }),
    });
    renderApp('/forms');
    await user.click(await screen.findByRole('button', { name: 'Copy the link to Plant issue' }));
    expect(copied[0]).toMatch(new RegExp(`/f/${ME.org.id}/PLANT_ISSUE$`));
    expect(screen.getByRole('link', { name: 'Open Plant issue as people see it' })).toHaveAttribute('href', copied[0]);
    await user.click(screen.getByRole('button', { name: 'Copy the embed code for Plant issue' }));
    expect(copied[1]).toContain(`data-org="${ME.org.id}" data-code="PLANT_ISSUE"`);
    // A form for signed-in people only has its link too, says who can open it, and is not offered for a website.
    await user.click(screen.getByRole('button', { name: 'Copy the link to Staff only' }));
    expect(copied[2]).toMatch(new RegExp(`/f/${ME.org.id}/STAFF_ONLY$`));
    expect(screen.getByRole('button', { name: 'Copy the link to Staff only' })).toHaveAttribute('title', expect.stringContaining('Only people signed in to your organisation can open it'));
    expect(within(screen.getByRole('row', { name: /Staff only/ })).getByText('Sign-in only')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy the embed code for Staff only' })).toBeNull();
    // One not yet published has no address to hand out.
    expect(screen.queryByRole('button', { name: 'Copy the link to Drafted' })).toBeNull();
  });

  it('forms: create from a template (code from the name) and actions follow per-form permissions', async () => {
    const user = userEvent.setup();
    const folder = { id: 'f1', name: 'Quality', parentId: null, path: ['f1'] };
    const form = (over: object) => ({ id: 'x', code: 'X', name: 'X', folderId: 'f1', version: 1, status: 'DRAFT', publishedVersion: null, updatedAt: '2026-09-30T10:00:00Z', permissions: ['form.view'], ...over });
    const { calls } = fakeApi({
      ...signedIn(),
      'GET /folders': () => ({ body: [folder] }),
      'GET /forms': () => ({
        body: [
          form({ id: 'a', code: 'MINE', name: 'Mine', permissions: ['form.view', 'form.edit', 'form.publish'] }),
          form({ id: 'b', code: 'READONLY', name: 'Read only', status: 'PUBLISHED' }),
        ],
      }),
      'POST /forms': () => ({ status: 201, body: {} }),
    });
    renderApp('/forms');
    expect(await screen.findByRole('button', { name: /Publish/ })).toBeInTheDocument();
    // Only the editable form offers actions; the read-only one just shows versions.
    expect(screen.getAllByRole('button', { name: /Publish/ })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Delete draft Read only/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Delete draft Mine/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New form/ }));
    await user.click(screen.getByText('Plant issue report'));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Line 3 issues');
    await user.click(screen.getByRole('button', { name: /Create draft/ }));
    expect(await screen.findByText('"Line 3 issues" was created as a draft.')).toBeInTheDocument();
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/forms')!.body as { folderId: string; definition: { name: string; code: string; fields: unknown[]; id?: string } };
    expect(sent.folderId).toBe('f1');
    expect(sent.definition).toMatchObject({ name: 'Line 3 issues', code: 'LINE_3_ISSUES' });
    expect(sent.definition.fields.length).toBeGreaterThan(0);
    expect(sent.definition.id).toBeUndefined(); // identity is the server's
  });

  it('connectors: credentials are sent apart from settings and never displayed', async () => {
    const user = userEvent.setup();
    const manager = { ...ME, org: { ...ME.org, permissions: [...ME.org.permissions, 'connector.manage', 'connector.use'] } };
    const { calls } = fakeApi({
      ...signedIn(manager as typeof ME),
      'GET /connectors': () => ({ body: [] }),
      'POST /connectors': (body) => ({ status: 201, body: { id: 'c1', ref: 'abcd1234', type: 'mongodb', name: (body as { name: string }).name, settings: { database: 'crm' }, credentialsSet: true, writable: false, allowedHosts: [], entities: [], lastTest: null, permissions: { use: true, manage: true } } }),
    });
    renderApp('/connectors');
    await user.click(await screen.findByRole('button', { name: /New connector/ }));
    await user.click(screen.getByText('MongoDB'));
    await user.type(screen.getByLabelText('Name'), 'Plant CRM');
    await user.type(screen.getByLabelText('Database'), 'crm');
    await user.type(screen.getByLabelText('Connection string'), 'mongodb+srv://u:p@db.example.com/');
    await user.click(screen.getByRole('button', { name: /Create connector/ }));
    expect(await screen.findByText(/Plant CRM was created/)).toBeInTheDocument();
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/connectors')!.body as { settings: object; secrets: object; writable: boolean };
    expect(sent).toMatchObject({ settings: { database: 'crm' }, secrets: { uri: 'mongodb+srv://u:p@db.example.com/' }, writable: false });
    expect(JSON.stringify(sent.settings)).not.toContain('mongodb+srv');
  });

  it('gateways: the token is shown once, and gateway connectors send no credentials', async () => {
    const user = userEvent.setup();
    const manager = { ...ME, org: { ...ME.org, permissions: [...ME.org.permissions, 'connector.manage', 'connector.use'] } };
    const gateways = [{ id: 'g1', name: 'Plant LAN', registered: true, connected: true }];
    const { calls } = fakeApi({
      ...signedIn(manager as typeof ME),
      'GET /connectors': () => ({ body: [] }),
      'GET /gateways': () => ({ body: gateways }),
      'POST /gateways': (body) => ({ status: 201, body: { id: 'g2', name: (body as { name: string }).name, registrationToken: 'fbreg_abcdefghijklmnopqrstuvwxyz', expiresAt: new Date(Date.now() + 3600e3).toISOString() } }),
      'POST /connectors': (body) => ({ status: 201, body: { id: 'c1', ref: 'abcd1234', type: 'postgres', name: (body as { name: string }).name, settings: {}, credentialsSet: true, writable: false, allowedHosts: [], entities: [], lastTest: null, permissions: { use: true, manage: true }, gatewayId: 'g1', gatewayConnected: true } }),
    });
    renderApp('/connectors');
    expect(await screen.findByText('Plant LAN')).toBeInTheDocument();
    await user.type(screen.getByLabelText('New gateway'), 'Office');
    await user.click(screen.getByRole('button', { name: /Create gateway/ }));
    expect(await screen.findByText(/fbreg_abcdefghijklmnopqrstuvwxyz/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /New connector/ }));
    await user.type(screen.getByLabelText('Name'), 'ERP');
    await user.selectOptions(screen.getByLabelText('Where it runs'), 'g1');
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Host'), 'erp.internal');
    await user.type(screen.getByLabelText('Database'), 'erp');
    await user.click(screen.getByRole('button', { name: /Create connector/ }));
    expect(await screen.findByText(/ERP was created/)).toBeInTheDocument();
    const sent = calls.find((c) => c.method === 'POST' && c.path === '/connectors')!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ gatewayId: 'g1', settings: { host: 'erp.internal', database: 'erp' } });
    expect(sent.secrets).toBeUndefined();
  });

  it('where sign-up is closed, the sign-in page offers no account to create and the sign-up page says how to get in', async () => {
    fakeApi({ ...signedOut, 'GET /auth/config': () => ({ body: { signup: 'closed' } }) });
    renderApp('/login');
    expect(await screen.findByText(/New accounts are by invitation/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create an account' })).toBeNull();
    cleanup();
    fakeApi({ ...signedOut, 'GET /auth/config': () => ({ body: { signup: 'closed' } }) });
    renderApp('/signup');
    expect(await screen.findByRole('heading', { name: 'By invitation' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Organisation name')).toBeNull();
  });

  it('where sign-up is open, or the server does not say, an account can be created as before', async () => {
    fakeApi({ ...signedOut, 'GET /auth/config': () => ({ body: { signup: 'open' } }) });
    renderApp('/login');
    expect(await screen.findByRole('link', { name: 'Create an account' })).toBeInTheDocument();
  });

  it('an operator has a Customers page: every customer with plan, owner and use; one is added and a plan changed there', async () => {
    const user = userEvent.setup();
    const sangam = { id: 'o2', name: 'Sangam', plan: 'ENTERPRISE', planName: 'Enterprise', createdAt: '2026-10-01T00:00:00.000Z', owners: [{ name: 'Priya', email: 'priya@sangam.test' }], invitedOwners: [], members: 12, memberLimit: null, forms: 4, responsesThisMonth: 1530, lastActiveAt: new Date().toISOString() };
    const fresh = { id: 'o3', name: 'Newco', plan: 'TEAM', planName: 'Team', createdAt: '2026-10-09T00:00:00.000Z', owners: [], invitedOwners: ['boss@newco.test'], members: 0, memberLimit: 10, forms: 0, responsesThisMonth: 0, lastActiveAt: null };
    const { calls } = fakeApi({
      ...signedIn({ ...ME, operator: true, canCreateOrgs: true } as typeof ME),
      'GET /operator/customers': () => ({ body: [sangam] }),
      'POST /operator/customers': () => ({ status: 201, body: [fresh, sangam] }),
      'PATCH /operator/customers/o2': () => ({ body: [fresh, { ...sangam, plan: 'BUSINESS', planName: 'Business', memberLimit: 50 }] }),
    });
    renderApp('/customers');
    const table = await screen.findByRole('table', { name: 'Customers' });
    const row = await within(table).findByRole('row', { name: /Sangam/ });
    expect(row).toHaveTextContent('Priya');
    expect(row).toHaveTextContent('1,530');
    expect(row).toHaveTextContent('Today');
    expect(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Customers' })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Customer's name"), 'Newco');
    await user.type(screen.getByLabelText("Their owner's email"), 'boss@newco.test');
    await user.click(screen.getByRole('button', { name: 'Add and invite' }));
    expect(await screen.findByText('Newco was added on the Team plan. An invitation to own it has gone to boss@newco.test.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/operator/customers')?.body).toEqual({ name: 'Newco', plan: 'TEAM', ownerEmail: 'boss@newco.test' });
    expect(within(screen.getByRole('row', { name: /Newco/ })).getByText('Invited')).toBeInTheDocument();
    // The button under the owner says what that customer needs: sending again where nobody has accepted yet.
    expect(within(screen.getByRole('row', { name: /Newco/ })).getByRole('button', { name: /Send the invitation again/ })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Sangam/ })).queryByRole('button', { name: /Invite an owner/ })).toBeNull();

    await user.selectOptions(screen.getByLabelText('Plan for Sangam'), 'BUSINESS');
    expect(await screen.findByText('Sangam is now on the Business plan.')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Sangam/ })).toHaveTextContent('12 of 50');
  });

  it('someone who does not run the installation has no Customers in the menu, and the address shows nothing', async () => {
    fakeApi({ ...signedIn({ ...ME, operator: false, canCreateOrgs: false } as typeof ME), 'GET /auth/sessions': () => ({ body: [] }), 'GET /operator/customers': () => ({ status: 404, body: { message: 'Not found' } }) });
    renderApp('/customers');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('link', { name: 'Customers' })).toBeNull();
    expect(screen.queryByRole('table', { name: 'Customers' })).toBeNull();
  });

  it('SSO: an SSO_REQUIRED sign-in points to single sign-on, and a returned error is shown', async () => {
    const user = userEvent.setup();
    fakeApi({ ...signedOut, 'POST /auth/login': () => ({ status: 403, body: { message: 'Your organisation requires single sign-on.', code: 'SSO_REQUIRED' } }) });
    renderApp('/login?sso_error=Sign-in%20was%20cancelled');
    expect(await screen.findByText('Sign-in was cancelled')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Work email'), 'asha@acme.test');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/requires single sign-on/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with SSO' })).toHaveClass('st-btn--primary');
  });

  it('organisation settings show the plan and how much of it is used', async () => {
    fakeApi({
      ...signedIn(),
      'GET /org/usage': () => ({
        body: {
          plan: 'FREE',
          planName: 'Free',
          month: '2026-10',
          limits: { forms: 3, submissionsPerMonth: 100, members: 2, connectors: 0, gateways: 0, customDomains: 0, extensions: 0, removeBranding: false, sso: false },
          usage: { forms: 3, members: 1, connectors: 0, gateways: 0, customDomains: 0, extensions: 0, submissionsThisMonth: 42 },
        },
      }),
    });
    renderApp('/settings');
    expect(await screen.findByText('Plan & usage')).toBeInTheDocument();
    expect(screen.getByText('42 / 100')).toBeInTheDocument();
    expect(screen.getByText('3 / 3')).toBeInTheDocument();
    expect(screen.getAllByText('0 / not included').length).toBeGreaterThan(0);
  });
});
