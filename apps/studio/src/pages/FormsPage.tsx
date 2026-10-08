import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Download, FilePlus2, FolderInput, GitBranchPlus, History, Inbox, Rocket, Trash2, Upload, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAction, useFolders, useForms, useFormVersions } from '../lib/queries';
import type { Folder, FormStatus, FormSummary } from '../lib/types';
import { codeFromName, FORM_TEMPLATES, prepareTemplate } from '../templates';
import { Alert, Badge, Button, Card, PageHead, SelectField, TextField, useSubmit } from '../components/ui';

const STATUS: Record<FormStatus, { label: string; tone?: 'success' | 'warn' | 'accent' }> = {
  DRAFT: { label: 'Draft', tone: 'warn' },
  PUBLISHED: { label: 'Published', tone: 'success' },
  ARCHIVED: { label: 'Archived' },
};

/** "Quality / Audits" for a folder id. */
function folderLabel(folders: Folder[], id: string) {
  const f = folders.find((x) => x.id === id);
  return f ? f.path.map((p) => folders.find((x) => x.id === p)?.name ?? '…').join(' / ') : 'Unknown folder';
}

function NewFormCard({ folders, onDone, onCancel }: { folders: Folder[]; onDone: (msg: string) => void; onCancel: () => void }) {
  const [template, setTemplate] = useState('blank');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [folderId, setFolderId] = useState(folders[0]?.id ?? '');
  const shownCode = codeTouched ? code : codeFromName(name);
  const create = useSubmit(async () => {
    const tpl = FORM_TEMPLATES.find((t) => t.key === template)!;
    // A template's own styles go into the library first, so the form can be published as it comes.
    const { definition, leftOut } = await prepareTemplate(tpl.definition, {
      existing: async () => (await api<{ id: string }[]>('/styles')).map((s) => s.id),
      add: (style) => api(`/styles/${style.id}`, { method: 'PUT', body: style }),
    });
    await api('/forms', { method: 'POST', body: { folderId, definition: { ...definition, name: name.trim(), code: shownCode } } });
    onDone(
      `"${name.trim()}" was created as a draft.${tpl.setup?.length ? ` Before publishing: ${tpl.setup.join(' ')}` : ''}${
        leftOut.length ? ` It was created without the style ${leftOut.map((n) => `"${n}"`).join(', ')}: only an admin can add styles to the library.` : ''
      }`,
    );
  });

  return (
    <Card title="New form" subtitle="It starts as a draft; publish it when it's ready." actions={<Button variant="ghost" size="sm" onClick={onCancel} aria-label="Close"><X size={16} /></Button>}>
      <form className="st-stack" onSubmit={create.submit} noValidate>
        {create.error && !Object.keys(create.fields).length && <Alert tone="error">{create.error}</Alert>}
        <div className="st-row" role="radiogroup" aria-label="Start from" style={{ alignItems: 'stretch' }}>
          {FORM_TEMPLATES.map((t) => (
            <label key={t.key} className="st-card" style={{ flex: '1 1 200px', padding: 14, cursor: 'pointer', borderColor: template === t.key ? 'var(--fb-accent)' : undefined, boxShadow: template === t.key ? 'var(--fb-ring)' : undefined }}>
              <input
                type="radio"
                name="template"
                value={t.key}
                checked={template === t.key}
                onChange={() => {
                  setTemplate(t.key);
                  if (!name && t.key !== 'blank') setName(String(t.definition.name ?? ''));
                }}
                style={{ position: 'absolute', opacity: 0 }}
              />
              <strong>{t.label}</strong>
              <div className="st-muted" style={{ fontSize: 12 }}>
                {t.description}
              </div>
            </label>
          ))}
        </div>
        <div className="st-grid-2">
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} error={create.fields.name} placeholder="e.g. Leave request" />
          <TextField
            label="Code"
            value={shownCode}
            onChange={(e) => (setCodeTouched(true), setCode(e.target.value.toUpperCase()))}
            error={create.fields.code}
            hint="Unique in the organisation; used in links and references."
          />
        </div>
        <SelectField label="Folder" value={folderId} onChange={(e) => setFolderId(e.target.value)} hint="You need edit rights in the folder.">
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {folderLabel(folders, f.id)}
            </option>
          ))}
        </SelectField>
        <div className="st-row">
          <Button type="submit" busy={create.busy} disabled={!name.trim() || !shownCode || !folderId}>
            <FilePlus2 size={16} /> Create draft
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Versions({ form }: { form: FormSummary }) {
  const { data } = useFormVersions(form.id);
  return (
    <div className="st-row" style={{ gap: 6 }}>
      {(data ?? []).map((v) => (
        <Badge key={v.id} tone={STATUS[v.status].tone}>
          v{v.version} · {STATUS[v.status].label}
        </Badge>
      ))}
    </div>
  );
}

/** Save a form package as a .json file. */
async function downloadPackage(f: FormSummary) {
  const pkg = await api<object>(`/forms/${f.id}/export`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${f.code}-v${f.version}.form.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ImportResult {
  code: string;
  version: number;
  stylesCreated: string[];
  stylesMissing: string[];
  connectorsMissing: string[];
}

function importSummary(r: ImportResult) {
  const notes = [
    r.stylesCreated.length && `styles added: ${r.stylesCreated.join(', ')}`,
    r.stylesMissing.length && `styles to create before publishing: ${r.stylesMissing.join(', ')}`,
    r.connectorsMissing.length && `connectors it uses that don't exist here: ${r.connectorsMissing.join(', ')} (re-bind them in the builder)`,
  ].filter(Boolean);
  return `Imported ${r.code} as draft v${r.version}. Review and publish it when ready.${notes.length ? ` Note - ${notes.join('; ')}.` : ''}`;
}

export default function FormsPage() {
  const forms = useForms();
  const folders = useFolders();
  const [folderFilter, setFolderFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [openVersions, setOpenVersions] = useState<string>();
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string }>();
  const feedback = (text: string) => ({ onSuccess: () => setMessage({ tone: 'success', text }), onError: (e: Error) => setMessage({ tone: 'error', text: errorMessage(e) }) });
  const act = useAction((a: { id: string; path: string }) => api(`/forms/${a.id}/${a.path}`, { method: 'POST' }), [['forms'], ['form-versions']]);
  const del = useAction((id: string) => api(`/forms/${id}`, { method: 'DELETE' }), [['forms']]);
  const fileInput = useRef<HTMLInputElement>(null);
  const importPkg = useAction(async (file: File) => {
    let pkg: unknown;
    try {
      pkg = JSON.parse(await file.text());
    } catch {
      throw new Error("That file isn't a form package (not JSON).");
    }
    return api<ImportResult>('/forms/import', { method: 'POST', body: { folderId: folderFilter || all[0]!.id, package: pkg } });
  }, [['forms'], ['styles']]);
  const move = useAction((a: { id: string; folderId: string }) => api(`/forms/${a.id}/folder`, { method: 'PATCH', body: { folderId: a.folderId } }), [['forms']]);

  const all = folders.data ?? [];
  // Folders shown in the filter include sub-folders of the chosen one.
  const visible = useMemo(
    () => (forms.data ?? []).filter((f) => !folderFilter || all.find((x) => x.id === f.folderId)?.path.includes(folderFilter)),
    [forms.data, folderFilter, all],
  );
  // Whether the caller can create in a given folder is the server's call (it says so clearly if not).
  const canCreate = all.length > 0;

  return (
    <>
      <PageHead
        title="Forms"
        subtitle="Every form in the folders you can see. Drafts are private to editors until published."
        actions={
          <div className="st-row">
            <select className="st-select" style={{ width: 220 }} aria-label="Folder" value={folderFilter} onChange={(e) => setFolderFilter(e.target.value)}>
              <option value="">All folders</option>
              {all.map((f) => (
                <option key={f.id} value={f.id}>
                  {folderLabel(all, f.id)}
                </option>
              ))}
            </select>
            {canCreate && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/json,.json"
                  hidden
                  aria-label="Form package file"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) importPkg.mutate(file, { onSuccess: (r) => setMessage({ tone: 'success', text: importSummary(r) }), onError: (err: Error) => setMessage({ tone: 'error', text: errorMessage(err) }) });
                  }}
                />
                <Button variant="secondary" busy={importPkg.isPending} onClick={() => fileInput.current?.click()} title={`Import into ${folderFilter ? folderLabel(all, folderFilter) : folderLabel(all, all[0]!.id)}`}>
                  <Upload size={16} /> Import
                </Button>
              </>
            )}
            {canCreate && !creating && (
              <Button onClick={() => setCreating(true)}>
                <FilePlus2 size={16} /> New form
              </Button>
            )}
          </div>
        }
      />
      <div className="st-stack">
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {!all.length && !folders.isLoading && <Alert tone="info">Forms live in folders. Create a folder in Folders & access first.</Alert>}
        {creating && all.length > 0 && (
          <NewFormCard
            folders={all}
            onCancel={() => setCreating(false)}
            onDone={(text) => {
              setCreating(false);
              setMessage({ tone: 'success', text });
              void forms.refetch();
            }}
          />
        )}
        <Card bodyless>
          {visible.length ? (
            <div className="st-table-wrap">
              <table className="st-table">
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Folder</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((f) => {
                    const edit = f.permissions.includes('form.edit');
                    const publish = f.permissions.includes('form.publish');
                    return (
                      <tr key={f.id}>
                        <td>
                          <Link className="st-link" to={`/forms/${f.id}/edit`}>
                            {f.name}
                          </Link>
                          <div className="st-mono st-muted">{f.code}</div>
                          {openVersions === f.id && (
                            <div style={{ marginTop: 8 }}>
                              <Versions form={f} />
                            </div>
                          )}
                        </td>
                        <td className="st-muted">{folderLabel(all, f.folderId)}</td>
                        <td>
                          <div className="st-row" style={{ gap: 6 }}>
                            <Badge tone={STATUS[f.status].tone}>
                              {STATUS[f.status].label} v{f.version}
                            </Badge>
                            {f.status === 'DRAFT' && f.publishedVersion && <Badge tone="success">Live v{f.publishedVersion}</Badge>}
                            {f.status === 'DRAFT' && f.publishAt && <Badge tone="accent">Publishes {new Date(f.publishAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Badge>}
                            {f.status === 'DRAFT' && f.scheduleError && <Badge tone="danger">Scheduled publish failed</Badge>}
                          </div>
                        </td>
                        <td className="st-muted" style={{ whiteSpace: 'nowrap' }}>
                          {new Date(f.updatedAt).toLocaleDateString()}
                        </td>
                        <td>
                          <div className="st-row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                            {(edit || publish) && (
                              <Link className="st-btn st-btn--ghost st-btn--sm" to={`/forms/${f.id}/submissions`} aria-label={`Submissions of ${f.name}`} title="Submissions">
                                <Inbox size={14} />
                              </Link>
                            )}
                            <Button variant="ghost" size="sm" aria-label={`Export ${f.name}`} title="Export (copy to another environment)" onClick={() => downloadPackage(f).catch((e: Error) => setMessage({ tone: 'error', text: errorMessage(e) }))}>
                              <Download size={14} />
                            </Button>
                            <Button variant="ghost" size="sm" aria-label={`Versions of ${f.name}`} onClick={() => setOpenVersions(openVersions === f.id ? undefined : f.id)}>
                              <History size={14} />
                            </Button>
                            {f.status === 'DRAFT' && publish && (
                              <Button size="sm" busy={act.isPending && act.variables?.id === f.id} onClick={() => act.mutate({ id: f.id, path: 'publish' }, feedback(`${f.name} v${f.version} is live.`))}>
                                <Rocket size={14} /> Publish
                              </Button>
                            )}
                            {f.status !== 'DRAFT' && edit && (
                              <Button variant="secondary" size="sm" onClick={() => act.mutate({ id: f.id, path: 'new-version' }, feedback(`A new draft of ${f.name} is open.`))}>
                                <GitBranchPlus size={14} /> New version
                              </Button>
                            )}
                            {f.status === 'PUBLISHED' && publish && (
                              <Button
                                variant="secondary"
                                size="sm"
                                aria-label={`Archive ${f.name}`}
                                onClick={() => window.confirm(`Take ${f.name} offline? People can no longer fill it in.`) && act.mutate({ id: f.id, path: 'archive' }, feedback(`${f.name} was archived.`))}
                              >
                                <Archive size={14} />
                              </Button>
                            )}
                            {edit && all.length > 1 && (
                              <select
                                className="st-select"
                                style={{ height: 30, width: 120, fontSize: 13 }}
                                aria-label={`Move ${f.name} to folder`}
                                value=""
                                onChange={(e) => e.target.value && move.mutate({ id: f.id, folderId: e.target.value }, feedback(`${f.name} moved to ${folderLabel(all, e.target.value)}.`))}
                              >
                                <option value="">Move to…</option>
                                {all
                                  .filter((x) => x.id !== f.folderId)
                                  .map((x) => (
                                    <option key={x.id} value={x.id}>
                                      {folderLabel(all, x.id)}
                                    </option>
                                  ))}
                              </select>
                            )}
                            {f.status === 'DRAFT' && edit && (
                              <Button
                                variant="danger"
                                size="sm"
                                aria-label={`Delete draft ${f.name}`}
                                onClick={() => window.confirm(`Delete the draft of ${f.name}?`) && del.mutate(f.id, feedback(`Draft of ${f.name} deleted.`))}
                              >
                                <Trash2 size={14} />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="st-empty">{forms.isLoading ? 'Loading…' : folderFilter ? 'No forms in this folder.' : 'No forms yet.'}</p>
          )}
        </Card>
        <p className="st-muted" style={{ margin: 0, fontSize: 12 }}>
          <FolderInput size={12} style={{ verticalAlign: -2 }} /> Click a form to open it in the builder.
        </p>
      </div>
    </>
  );
}
