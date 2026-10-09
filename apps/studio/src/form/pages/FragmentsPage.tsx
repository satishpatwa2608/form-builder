import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ui/dialog';
import { SmartTable, type SmartTableColumn } from '@ui/smart-table';
import { FormDefinitionError, isValueField } from '../engine';
import { messageOf } from '../adapters/backend';
import { useDeleteFragment, useFragments, useSaveFragment, type FragmentUseRow, type LibraryFragment } from '../adapters/fragments';
import { useFormPermissions } from '../hooks/useFormPermissions';
import { ConfirmDialog, type ConfirmRequest } from '../builder/components/ConfirmDialog';
import { TextSetting } from '../builder/components/settings';
import '../styles/form-builder.css';

const formsOf = (uses: FragmentUseRow[]) => [...new Set(uses.map((u) => u.name))].join(', ');

/** Name and description of a fragment. Its fields are changed from a form that uses it. */
function RenameDialog({ fragment, onClose }: { fragment: LibraryFragment; onClose: () => void }) {
  const save = useSaveFragment();
  const [name, setName] = useState(fragment.name);
  const [description, setDescription] = useState(fragment.description ?? '');
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{fragment.name}</DialogTitle>
          <DialogDescription>To change its fields, open a form that uses it, select the section and choose "Change this fragment".</DialogDescription>
        </DialogHeader>
        <div className="fb-settings">
          <TextSetting label="Name" value={name} onChange={setName} />
          <TextSetting label="What it is for" value={description} onChange={setDescription} />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!name.trim() || save.isPending}
            onClick={() =>
              void save
                .mutateAsync({ id: fragment.id, name: name.trim(), description: description.trim(), fields: fragment.fields })
                .then(onClose)
                .catch((e) => toast.error(e instanceof FormDefinitionError ? e.issues.map((i) => i.message).join(' ') : messageOf(e)))
            }
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The fragment library: sections built once and used on several forms. Admins manage it; every member can look. */
export default function FragmentsPage() {
  const { canManagePages } = useFormPermissions();
  const { data = [], isLoading } = useFragments();
  const remove = useDeleteFragment();
  const [editing, setEditing] = useState<LibraryFragment | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const columns: SmartTableColumn<LibraryFragment>[] = [
    {
      title: 'Fragment',
      dataIndex: 'name',
      render: (name: string, f) => (
        <span>
          <strong>{name}</strong>
          {f.description && <span className="fb-muted" style={{ display: 'block' }}>{f.description}</span>}
        </span>
      ),
    },
    { title: 'Fields', dataIndex: 'fields', render: (_: unknown, f) => f.fields.filter(isValueField).map((x) => x.label || x.name).join(', ') },
    { title: 'Used by', dataIndex: 'usedBy', render: (uses: FragmentUseRow[]) => (uses.length ? formsOf(uses) : 'No form yet') },
    {
      title: '',
      dataIndex: 'id',
      width: 150,
      render: (_: string, f) =>
        canManagePages ? (
          <span className="flex items-center gap-2">
            <button type="button" className="fb-link" aria-label={`Rename ${f.name}`} onClick={() => setEditing(f)}>
              Rename
            </button>
            <button
              type="button"
              className="fb-link"
              aria-label={`Delete ${f.name}`}
              onClick={() =>
                f.usedBy.length
                  ? toast.error(`"${f.name}" is used by ${formsOf(f.usedBy)}. Detach it there first.`)
                  : setConfirm({
                      title: `Delete "${f.name}"?`,
                      description: 'It is removed from the library. Forms already published keep the fields they were published with.',
                      confirmLabel: 'Delete',
                      destructive: true,
                      onConfirm: () => void remove.mutateAsync(f.id).catch((e) => toast.error(messageOf(e))),
                    })
              }
            >
              Delete
            </button>
          </span>
        ) : null,
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-gray-900">Fragments</h1>
        <p className="text-sm text-muted-foreground">
          Sections of fields built once and used on several forms, such as an address or bank details. To use one, pick it under Fragments in a form's palette.
        </p>
      </div>
      <SmartTable<LibraryFragment>
        data={data}
        columns={columns}
        loading={isLoading}
        rowKey="id"
        pagination={false}
        emptyText={canManagePages ? 'No fragments yet. In a form, select a section and choose "Save as fragment".' : 'No fragments yet. An administrator can add them.'}
      />
      {editing && <RenameDialog key={editing.id} fragment={editing} onClose={() => setEditing(undefined)} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
