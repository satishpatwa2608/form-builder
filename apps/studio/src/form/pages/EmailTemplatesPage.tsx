import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ui/dialog';
import { SmartTable, type SmartTableColumn } from '@ui/smart-table';
import { messageOf } from '../adapters/backend';
import { useDeleteEmail, useSavedEmails, useSaveEmail, type SavedEmail } from '../adapters/email-templates';
import { useFormPermissions } from '../hooks/useFormPermissions';
import { ConfirmDialog, type ConfirmRequest } from '../builder/components/ConfirmDialog';
import { TextSetting } from '../builder/components/settings';
import '../styles/form-builder.css';

function EmailDialog({ email, onClose }: { email?: SavedEmail; onClose: () => void }) {
  const save = useSaveEmail();
  const [name, setName] = useState(email?.name ?? '');
  const [subject, setSubject] = useState(email?.subject ?? '');
  const [body, setBody] = useState(email?.body ?? '');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent style={{ width: 'min(680px, 96vw)', maxWidth: '96vw' }}>
        <DialogHeader>
          <DialogTitle>{email ? email.name : 'New email'}</DialogTitle>
          <DialogDescription>Written once, used wherever an email is sent. Using it copies its words, so an email already set up on a form does not change under it.</DialogDescription>
        </DialogHeader>
        <div className="fb-settings">
          <TextSetting label="Name" value={name} onChange={setName} placeholder="Documents needed" hint="What your team sees when they choose it." />
          <TextSetting label="Subject" value={subject} onChange={setSubject} />
          <TextSetting label="Message" multiline value={body} onChange={setBody} hint="Plain text. {{$record.ref}} puts in the reference number, and {{name}} the answer to the field called name on whichever form it is used with." />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!name.trim() || !subject.trim() || !body.trim() || save.isPending}
            onClick={() =>
              void save
                .mutateAsync({ id: email?.id, name: name.trim(), subject: subject.trim(), body: body.trim() })
                .then(onClose)
                .catch((e) => toast.error(messageOf(e)))
            }
          >
            {email ? 'Save' : 'Add to the library'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The organisation's saved emails. Admins manage them; everyone can read and use them. */
export default function EmailTemplatesPage() {
  const { canManagePages } = useFormPermissions();
  const { data = [], isLoading } = useSavedEmails();
  const remove = useDeleteEmail();
  const [editing, setEditing] = useState<SavedEmail | 'new' | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const columns: SmartTableColumn<SavedEmail>[] = [
    { title: 'Email', dataIndex: 'name', render: (name: string) => <strong>{name}</strong> },
    { title: 'Subject', dataIndex: 'subject' },
    { title: 'Message', dataIndex: 'body', render: (body: string) => <span className="fb-muted">{body.length > 120 ? `${body.slice(0, 120)}…` : body}</span> },
    {
      title: '',
      dataIndex: 'id',
      width: 150,
      render: (_: string, m) =>
        canManagePages ? (
          <span className="flex items-center gap-2">
            <button type="button" className="fb-link" aria-label={`Change ${m.name}`} onClick={() => setEditing(m)}>
              Change
            </button>
            <button
              type="button"
              className="fb-link"
              aria-label={`Delete ${m.name}`}
              onClick={() => setConfirm({ title: `Delete "${m.name}"?`, description: 'It is removed from the library. Emails already set up with its words keep them.', confirmLabel: 'Delete', destructive: true, onConfirm: () => void remove.mutateAsync(m.id).catch((e) => toast.error(messageOf(e))) })}
            >
              Delete
            </button>
          </span>
        ) : null,
    },
  ];
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4" style={{ flexWrap: 'wrap' }}>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-gray-900">Email templates</h1>
          <p className="text-sm text-muted-foreground">Emails written once and used on any form: when your team writes to a requester from a record, and as the starting words of a workflow's email step.</p>
          <p className="text-sm text-muted-foreground">
            <strong>To use one:</strong> on a record choose Email requester and pick it; in a form's Workflow, add an Email step and choose it under "Start from a saved email".
          </p>
        </div>
        {canManagePages && (
          <Button type="button" onClick={() => setEditing('new')}>
            New email
          </Button>
        )}
      </div>
      <SmartTable<SavedEmail> data={data} columns={columns} loading={isLoading} rowKey="id" pagination={false} emptyText={canManagePages ? 'No saved emails yet. Choose New email.' : 'No saved emails yet. An administrator can add them.'} />
      {editing && <EmailDialog key={editing === 'new' ? 'new' : editing.id} email={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
