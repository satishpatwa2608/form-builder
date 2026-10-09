import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SsoCard } from './SsoSettings';

const blank = {
  enabled: false,
  protocol: 'OIDC',
  saml: { entryPoint: '', idpIssuer: '', certSet: false, certExpiresAt: null, entityId: 'https://api.example/auth/sso/saml/org-1/metadata', acsUrl: 'https://api.example/auth/sso/saml/org-1/acs', metadataUrl: 'https://api.example/auth/sso/saml/org-1/metadata' },
  issuer: '',
  clientId: '',
  clientSecretSet: false,
  domains: ['acme.com'],
  pendingDomains: [],
  autoProvision: false,
  defaultRole: 'VIEWER',
  enforce: false,
  lastSuccessAt: null,
  callbackUrl: 'https://api.example/auth/sso/callback',
  available: true,
};
const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, saved: [] as Record<string, unknown>[] }));
vi.mock('../lib/api', () => ({
  errorMessage: (e: unknown) => String(e),
  api: async (_path: string, init?: { method?: string; body?: Record<string, unknown> }) => {
    if (init?.method === 'PUT') state.saved.push(init.body!);
    return state.settings;
  },
}));

const METADATA = `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://sts.example/tenant/"><IDPSSODescriptor><KeyDescriptor use="signing"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>MIICcert</X509Certificate></X509Data></KeyInfo></KeyDescriptor><SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://login.example/saml2"/></IDPSSODescriptor></EntityDescriptor>`;
const upload = (text: string) => {
  const file = new File([text], 'metadata.xml', { type: 'application/xml' });
  // jsdom's File has no text(); the card only needs that.
  Object.defineProperty(file, 'text', { value: async () => text });
  fireEvent.change(screen.getByLabelText('Provider metadata file'), { target: { files: [file] } });
};

beforeEach(() => {
  state.settings = { ...blank };
  state.saved = [];
});
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SsoCard />
    </QueryClientProvider>,
  );

describe('single sign-on settings', () => {
  it('starts on OpenID Connect and shows only that kind\'s boxes', async () => {
    show();
    expect(await screen.findByLabelText('Issuer URL')).toBeInTheDocument();
    expect(screen.queryByLabelText("Provider's sign-in address")).toBeNull();
    expect(screen.getByLabelText('My identity provider uses')).toHaveValue('OIDC');
  });

  it('SAML: shows what to give the provider, and fills the three boxes from its metadata file', async () => {
    show();
    fireEvent.change(await screen.findByLabelText('My identity provider uses'), { target: { value: 'SAML' } });
    expect(screen.getByText('https://api.example/auth/sso/saml/org-1/acs')).toBeInTheDocument();
    expect(screen.queryByLabelText('Client secret')).toBeNull();

    upload('<html>not it</html>');
    expect(await screen.findByText(/That is not an identity provider's metadata file/)).toBeInTheDocument();
    upload(METADATA);
    await waitFor(() => expect(screen.getByLabelText("Provider's sign-in address")).toHaveValue('https://login.example/saml2'));
    expect(screen.getByLabelText("Provider's identifier (entity ID)")).toHaveValue('https://sts.example/tenant/');
    expect(screen.getByLabelText("Provider's signing certificate")).toHaveValue('MIICcert');
    expect(screen.getByText('Filled in from the file. Check the values, then save.')).toBeInTheDocument();
    // Nothing is saved by choosing a file.
    expect(state.saved).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.saved).toHaveLength(1));
    expect(state.saved[0]).toEqual({ protocol: 'SAML', saml: { entryPoint: 'https://login.example/saml2', idpIssuer: 'https://sts.example/tenant/', cert: 'MIICcert' }, domains: ['acme.com'], autoProvision: false, defaultRole: 'VIEWER' });
  });

  it('a saved certificate is not shown or resent; its end date is', async () => {
    state.settings = { ...blank, protocol: 'SAML', enabled: true, saml: { ...blank.saml, entryPoint: 'https://login.example/saml2', idpIssuer: 'https://sts.example/tenant/', certSet: true, certExpiresAt: '2027-03-01T00:00:00.000Z' } };
    show();
    expect(await screen.findByLabelText("Provider's signing certificate")).toHaveValue('');
    expect(screen.getByText(/One is saved; it runs out on .*2027/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.saved).toHaveLength(1));
    expect(state.saved[0]!.saml).toEqual({ entryPoint: 'https://login.example/saml2', idpIssuer: 'https://sts.example/tenant/' });
    // Changing the kind of provider while it is on says what will happen.
    fireEvent.change(screen.getByLabelText('My identity provider uses'), { target: { value: 'OIDC' } });
    expect(screen.getByText(/turns single sign-on off until you turn it on again/)).toBeInTheDocument();
  });
});
