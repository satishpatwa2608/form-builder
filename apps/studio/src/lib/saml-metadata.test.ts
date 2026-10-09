import { describe, expect, it } from 'vitest';
import { readIdpMetadata } from './saml-metadata';

const CERT = 'MIIC8DCCAdigAwIBAgIQ\nabc123+/==';
const file = (inner: string, id = 'https://sts.windows.net/tenant/') =>
  `<?xml version="1.0"?><EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${id}">${inner}</EntityDescriptor>`;
const key = (use: string, cert: string) => `<KeyDescriptor use="${use}"><KeyInfo xmlns="http://www.w3.org/2000/09/xmldsig#"><X509Data><X509Certificate>${cert}</X509Certificate></X509Data></KeyInfo></KeyDescriptor>`;
const sso = (binding: string, location: string) => `<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:${binding}" Location="${location}"/>`;

describe("reading an identity provider's metadata file", () => {
  it('takes the redirect sign-in address, the entity ID and the signing certificate', () => {
    const xml = file(`<IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${key('encryption', 'ENCRYPTONLY')}${key('signing', CERT)}${sso('HTTP-POST', 'https://login.example/post')}${sso('HTTP-Redirect', 'https://login.example/redirect')}</IDPSSODescriptor>`);
    expect(readIdpMetadata(xml)).toEqual({ entryPoint: 'https://login.example/redirect', idpIssuer: 'https://sts.windows.net/tenant/', cert: 'MIIC8DCCAdigAwIBAgIQabc123+/==' });
  });

  it('reads files that use prefixes, and a key with no stated use', () => {
    const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="http://www.okta.com/exk1"><md:IDPSSODescriptor><md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${CERT}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://acme.okta.com/sso/saml"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
    expect(readIdpMetadata(xml)).toMatchObject({ entryPoint: 'https://acme.okta.com/sso/saml', idpIssuer: 'http://www.okta.com/exk1' });
  });

  it('says no to anything else, rather than half-filling the form', () => {
    expect(readIdpMetadata('not xml at all')).toBeNull();
    expect(readIdpMetadata('<html><body>Sign in</body></html>')).toBeNull();
    // Our own side's metadata, uploaded by mistake.
    expect(readIdpMetadata(file('<SPSSODescriptor/>'))).toBeNull();
    expect(readIdpMetadata(file(`<IDPSSODescriptor>${sso('HTTP-Redirect', 'https://login.example/r')}</IDPSSODescriptor>`))).toBeNull();
    // A file that defines entities is not read at all.
    expect(readIdpMetadata(`<!DOCTYPE x [<!ENTITY e "boom">]>${file('<IDPSSODescriptor/>')}`)).toBeNull();
  });
});
