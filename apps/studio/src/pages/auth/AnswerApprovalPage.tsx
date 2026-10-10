import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../../lib/api';
import { Alert, Button, useSubmit } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

interface Asked {
  title: string;
  instructions: string;
  form: string;
  reference: string;
  askedOf: string;
  /** It can still be answered with this link. */
  open: boolean;
  decision: 'APPROVED' | 'REJECTED' | null;
}

/**
 * The page behind the link in an approval email. Opening it only shows what is asked: mail programs open links
 * by themselves to check them, so nothing is decided until the person presses Approve or Reject.
 */
export function AnswerApprovalPage() {
  const [params] = useSearchParams();
  const key = params.get('key') ?? '';
  const [asked, setAsked] = useState<Asked>();
  const [failed, setFailed] = useState<string>();
  const [comment, setComment] = useState('');
  const [answered, setAnswered] = useState<'APPROVED' | 'REJECTED'>();

  useEffect(() => {
    api<Asked>('/public/approvals/look', { method: 'POST', body: { key } }).then(setAsked, (e) => setFailed(errorMessage(e)));
  }, [key]);

  // What was pressed, read when the request is made (a ref, so it is never the choice of an earlier render).
  const choice = useRef<'APPROVED' | 'REJECTED'>('APPROVED');
  const [pressed, setPressed] = useState<'APPROVED' | 'REJECTED'>();
  const decide = useSubmit(async () => {
    await api('/public/approvals/decide', { method: 'POST', body: { key, decision: choice.current, comment: comment.trim() || undefined } });
    setAnswered(choice.current);
  });
  const answer = (decision: 'APPROVED' | 'REJECTED') => {
    choice.current = decision;
    setPressed(decision);
    void decide.submit();
  };

  const signIn = (
    <Link className="st-link" to="/login">
      Sign in to see the record
    </Link>
  );
  return (
    <AuthLayout title="Your approval is asked" subtitle={asked ? `${asked.form}${asked.reference ? ` · ${asked.reference}` : ''}` : undefined}>
      <div className="st-stack">
        {failed && (
          <>
            <Alert tone="error">{failed}</Alert>
            {signIn}
          </>
        )}
        {!failed && !asked && <Alert tone="info">Looking it up…</Alert>}
        {asked && answered && (
          <>
            <Alert tone="success">{answered === 'APPROVED' ? 'Approved.' : 'Rejected.'} Thank you{asked.askedOf ? `, ${asked.askedOf}` : ''}. You can close this page.</Alert>
            {signIn}
          </>
        )}
        {asked && !answered && (
          <>
            <strong>{asked.title}</strong>
            {asked.instructions && <p style={{ whiteSpace: 'pre-wrap' }}>{asked.instructions}</p>}
            {asked.open ? (
              <>
                {decide.error && <Alert tone="error">{decide.error}</Alert>}
                <label className="st-field">
                  <span className="st-label">Comment (optional)</span>
                  <textarea className="st-input" rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
                </label>
                <div className="st-row">
                  <Button busy={decide.busy && pressed === 'APPROVED'} disabled={decide.busy} onClick={() => answer('APPROVED')}>
                    Approve
                  </Button>
                  <Button variant="secondary" busy={decide.busy && pressed === 'REJECTED'} disabled={decide.busy} onClick={() => answer('REJECTED')}>
                    Reject
                  </Button>
                </div>
                <p className="st-muted">Answering as {asked.askedOf || 'the person this email was sent to'}. This link is yours alone and works once.</p>
              </>
            ) : (
              <>
                <Alert tone="info">{asked.decision ? `This has already been ${asked.decision === 'APPROVED' ? 'approved' : 'rejected'}.` : 'This link can no longer be used to answer.'}</Alert>
                {signIn}
              </>
            )}
          </>
        )}
      </div>
    </AuthLayout>
  );
}
