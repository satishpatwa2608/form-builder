/** What a SAML provider's metadata file says about it: enough to fill in the single sign-on form. */
export interface IdpMetadata {
  entryPoint: string;
  idpIssuer: string;
  cert: string;
}

const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';

/**
 * Reads the metadata file an identity provider offers for download. The file
 * never leaves the browser: only the three values go into the form, for the
 * admin to look at before saving. Returns null when it is not such a file.
 */
export function readIdpMetadata(xml: string): IdpMetadata | null {
  if (xml.length > 1_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) return null;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const all = (name: string, within: Document | Element = doc) => [...within.getElementsByTagNameNS('*', name)];
  const entity = all('EntityDescriptor')[0];
  const idp = all('IDPSSODescriptor')[0];
  if (!entity || !idp) return null;
  const services = all('SingleSignOnService', idp);
  // We send the browser with a redirect; a provider that only lists another way still gives its address.
  const entryPoint = (services.find((s) => s.getAttribute('Binding') === REDIRECT) ?? services[0])?.getAttribute('Location') ?? '';
  const keys = all('KeyDescriptor', idp);
  // The certificate it signs with (not one only for encryption).
  const signing = keys.find((k) => k.getAttribute('use') === 'signing') ?? keys.find((k) => k.getAttribute('use') !== 'encryption');
  const cert = (signing ? all('X509Certificate', signing)[0]?.textContent : '')?.replace(/\s+/g, '') ?? '';
  const idpIssuer = entity.getAttribute('entityID') ?? '';
  if (!entryPoint || !idpIssuer || !cert) return null;
  return { entryPoint, idpIssuer, cert };
}
