import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@ui/button';
import type { EmailTemplate, FormDefinition, WorkflowConfig } from '../../types';
import { TextSetting } from '../components/settings';
import { actionKeyFrom, placeholders } from './workflow-edits';

interface EmailTemplatesEditorProps {
  form: FormDefinition;
  onChange: (wf: WorkflowConfig) => void;
}

/** Ready-made emails the team picks in "Email requester" (they can still edit before sending). */
export function EmailTemplatesEditor({ form, onChange }: EmailTemplatesEditorProps) {
  const wf = form.workflow;
  if (!wf?.enabled) return <p className="fb-muted">Turn on "Track submissions as records" (Process tab) to email requesters.</p>;
  const templates = wf.emailTemplates ?? [];
  const set = (list: EmailTemplate[]) => onChange({ ...wf, emailTemplates: list.length ? list : undefined });
  const update = (i: number, changes: Partial<EmailTemplate>) => set(templates.map((t, j) => (j === i ? { ...t, ...changes } : t)));
  const tokens = placeholders(form).join(' ');

  return (
    <div className="fb-settings" style={{ gap: 12 }}>
      <p className="fb-muted">
        Emails go to the requester from the item's drawer ("Email requester"). They're outbound only: replies go to the sender's own mailbox.
        You can use {tokens} and <span className="fb-code">{'{{$work.<key>}}'}</span>.
      </p>
      {templates.map((t, i) => (
        <section key={i} className="fb-panel fb-settings" style={{ gap: 8 }} aria-label={`Template ${t.name}`}>
          <div className="flex items-center gap-2">
            <div style={{ flex: 1 }}>
              <TextSetting
                label="Template name"
                value={t.name}
                onChange={(name) => update(i, { name, key: t.key.startsWith('template_') || t.key === actionKeyFrom(t.name) ? actionKeyFrom(name) : t.key })}
              />
            </div>
            <button type="button" className="fb-icon-btn fb-icon-btn--danger" aria-label={`Delete template ${t.name}`} style={{ alignSelf: 'flex-end' }} onClick={() => set(templates.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </button>
          </div>
          <TextSetting label="Subject" value={t.subject} onChange={(subject) => update(i, { subject })} />
          <TextSetting label="Message" multiline value={t.body} hint="Plain text." onChange={(body) => update(i, { body })} />
        </section>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        style={{ alignSelf: 'flex-start' }}
        onClick={() =>
          set([...templates, { key: `template_${templates.length + 1}`, name: 'Request information', subject: 'About your request {{$record.ref}}', body: 'Hello,\n\nCould you send us ...' }])
        }
      >
        <Plus /> Add email template
      </Button>
    </div>
  );
}
