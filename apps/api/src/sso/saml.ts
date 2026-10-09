import { X509Certificate } from 'node:crypto';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';

/** What the organisation's SAML provider gave its admin. */
export interface SamlSettings {
  entryPoint: string;
  idpIssuer: string;
  cert: string;
}

/** Our side of the conversation, per organisation, so one organisation's sign-in can never be replayed at another. */
export const samlAddresses = (apiUrl: string, orgId: string) => {
  const base = `${apiUrl.replace(/\/+$/, '')}/auth/sso/saml/${orgId}`;
  return { entityId: `${base}/metadata`, acsUrl: `${base}/acs`, metadataUrl: `${base}/metadata` };
};

/**
 * A certificate as pasted: with or without the BEGIN/END lines, with any
 * line breaks. Returns it as PEM with when it runs out, or null if it is not one.
 */
export function readCertificate(input: string): { pem: string; expiresAt: Date } | null {
  const body = input.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]{200,8000}={0,2}$/.test(body)) return null;
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  try {
    return { pem, expiresAt: new Date(new X509Certificate(pem).validTo) };
  } catch {
    return null;
  }
}

/**
 * The request IDs the library asks about. There is exactly one a response may
 * answer: the request this browser was sent away with. Anything else,
 * including a response nobody asked for, is not known.
 */
const onlyRequest = (requestId: string): CacheProvider => ({
  saveAsync: async (key, value) => ({ value, createdAt: Date.now() }),
  getAsync: async (key) => (requestId && key === requestId ? new Date().toISOString() : null),
  removeAsync: async (key) => key,
});

/** The library set up for one organisation and one sign-in attempt. Signature, audience, issuer, time and request checks are its. */
export function samlFor(apiUrl: string, orgId: string, settings: SamlSettings, requestId: string): SAML {
  const { entityId, acsUrl } = samlAddresses(apiUrl, orgId);
  return new SAML({
    entryPoint: settings.entryPoint,
    idpCert: settings.cert,
    idpIssuer: settings.idpIssuer,
    issuer: entityId,
    audience: entityId,
    callbackUrl: acsUrl,
    // What the person is must be signed by the provider; a signed envelope round an unsigned statement is not enough.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    signatureAlgorithm: 'sha256',
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: onlyRequest(requestId),
    generateUniqueId: () => requestId,
    acceptedClockSkewMs: 120_000,
    maxAssertionAgeMs: 10 * 60_000,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    // Asking for one way of signing in (a password) turns away people who used a stronger one.
    disableRequestedAuthnContext: true,
  });
}

const CLAIMS = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims';
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : Array.isArray(v) && typeof v[0] === 'string' ? v[0].trim() : '');
const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,}$/;

/** Who the provider says this is: an email (as an attribute, or as the name ID) and, if it sent one, a name. */
export function personFrom(profile: Profile): { email: string; name?: string } {
  const candidates = [profile.email, profile.mail, profile[`${CLAIMS}/emailaddress`], profile['urn:oid:0.9.2342.19200300.100.1.3'], profile.nameID];
  const email = candidates.map(text).find((v) => EMAIL.test(v))?.toLowerCase() ?? '';
  const full = text(profile.displayName) || text(profile[`${CLAIMS}/name`]) || [text(profile.givenName) || text(profile[`${CLAIMS}/givenname`]), text(profile.surname) || text(profile.sn) || text(profile[`${CLAIMS}/surname`])].filter(Boolean).join(' ');
  return { email, name: full && !EMAIL.test(full) ? full.slice(0, 100) : undefined };
}
