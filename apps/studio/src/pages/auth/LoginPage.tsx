import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { isApiError, useAuth } from '../../lib/auth';
import { Alert, Button, TextField } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

export default function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(() => new URLSearchParams(location.search).get('sso_error') ?? undefined);
  const [ssoRequired, setSsoRequired] = useState(false);
  const [unverified, setUnverified] = useState(false);
  const [notice, setNotice] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setUnverified(false);
    try {
      await signIn(email, password, step === 'code' ? code.trim() : undefined);
      navigate(from, { replace: true });
    } catch (err) {
      if (isApiError(err, 'TWO_FACTOR_REQUIRED')) {
        setStep('code');
      } else if (isApiError(err, 'SSO_REQUIRED')) {
        setSsoRequired(true);
        setError(errorMessage(err));
      } else if (isApiError(err, 'EMAIL_NOT_VERIFIED')) {
        setUnverified(true);
      } else {
        setError(errorMessage(err));
        if (step === 'code') setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  /** A full-page trip to the organisation's identity provider and back. */
  const signInWithSso = async () => {
    if (!email.includes('@')) return setError('Enter your work email, then choose single sign-on.');
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>('/auth/sso/start', { method: 'POST', body: { email: email.trim() } });
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const resend = async () => {
    await api('/auth/resend-verification', { method: 'POST', body: { email } }).catch(() => undefined);
    setNotice('We sent a new confirmation link. Check your inbox.');
    setUnverified(false);
  };

  if (step === 'code') {
    return (
      <AuthLayout title="Two-factor check" subtitle={useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}>
        <form className="st-stack" onSubmit={submit} noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          {useRecovery ? (
            <TextField label="Recovery code" placeholder="xxxxx-xxxxx" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
          ) : (
            <TextField
              label="Authentication code"
              className="st-input--code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          )}
          <Button type="submit" block busy={busy} disabled={useRecovery ? code.trim().length < 8 : code.length !== 6}>
            Verify and sign in
          </Button>
          <div className="st-row" style={{ justifyContent: 'space-between' }}>
            <Button variant="ghost" size="sm" onClick={() => (setUseRecovery(!useRecovery), setCode(''), setError(undefined))}>
              {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => (setStep('password'), setCode(''), setError(undefined))}>
              Back
            </Button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in to your Form Builder workspace.">
      <form className="st-stack" onSubmit={submit} noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        {notice && <Alert tone="success">{notice}</Alert>}
        {unverified && (
          <Alert tone="warn">
            Confirm your email first - we sent you a link.{' '}
            <button type="button" className="st-link" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} onClick={resend}>
              Send it again
            </button>
          </Alert>
        )}
        <TextField label="Work email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          hint={
            <Link className="st-link" to="/forgot-password">
              Forgot your password?
            </Link>
          }
        />
        <Button type="submit" block busy={busy} disabled={!email || !password}>
          Sign in
        </Button>
        <div className="st-auth__or">or</div>
        <Button variant={ssoRequired ? 'primary' : 'secondary'} block onClick={() => void signInWithSso()}>
          Sign in with SSO
        </Button>
      </form>
      <p className="st-auth__foot">
        New to Form Builder?{' '}
        <Link className="st-link" to="/signup">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}
