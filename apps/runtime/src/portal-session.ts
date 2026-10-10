/**
 * The requests portal's session, kept for this browser tab only: closing the tab signs the person out. A form
 * opened from the portal is in the same tab, so what is saved there can be listed back on the portal as theirs.
 */
const KEY = (org: string) => `fb-portal-${org}`;

export const storedPortalSession = (org: string) => {
  try {
    return window.sessionStorage.getItem(KEY(org)) ?? undefined;
  } catch {
    return undefined;
  }
};

export const storePortalSession = (org: string, session?: string) => {
  try {
    if (session) window.sessionStorage.setItem(KEY(org), session);
    else window.sessionStorage.removeItem(KEY(org));
  } catch {
    // Storage switched off: the person stays signed in until they leave the page.
  }
};
