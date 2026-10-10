/** A payment service, as much of one as taking a payment for a form needs. Each sends the person to its own page. */
export interface PaymentProvider {
  /** Asks for a payment and returns the service's name for it and the page to send the person to. */
  create(ask: { amountMinor: number; currency: string; description: string; reference: string; returnUrl: string }): Promise<{ providerRef: string; url: string }>;
  /** Asked of the service itself, never taken from what the browser says. */
  status(providerRef: string): Promise<{ paid: boolean; failed?: boolean; amountMinor: number; currency: string }>;
}
export interface ProviderKeys {
  keyId: string;
  secret: string;
}
export const PROVIDERS = {
  NONE: 'None',
  TEST: 'Practice payments (no money moves)',
  RAZORPAY: 'Razorpay',
  STRIPE: 'Stripe',
} as const;
export type ProviderId = keyof typeof PROVIDERS;

/** Currencies with no smaller unit: 500 yen is 500, not 50,000. */
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
export const toMinor = (amount: number, currency: string) => Math.round(amount * (ZERO_DECIMAL.has(currency) ? 1 : 100));
export const fromMinor = (minor: number, currency: string) => (ZERO_DECIMAL.has(currency) ? minor : minor / 100);

class ProviderError extends Error {}
async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  } catch {
    throw new ProviderError('The payment service could not be reached');
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* not JSON: reported by status below */
  }
  if (!res.ok) {
    const error = json.error as { description?: string; message?: string } | undefined;
    throw new ProviderError(`The payment service answered ${res.status}${error?.description || error?.message ? `: ${String(error.description ?? error.message).slice(0, 200)}` : ''}`);
  }
  return json;
}

/** Razorpay payment links: a page of Razorpay's own that takes cards, UPI, net banking and wallets. */
export class RazorpayProvider implements PaymentProvider {
  constructor(
    private readonly keys: ProviderKeys,
    private readonly base = 'https://api.razorpay.com',
  ) {}
  private get headers() {
    return { Authorization: `Basic ${Buffer.from(`${this.keys.keyId}:${this.keys.secret}`).toString('base64')}`, 'Content-Type': 'application/json' };
  }
  async create(ask: { amountMinor: number; currency: string; description: string; reference: string; returnUrl: string }) {
    const body = { amount: ask.amountMinor, currency: ask.currency, description: ask.description.slice(0, 200), reference_id: ask.reference, callback_url: ask.returnUrl, callback_method: 'get' };
    const made = await call(`${this.base}/v1/payment_links`, { method: 'POST', headers: this.headers, body: JSON.stringify(body) });
    if (typeof made.id !== 'string' || typeof made.short_url !== 'string') throw new ProviderError('The payment service did not give a page to pay on');
    return { providerRef: made.id, url: made.short_url };
  }
  async status(providerRef: string) {
    const link = await call(`${this.base}/v1/payment_links/${encodeURIComponent(providerRef)}`, { method: 'GET', headers: this.headers });
    return { paid: link.status === 'paid', failed: link.status === 'cancelled' || link.status === 'expired', amountMinor: Number(link.amount_paid ?? 0), currency: String(link.currency ?? '').toUpperCase() };
  }
}

/** Stripe Checkout: a page of Stripe's own. */
export class StripeProvider implements PaymentProvider {
  constructor(
    private readonly keys: ProviderKeys,
    private readonly base = 'https://api.stripe.com',
  ) {}
  private get headers() {
    return { Authorization: `Bearer ${this.keys.secret}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  }
  async create(ask: { amountMinor: number; currency: string; description: string; reference: string; returnUrl: string }) {
    const form = new URLSearchParams({
      mode: 'payment',
      success_url: ask.returnUrl,
      cancel_url: ask.returnUrl,
      client_reference_id: ask.reference,
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': ask.currency.toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(ask.amountMinor),
      'line_items[0][price_data][product_data][name]': ask.description.slice(0, 200),
    });
    const made = await call(`${this.base}/v1/checkout/sessions`, { method: 'POST', headers: this.headers, body: form.toString() });
    if (typeof made.id !== 'string' || typeof made.url !== 'string') throw new ProviderError('The payment service did not give a page to pay on');
    return { providerRef: made.id, url: made.url };
  }
  async status(providerRef: string) {
    const session = await call(`${this.base}/v1/checkout/sessions/${encodeURIComponent(providerRef)}`, { method: 'GET', headers: this.headers });
    return { paid: session.payment_status === 'paid', failed: session.status === 'expired', amountMinor: Number(session.amount_total ?? 0), currency: String(session.currency ?? '').toUpperCase() };
  }
}
