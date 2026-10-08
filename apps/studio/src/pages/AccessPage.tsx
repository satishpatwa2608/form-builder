import { useMemo, useState } from 'react';
import { ChevronRight, Folder as FolderIcon, FolderPlus, Pencil, Trash2, UserPlus, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useFolderPermissions, useFolders, useGrants, useMembers } from '../lib/queries';
import { ROLE_LABEL, type Folder, type ScopedRole } from '../lib/types';
import { Alert, Avatar, Badge, Button, Card, PageHead, SelectField, TextField } from '../components/ui';

const FOLDER_ROLES: ScopedRole[] = ['DESIGNER', 'PUBLISHER', 'RECORDS_WORKER', 'VIEWER'];
const PERMISSION_LABEL: Record<string, string> = {
  'form.view': 'View forms',
  'form.edit': 'Edit forms',
  'form.publish': 'Publish forms',
  'record.work': 'Work records',
  'folder.manage': 'Manage folders',
};

function Tree({ folders, parentId, selected, onSelect }: { folders: Folder[]; parentId: string | null; selected?: string; onSelect: (id: string) => void }) {
  const children = folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
  if (!children.length) return null;
  return (
    <ul className="st-tree" role={parentId ? 'group' : 'tree'} aria-label={parentId ? undefined : 'Folders'}>
      {children.map((f) => (
        <li key={f.id} role="treeitem" aria-selected={selected === f.id}>
          <div aria-selected={selected === f.id} onClick={() => onSelect(f.id)}>
            <FolderIcon size={16} />
            {f.name}
          </div>
          <Tree folders={folders} parentId={f.id} selected={selected} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

export default function AccessPage() {
  const { can } = useAuth();
  const canGrant = can('roles.grant');
  const folders = useFolders();
  const members = useMembers(can('members.view'));
  const [selected, setSelected] = useState<string>();
  const folder = folders.data?.find((f) => f.id === selected);
  const grants = useGrants(selected, canGrant);
  const perms = useFolderPermissions(selected);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string }>();
  const [newName, setNewName] = useState('');
  const [grantUser, setGrantUser] = useState('');
  const [grantRole, setGrantRole] = useState<ScopedRole>('DESIGNER');

  const breadcrumb = useMemo(() => folder?.path.map((id) => folders.data?.find((f) => f.id === id)?.name ?? '…') ?? [], [folder, folders.data]);
  const nameOf = (userId: string) => members.data?.find((m) => m.userId === userId);
  const feedback = (text: string) => ({ onSuccess: () => setMessage({ tone: 'success', text }), onError: (e: Error) => setMessage({ tone: 'error', text: errorMessage(e) }) });

  const create = useAction((body: { name: string; parentId: string | null }) => api('/folders', { method: 'POST', body }), [['folders']]);
  const rename = useAction((a: { id: string; name: string }) => api(`/folders/${a.id}`, { method: 'PATCH', body: { name: a.name } }), [['folders']]);
  const del = useAction((id: string) => api(`/folders/${id}`, { method: 'DELETE' }), [['folders']]);
  const addGrant = useAction((body: object) => api('/grants', { method: 'POST', body }), [['grants', selected ?? '']]);
  const removeGrant = useAction((id: string) => api(`/grants/${id}`, { method: 'DELETE' }), [['grants', selected ?? '']]);

  const addFolder = (parentId: string | null) => {
    if (!newName.trim()) return;
    create.mutate({ name: newName.trim(), parentId }, { ...feedback(`Folder "${newName.trim()}" created.`), onSettled: () => setNewName('') });
  };

  return (
    <>
      <PageHead title="Folders & access" subtitle="Forms live in folders. Give people a role on a folder and it covers everything inside it." />
      {message && (
        <div style={{ marginBottom: 16 }}>
          <Alert tone={message.tone}>{message.text}</Alert>
        </div>
      )}
      <div className="st-access">
        <Card title="Folders" subtitle={`${folders.data?.length ?? 0} in total`}>
          <div className="st-stack">
            {folders.data?.length ? (
              <Tree folders={folders.data} parentId={null} selected={selected} onSelect={setSelected} />
            ) : (
              <p className="st-muted" style={{ margin: 0 }}>
                No folders yet.
              </p>
            )}
            <form
              className="st-stack"
              style={{ gap: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                addFolder(folder && !can('folder.manage') ? folder.id : null);
              }}
            >
              <TextField label={folder ? `New folder` : 'New top-level folder'} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Quality" />
              <div className="st-row">
                {can('folder.manage') && (
                  <Button type="submit" size="sm" variant="secondary" disabled={!newName.trim()} busy={create.isPending}>
                    <FolderPlus size={14} /> At top level
                  </Button>
                )}
                {folder && (
                  <Button size="sm" variant="secondary" disabled={!newName.trim()} onClick={() => addFolder(folder.id)}>
                    <FolderPlus size={14} /> Inside {folder.name}
                  </Button>
                )}
              </div>
            </form>
          </div>
        </Card>

        {folder ? (
          <div className="st-stack">
            <Card
              title={folder.name}
              subtitle={
                <span className="st-row" style={{ gap: 4 }}>
                  {breadcrumb.map((n, i) => (
                    <span key={i} className="st-row" style={{ gap: 4 }}>
                      {i > 0 && <ChevronRight size={12} />}
                      {n}
                    </span>
                  ))}
                </span>
              }
              actions={
                <div className="st-row">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const name = window.prompt('New name', folder.name)?.trim();
                      if (name && name !== folder.name) rename.mutate({ id: folder.id, name }, feedback('Folder renamed.'));
                    }}
                  >
                    <Pencil size={14} /> Rename
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => window.confirm(`Delete "${folder.name}"? Access given on it is removed too.`) && del.mutate(folder.id, { ...feedback('Folder deleted.'), onSettled: () => setSelected(undefined) })}
                  >
                    <Trash2 size={14} /> Delete
                  </Button>
                </div>
              }
            >
              <div className="st-stack" style={{ gap: 8 }}>
                <strong>What you can do here</strong>
                <div className="st-row">
                  {(perms.data?.permissions ?? []).filter((p) => PERMISSION_LABEL[p]).map((p) => (
                    <Badge key={p} tone="accent">
                      {PERMISSION_LABEL[p]}
                    </Badge>
                  ))}
                </div>
              </div>
            </Card>

            {canGrant && (
              <Card title="Who has access" subtitle="Roles given on this folder. Org-wide roles apply everywhere and aren't listed." bodyless>
                {grants.data?.length ? (
                  <div className="st-table-wrap">
                    <table className="st-table">
                      <thead>
                        <tr>
                          <th>Person</th>
                          <th>Role here</th>
                          <th aria-label="Actions" />
                        </tr>
                      </thead>
                      <tbody>
                        {grants.data.map((g) => {
                          const m = nameOf(g.userId);
                          return (
                            <tr key={g.id}>
                              <td>
                                <div className="st-person">
                                  <Avatar name={m?.name ?? '?'} />
                                  <div>
                                    <strong>{m?.name ?? 'Former member'}</strong>
                                    <span>{m?.email}</span>
                                  </div>
                                </div>
                              </td>
                              <td>{ROLE_LABEL[g.role]}</td>
                              <td style={{ textAlign: 'right' }}>
                                <Button variant="ghost" size="sm" onClick={() => removeGrant.mutate(g.id, feedback('Access removed.'))}>
                                  <X size={14} /> Remove
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="st-empty">Nobody has a role on this folder yet.</p>
                )}
                <form
                  className="st-row"
                  style={{ alignItems: 'flex-end', padding: '16px 20px', borderTop: '1px solid var(--fb-line)' }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    addGrant.mutate({ userId: grantUser, role: grantRole, scope: { type: 'folder', id: folder.id } }, feedback(`Access given on ${folder.name}.`));
                  }}
                >
                  <div style={{ flex: '2 1 220px' }}>
                    <SelectField label="Person" value={grantUser} onChange={(e) => setGrantUser(e.target.value)}>
                      <option value="">Choose a member…</option>
                      {(members.data ?? [])
                        .filter((m) => m.status === 'ACTIVE')
                        .map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.name} ({m.email})
                          </option>
                        ))}
                    </SelectField>
                  </div>
                  <div style={{ flex: '1 1 160px' }}>
                    <SelectField label="Role here" value={grantRole} onChange={(e) => setGrantRole(e.target.value as ScopedRole)}>
                      {FOLDER_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  <Button type="submit" disabled={!grantUser} busy={addGrant.isPending}>
                    <UserPlus size={16} /> Give access
                  </Button>
                </form>
              </Card>
            )}
          </div>
        ) : (
          <Card>
            <p className="st-empty" style={{ padding: 24 }}>
              Choose a folder to see who has access to it.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
