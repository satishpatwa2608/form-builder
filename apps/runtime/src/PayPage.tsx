import { useCallback, useEffect, useState } from 'react';
import { PublicApiError, publicApi, trySession } from './api';

/** /pay/:payment and /pay/:payment/practice (with ?org=…): where a person lands after paying, and the practice payment page. */
export function parsePayPath(pathname: string, search: string): { id: string; org: string; practice: boolean } | null {
  const m = pathname.match(/^\/pay\/([0-9a-f-]{36})(\/practice)?\/?$/);
  const org = new URLSearchParams(search).get('org') ?? '';
  return m && /^[A-Za-z0-9-]{1,64}$/.test(org) ? { id: m[1]!, org, practice: !!m[2] } : null;
}

interface Outcome {
  status: 'PENDING' | 'PAID' | 'SUBMITTED' | 'FAILED';
  ref?: string;
  formCode?: string;
  payment?: string;
}
interface Look {
  status: Outcome['status'];
  amount: number;
  currency: string;
  formCode: string;
  practice: boolean;
  ref: string;
}

const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
};

export default function PayPage({ id, org, practice }: { id: string; org: string; practice: boolean }) {
  const [look, setLook] = useState<Look | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const at = (path = '') => `/payments/${id}${path}?org=${encodeURIComponent(org)}`;

  const ask = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true);
      setError('');
      try {
        setOutcome(await publicApi<Outcome>(`/payments/${id}${path}?org=${encodeURIComponent(org)}`, { method: 'POST', body }));
      } catch (e) {
        setError((e as PublicApiError).message);
      } finally {
        setBusy(false);
      }
    },
    [id, org],
  );

  useEffect(() => {
    void (async () => {
      // A form for signed-in people keeps its payment to the person who filled it in.
      await trySession();
      try {
        const seen = await publicApi<Look>(at());
        setLook(seen);
        // Back from the payment page: find out how it went. On the practice page the person says so first.
        if (!practice || seen.status !== 'PENDING') await ask('/confirm');
      } catch (e) {
        setError((e as PublicApiError).status === 404 ? 'This payment was not found. Check the link, or start the form again.' : (e as PublicApiError).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formLink = look ? `/f/${encodeURIComponent(org)}/${encodeURIComponent(look.formCode)}` : '/';
  let body;
  if (error && !outcome) body = <Card title="We could not check your payment">{error}</Card>;
  else if (!look) body = <Card title="One moment…" />;
  else if (outcome?.status === 'SUBMITTED')
    body = (
      <Card title="Thank you. Your payment was received.">
        <p>Your response has been registered{outcome.ref ? <> under the reference <strong>{outcome.ref}</strong></> : null}.</p>
        <p>You paid {money(look.amount, look.currency)}. You can close this page.</p>
      </Card>
    );
  else if (outcome?.status === 'FAILED')
    body = (
      <Card title="The payment did not go through">
        <p>No money was taken and your response was not registered.</p>
        <p>
          <a className="fb-link" href={formLink}>
            Fill in the form again
          </a>
        </p>
      </Card>
    );
  else if (outcome?.status === 'PAID')
    body = (
      <Card title="Your payment was received">
        <p>
          But we could not register your response. Please contact the organisation and quote this payment: <strong>{id}</strong>. You do not need to pay again.
        </p>
      </Card>
    );
  else if (practice && (!outcome || outcome.status === 'PENDING'))
    body = (
      <Card title="Practice payment">
        <p>
          This form is set to practice payments, so <strong>no money moves</strong>. Choose how the payment should go, to see what the person filling in the form would see.
        </p>
        <p className="rt-pay__amount">{money(look.amount, look.currency)}</p>
        <div className="rt-pay__actions">
          <button type="button" className="rt-save__btn rt-pay__primary" disabled={busy} onClick={() => void ask('/practice', { outcome: 'PAID' })}>
            Pay
          </button>
          <button type="button" className="rt-save__btn" disabled={busy} onClick={() => void ask('/practice', { outcome: 'FAILED' })}>
            Let it fail
          </button>
        </div>
        {error && <p className="rt-banner rt-banner--error">{error}</p>}
      </Card>
    );
  else
    body = (
      <Card title="We have not received your payment yet">
        <p>If you have just paid, it can take a moment to reach us.</p>
        <div className="rt-pay__actions">
          <button type="button" className="rt-save__btn rt-pay__primary" disabled={busy} onClick={() => void ask('/confirm')}>
            Check again
          </button>
        </div>
        {error && <p className="rt-banner rt-banner--error">{error}</p>}
      </Card>
    );

  return <main className="fp-public">{body}</main>;
}

function Card({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="fp-public__card fp-public__notice" role="status">
      <h1 className="rt-title">{title}</h1>
      {children && <div className="rt-soft">{children}</div>}
    </div>
  );
}
