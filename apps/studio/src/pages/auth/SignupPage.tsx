import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { Alert, Button, PasswordStrength, TextField, useSubmit } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

export default function SignupPage() {
  const [form, setForm] = useState({ name: '', email: '', orgName: '', password: '' });
  const [sent, setSent] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const { busy, error, fields, submit } = useSubmit(async () => {
    await api('/auth/signup', { method: 'POST', body: form });
    setSent(true);
  });

  if (sent) {
    return (
      <AuthLayout title="Check your email" subtitle={`We sent a confirmation link to ${form.email}. It works for 24 hours.`}>
        <div className="st-stack">
          <Alert tone="info">
            <MailCheck size={14} style={{ verticalAlign: -2 }} /> Open the link on this device to finish setting up {form.orgName}.
          </Alert>
          <Button variant="secondary" block onClick={() => api('/auth/resend-verification', { method: 'POST', body: { email: form.email } })}>
            Send the link again
          </Button>
          <p className="st-auth__foot">
            Already confirmed?{' '}
            <Link className="st-link" to="/login">
              Sign in
            </Link>
          </p>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Create your workspace" subtitle="Free to start. You'll be the owner of your organisation.">
      <form className="st-stack" onSubmit={submit} noValidate>
        {error && !Object.keys(fields).length && <Alert tone="error">{error}</Alert>}
        <TextField label="Your name" autoComplete="name" value={form.name} onChange={set('name')} error={fields.name} autoFocus />
        <TextField label="Work email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={fields.email} />
        <TextField label="Organisation name" autoComplete="organization" value={form.orgName} onChange={set('orgName')} error={fields.orgName} />
        <TextField label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={fields.password} />
        <PasswordStrength value={form.password} />
        <Button type="submit" block busy={busy} disabled={!form.name || !form.email || !form.orgName || form.password.length < 10}>
          Create account
        </Button>
      </form>
      <p className="st-auth__foot">
        Already have an account?{' '}
        <Link className="st-link" to="/login">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
