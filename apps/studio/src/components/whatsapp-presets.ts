/**
 * The technical part of calling a WhatsApp provider, written from the few account details the organisation has:
 * the address, how the message is sent, and the sign-in header. WhatsApp delivers only messages made from a
 * template it has approved, so the message goes in as the template's one parameter ({{message}}).
 */
export type WhatsappProvider = 'META' | 'TWILIO';

export interface PresetResult {
  url: string;
  method: 'POST';
  format: 'JSON' | 'FORM';
  body: string;
  headerName: string;
  headerValue: string;
}

export const WHATSAPP_PROVIDERS: { value: WhatsappProvider; label: string; fields: { key: string; label: string; hint?: string; secret?: boolean }[] }[] = [
  {
    value: 'META',
    label: 'Meta (WhatsApp Cloud API)',
    fields: [
      { key: 'phoneNumberId', label: 'Phone number ID', hint: 'In Meta for Developers: WhatsApp, API Setup' },
      { key: 'template', label: 'Approved template name', hint: 'A template with one {{1}} in its body, where the message goes' },
      { key: 'language', label: 'Template language code', hint: 'For example en or en_US' },
      { key: 'token', label: 'Access token', hint: 'A permanent token of a system user', secret: true },
    ],
  },
  {
    value: 'TWILIO',
    label: 'Twilio',
    fields: [
      { key: 'sid', label: 'Account SID', hint: 'Starts with AC' },
      { key: 'token', label: 'Auth token', secret: true },
      { key: 'from', label: 'Your WhatsApp number', hint: 'With country code, for example +14155238886' },
    ],
  },
];

const clean = (v: string | undefined) => (v ?? '').trim();

/** The settings for a provider, or the name of the first detail still missing. */
export function whatsappPreset(provider: WhatsappProvider, d: Record<string, string>): PresetResult | { missing: string } {
  const def = WHATSAPP_PROVIDERS.find((p) => p.value === provider)!;
  const gap = def.fields.find((f) => !clean(d[f.key]));
  if (gap) return { missing: gap.label };
  if (provider === 'META') {
    const body = {
      messaging_product: 'whatsapp',
      to: '{{to}}',
      type: 'template',
      template: { name: clean(d.template), language: { code: clean(d.language) }, components: [{ type: 'body', parameters: [{ type: 'text', text: '{{message}}' }] }] },
    };
    return {
      url: `https://graph.facebook.com/v20.0/${encodeURIComponent(clean(d.phoneNumberId))}/messages`,
      method: 'POST',
      format: 'JSON',
      body: JSON.stringify(body),
      headerName: 'Authorization',
      headerValue: `Bearer ${clean(d.token)}`,
    };
  }
  const from = clean(d.from).replace(/[\s()-]/g, '');
  return {
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(clean(d.sid))}/Messages.json`,
    method: 'POST',
    format: 'FORM',
    body: `From=${encodeURIComponent(`whatsapp:${from}`)}&To=whatsapp%3A{{to}}&Body={{message}}`,
    headerName: 'Authorization',
    headerValue: `Basic ${btoa(`${clean(d.sid)}:${clean(d.token)}`)}`,
  };
}
