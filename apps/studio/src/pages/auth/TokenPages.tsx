import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { Alert, Button, PasswordStrength, TextField, useSubmit } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

const SignInLink = () => (
  <Link className="st-link" to="/login">
    Go to sign in
  </Link>
);

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<{ ok?: boolean; message?: string }>({});
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // the link is single-use: never post it twice (StrictMode)
    started.current = true;
    api<{ message: string }>('/auth/verify-email', { method: 'POST', body: { token } }).then(
      (r) => setState({ ok: true, message: r.message }),
      (e) => setState({ ok: false, message: errorMessage(e) }),
    );
  }, [token]);
  return (
    <AuthLayout title="Confirm your email">
      <div className="st-stack">
        {state.ok === undefined ? <Alert tone="info">Confirming…</Alert> : <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>}
        {state.ok !== undefined && <SignInLink />}
      </div>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    await api('/auth/forgot-password', { method: 'POST', body: { email } });
    setSent(true);
  });
  return (
    <AuthLayout title="Reset your password" subtitle="We'll email you a link to choose a new one.">
      {sent ? (
        <div className="st-stack">
          <Alert tone="success">If an account uses {email}, a reset link is on its way. It works for 1 hour.</Alert>
          <SignInLink />
        </div>
      ) : (
        <form className="st-stack" onSubmit={submit} noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <TextField label="Work email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <Button type="submit" block busy={busy} disabled={!email}>
            Send reset link
          </Button>
          <p className="st-auth__foot">
            <SignInLink />
          </p>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, fields, submit } = useSubmit(async () => {
    await api('/auth/reset-password', { method: 'POST', body: { token: params.get('token') ?? '', password } });
    setDone(true);
  });
  return (
    <AuthLayout title="Choose a new password" subtitle="You'll be signed out on all devices.">
      {done ? (
        <div className="st-stack">
          <Alert tone="success">Password changed. Sign in with the new one.</Alert>
          <SignInLink />
        </div>
      ) : (
        <form className="st-stack" onSubmit={submit} noValidate>
          {error && !fields.password && <Alert tone="error">{error}</Alert>}
          <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={fields.password} autoFocus />
          <PasswordStrength value={password} />
          <Button type="submit" block busy={busy} disabled={password.length < 10}>
            Change password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function AcceptInvitePage() {
  const [params] = useSearchParams();
  const [existing, setExisting] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, fields, submit } = useSubmit(async () => {
    await api('/invitations/accept', { method: 'POST', body: { token: params.get('token') ?? '', password, ...(existing ? {} : { name }) } });
    setDone(true);
  });
  return (
    <AuthLayout title="Join your team" subtitle="You've been invited to an organisation on Form Builder.">
      {done ? (
        <div className="st-stack">
          <Alert tone="success">You have joined. Sign in to continue.</Alert>
          <SignInLink />
        </div>
      ) : (
        <form className="st-stack" onSubmit={submit} noValidate>
          {error && !Object.keys(fields).length && <Alert tone="error">{error}</Alert>}
          <div className="st-row" role="group" aria-label="Account">
            <Button variant={existing ? 'secondary' : 'primary'} size="sm" onClick={() => setExisting(false)} aria-pressed={!existing}>
              I'm new here
            </Button>
            <Button variant={existing ? 'primary' : 'secondary'} size="sm" onClick={() => setExisting(true)} aria-pressed={existing}>
              I already have an account
            </Button>
          </div>
          {!existing && <TextField label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={fields.name} />}
          <TextField
            label={existing ? 'Your password' : 'Choose a password'}
            type="password"
            autoComplete={existing ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fields.password}
          />
          {!existing && <PasswordStrength value={password} />}
          <Button type="submit" block busy={busy} disabled={existing ? !password : !name || password.length < 10}>
            Accept invitation
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
