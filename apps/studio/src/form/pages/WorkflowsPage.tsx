import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { SmartTable, type SmartTableColumn } from '@ui/smart-table';
import { messageOf } from '../adapters/backend';
import { useDeleteSharedWorkflow, useSharedWorkflows, type LibraryWorkflow, type WorkflowUse } from '../adapters/shared-workflows';
import { useFormPermissions } from '../hooks/useFormPermissions';
import { ConfirmDialog, type ConfirmRequest } from '../builder/components/ConfirmDialog';
import { LibraryWorkflowDialog } from '../builder/workflow/LibraryWorkflowDialog';
import '../styles/form-builder.css';

const formsOf = (uses: WorkflowUse[]) => [...new Set(uses.map((u) => u.name))].join(', ');

/** The workflow library: processes built once and used by several forms. Admins manage it; every member can look. */
export default function WorkflowsPage() {
  const { canManagePages } = useFormPermissions();
  const { data = [], isLoading } = useSharedWorkflows();
  const remove = useDeleteSharedWorkflow();
  const [editing, setEditing] = useState<LibraryWorkflow | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  const columns: SmartTableColumn<LibraryWorkflow>[] = [
    {
      title: 'Workflow',
      dataIndex: 'name',
      render: (name: string, w) => (
        <span>
          <strong>{name}</strong>
          {w.description && <span className="fb-muted" style={{ display: 'block' }}>{w.description}</span>}
        </span>
      ),
    },
    { title: 'Statuses', dataIndex: 'workflow', render: (_: unknown, w) => w.workflow.statuses.map((s) => s.label).join(' → ') },
    { title: 'Reads from the form', dataIndex: 'fields', render: (_: unknown, w) => (w.fields.length ? w.fields.map((f) => f.label).join(', ') : 'Nothing') },
    { title: 'Used by', dataIndex: 'usedBy', render: (uses: WorkflowUse[]) => (uses.length ? formsOf(uses) : 'No form yet') },
    {
      title: '',
      dataIndex: 'id',
      width: 150,
      render: (_: string, w) => (
        <span className="flex items-center gap-2">
          <button type="button" className="fb-link" aria-label={`${canManagePages ? 'Edit' : 'View'} ${w.name}`} onClick={() => setEditing(w)}>
            {canManagePages ? 'Edit' : 'View'}
          </button>
          {canManagePages && (
            <button
              type="button"
              className="fb-link"
              aria-label={`Delete ${w.name}`}
              onClick={() =>
                w.usedBy.length
                  ? toast.error(`"${w.name}" is used by ${formsOf(w.usedBy)}. Give those forms another workflow first.`)
                  : setConfirm({
                      title: `Delete "${w.name}"?`,
                      description: 'It is removed from the library. Forms already published keep the copy they were published with.',
                      confirmLabel: 'Delete',
                      destructive: true,
                      onConfirm: () => void remove.mutateAsync(w.id).catch((e) => toast.error(messageOf(e))),
                    })
              }
            >
              Delete
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4" style={{ flexWrap: 'wrap' }}>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-gray-900">Workflows</h1>
          <p className="text-sm text-muted-foreground">Build a process once and use it on several forms. To use one, open a form's Workflow and choose it.</p>
        </div>
        {canManagePages && (
          <Button type="button" onClick={() => setEditing(null)}>
            <Plus /> New workflow
          </Button>
        )}
      </div>
      <SmartTable<LibraryWorkflow>
        data={data}
        columns={columns}
        loading={isLoading}
        rowKey="id"
        pagination={false}
        emptyText={canManagePages ? 'No shared workflows yet. Build one here, or open a form\'s Workflow and choose "Save to library".' : 'No shared workflows yet. An administrator can add them.'}
      />
      {editing !== undefined && <LibraryWorkflowDialog key={editing?.id ?? 'new'} initial={editing} readOnly={!canManagePages} onClose={() => setEditing(undefined)} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
