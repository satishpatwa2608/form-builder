import { toast } from 'sonner';

/** Where published forms are filled in (the runtime app, on its own domain). */
const RUNTIME_URL = ((import.meta.env.VITE_RUNTIME_URL as string | undefined) ?? 'http://localhost:5174').replace(/\/+$/, '');

export const publicFormUrl = (orgId: string, code: string) => `${RUNTIME_URL}/f/${encodeURIComponent(orgId)}/${encodeURIComponent(code)}`;

export async function copyPublicFormLink(orgId: string, code: string) {
  const url = publicFormUrl(orgId, code);
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied', { description: url });
  } catch {
    toast.info(url);
  }
}
