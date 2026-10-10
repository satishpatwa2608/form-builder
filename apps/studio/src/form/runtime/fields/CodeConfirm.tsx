import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import type { FormField } from '../../types';
import { codeConfirmer, isConfirmed, rememberProof } from '../../adapters/codes/code-confirmer';
import { useFormRuntime } from '../FormRuntimeContext';

type Key = Parameters<ReturnType<typeof useFormRuntime>['ui']>[0];

/**
 * Under an email or phone field the designer asked to be confirmed: send a code to what was typed, take the
 * code back, and show that it is confirmed. Changing the answer afterwards asks for a new code.
 */
export function CodeConfirm({ field, value }: { field: FormField; value: string }) {
  const { definition, ui } = useFormRuntime();
  const email = field.type === 'EMAIL';
  const say = (forEmail: Key, forPhone: Key) => ui(email ? forEmail : forPhone);
  const [stage, setStage] = useState<'idle' | 'sent'>('idle');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [, redraw] = useState(0);
  const confirmed = isConfirmed(definition, field.name, value);

  // A different answer is a different thing to confirm.
  useEffect(() => {
    setStage('idle');
    setCode('');
    setMessage('');
  }, [value]);

  if (confirmed)
    return (
      <p className="fb-code fb-code--ok" role="status">
        <CheckCircle2 size={16} aria-hidden /> {say('codeDoneEmail', 'codeDonePhone')}
      </p>
    );

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      setMessage((e as Error).message || ui('codeFailed'));
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    run(async () => {
      await codeConfirmer().send(definition, field.name, value);
      setStage('sent');
    });
  const check = () =>
    run(async () => {
      rememberProof(definition, field.name, value, await codeConfirmer().check(definition, field.name, value, code.trim()));
      redraw((n) => n + 1);
    });

  return (
    <div className="fb-code">
      {stage === 'idle' ? (
        <Button type="button" variant="outline" size="sm" disabled={busy || !value.trim()} onClick={() => void send()}>
          {say('codeSendEmail', 'codeSendPhone')}
        </Button>
      ) : (
        <div className="fb-code__row">
          <Input
            aria-label={say('codeBoxEmail', 'codeBoxPhone')}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder={ui('codePlaceholder')}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (code.length === 6) void check();
              }
            }}
            style={{ maxWidth: 160 }}
          />
          <Button type="button" size="sm" disabled={busy || code.length !== 6} onClick={() => void check()}>
            {ui('codeConfirm')}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void send()}>
            {ui('codeAgain')}
          </Button>
        </div>
      )}
      {stage === 'sent' && !message && <p className="fb-code__hint">{ui('codeSent')}</p>}
      {message && (
        <p className="fb-code__error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
