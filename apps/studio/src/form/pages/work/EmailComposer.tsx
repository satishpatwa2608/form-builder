import { useState } from 'react';
import { Mail } from 'lucide-react';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import { Input } from '@ui/input';
import { Textarea } from '@ui/textarea';
import type { EmailTemplate } from '../../types';
import { fieldErrorsOf, messageOf } from '../../adapters/backend';
import { useSavedEmails } from '../../adapters/email-templates';
import { ChoiceSelect } from '../../builder/components/settings';
import { VISIBLE_BORDER } from '../../runtime/styles';

interface EmailComposerProps {
  to: string;
  templates: EmailTemplate[];
  /** Label of the status "request information" moves to, if the form has one. */
  requestInfoLabel?: string;
  busy: boolean;
  onSend: (mail: { subject: string; body: string; templateKey?: string; requestInfo?: boolean }) => Promise<unknown>;
}

const NONE = '__none__';
/** A saved email from the library, not one of the form's own: its key is not one the form knows. */
const LIBRARY = 'library:';

/**
 * Email the requester from the item: pick a template or write one; {{tokens}}
 * are filled on the server. Outbound only - replies reach the sender's mailbox.
 */
export function EmailComposer({ to, templates: own, requestInfoLabel, busy, onSend }: EmailComposerProps) {
  // The form's own templates first, then the organisation's saved emails.
  const { data: saved = [] } = useSavedEmails();
  const templates = [...own, ...saved.filter((m) => !own.some((t) => t.name === m.name)).map((m) => ({ key: `${LIBRARY}${m.id}`, name: m.name, subject: m.subject, body: m.body }))];
  const [open, setOpen] = useState(false);
  const [templateKey, setTemplateKey] = useState<string>();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [requestInfo, setRequestInfo] = useState(false);
  const [error, setError] = useState('');

  if (!to) return <p className="fb-muted">No email address for the requester on this item.</p>;
  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        <Mail /> Email requester
      </Button>
    );
  }

  const pick = (key: string) => {
    const t = templates.find((x) => x.key === key);
    setTemplateKey(t?.key);
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
    }
  };

  const send = async () => {
    setError('');
    try {
      await onSend({ subject, body, templateKey: templateKey?.startsWith(LIBRARY) ? undefined : templateKey, requestInfo: requestInfo || undefined });
      setOpen(false);
      setSubject('');
      setBody('');
      setTemplateKey(undefined);
      setRequestInfo(false);
    } catch (e) {
      setError(fieldErrorsOf(e)?.map((f) => `${f.field}: ${f.message}`).join(', ') || messageOf(e));
    }
  };

  return (
    <div className="fb-panel fb-settings" style={{ gap: 8 }} aria-label="Email requester">
      <div className="text-sm">
        To <strong>{to}</strong>
      </div>
      {templates.length > 0 && (
        <ChoiceSelect
          ariaLabel="Email template"
          placeholder="Start from a template…"
          value={templateKey ?? NONE}
          options={[{ label: 'No template', value: NONE }, ...templates.map((t) => ({ label: t.name, value: t.key }))]}
          onChange={(k) => (k === NONE ? setTemplateKey(undefined) : pick(k))}
        />
      )}
      <Input aria-label="Email subject" placeholder="Subject" value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
      <Textarea className={VISIBLE_BORDER} aria-label="Email message" rows={6} placeholder="Message" value={body} onChange={(e) => setBody(e.target.value)} />
      <span className="fb-setting__hint">{'{{name}}, {{$record.ref}}... are filled in when it is sent. Your name and email are added at the end.'}</span>
      {requestInfoLabel && (
        <label className="flex items-center gap-2 text-sm">
          <Checkbox className={VISIBLE_BORDER} checked={requestInfo} onCheckedChange={(c) => setRequestInfo(c === true)} />
          Request information - move the item to "{requestInfoLabel}"
        </label>
      )}
      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--destructive)', fontSize: 13 }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={busy || !subject.trim() || !body.trim()} onClick={() => void send()}>
          Send
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
