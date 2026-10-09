import { toast } from 'sonner';

/** Where published forms are filled in (the runtime app, on its own domain). */
const RUNTIME_URL = ((import.meta.env.VITE_RUNTIME_URL as string | undefined) ?? 'http://localhost:5174').replace(/\/+$/, '');

export const publicFormUrl = (orgId: string, code: string) => `${RUNTIME_URL}/f/${encodeURIComponent(orgId)}/${encodeURIComponent(code)}`;

/** The organisation's requests portal: its forms, and each person's own requests. */
export const portalUrl = (orgId: string) => `${RUNTIME_URL}/portal/${encodeURIComponent(orgId)}`;

/** `signInOnly`: the form is for the organisation's signed-in people, and the link asks anyone else to sign in. */
export async function copyPublicFormLink(orgId: string, code: string, signInOnly = false) {
  const url = publicFormUrl(orgId, code);
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied', { description: signInOnly ? `${url} · Only people signed in to your organisation can open it. To let anyone fill it in, set "Who can open it" to Anyone in the form's settings and publish again.` : url });
  } catch {
    toast.info(url);
  }
}

/** One line that puts the form on any web page: it loads the embed script, which draws the form where the line is. */
export const embedCode = (orgId: string, code: string) => `<script src="${RUNTIME_URL}/embed.js" data-org="${orgId}" data-code="${code}"></script>`;

export async function copyEmbedCode(orgId: string, code: string) {
  const html = embedCode(orgId, code);
  try {
    await navigator.clipboard.writeText(html);
    toast.success('Embed code copied', { description: 'Paste it into your web page where the form should appear.' });
  } catch {
    toast.info(html);
  }
}
