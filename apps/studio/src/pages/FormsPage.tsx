import { useAuth } from '../lib/auth';
import { copyEmbedCode, copyPublicFormLink, publicFormUrl } from '../form/links';
import { MakeRecordLink } from '../form/builder/components/OpenWithSetting';
import { fieldsFromCsv, fieldsFromEntity, fieldsFromJsonSchema, fieldsFromPdfFields, type ImportedFields, type SourceField } from '@fb/engine';
import { FormVersions } from '../components/FormVersions';
import { QrCodeDialog } from '../components/QrCode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Code2, Download, ExternalLink, FileKey2, FilePlus2, FolderInput, GitBranchPlus, History, Inbox, Link2, QrCode, Rocket, Trash2, Upload, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAction, useFolders, useForms } from '../lib/queries';
import type { Folder, FormStatus, FormSummary } from '../lib/types';
import { codeFromName, FORM_TEMPLATES, INDUSTRIES, linkTemplateFragments, linkTemplateWorkflow, prepareTemplate } from '../templates';
import { Alert, Badge, Button, Card, PageHead, SelectField, TextField, useSubmit } from '../components/ui';

const STATUS: Record<FormStatus, { label: string; tone?: 'success' | 'warn' | 'accent' }> = {
  DRAFT: { label: 'Draft', tone: 'warn' },
  PUBLISHED: { label: 'Published', tone: 'success' },
  ARCHIVED: { label: 'Archived' },
};

/** Forms shown at a time on the list. */
export const PAGE_SIZE = 20;

/** "Quality / Audits" for a folder id. */
function folderLabel(folders: Folder[], id: string) {
  const f = folders.find((x) => x.id === id);
  return f ? f.path.map((p) => folders.find((x) => x.id === p)?.name ?? '…').join(' / ') : 'Unknown folder';
}

/** Ways to start a form from a file instead of a template. */
const IMPORT_SOURCES = [
  { key: 'schema', label: 'A JSON Schema', description: 'One field for each property of a schema file.', fileLabel: 'Schema file (.json)', accept: 'application/json,.json' },
  { key: 'csv', label: 'A spreadsheet', description: 'One field for each column of a CSV file; example rows set the types.', fileLabel: 'Spreadsheet file (.csv)', accept: 'text/csv,.csv' },
  { key: 'pdf', label: 'A fillable PDF', description: 'One field for each fillable field of a PDF form. The file stays on your computer.', fileLabel: 'PDF form (.pdf)', accept: 'application/pdf,.pdf' },
] as const;

function NewFormCard({ folders, onDone, onCancel }: { folders: Folder[]; onDone: (msg: string) => void; onCancel: () => void }) {
  const [template, setTemplate] = useState('blank');
  const [industry, setIndustryState] = useState('');
  /** Changing the industry selects the first form offered for it, so what is chosen is always on screen. */
  const setIndustry = (value: string) => {
    setIndustryState(value);
    setTemplate(FORM_TEMPLATES.find((t) => (t.industry ?? '') === value)?.key ?? 'blank');
  };
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [folderId, setFolderId] = useState(folders[0]?.id ?? '');
  const shownCode = codeTouched ? code : codeFromName(name);
  /** Fields read from a schema or a spreadsheet, when the form starts from one. */
  const [imported, setImported] = useState<{ file: string; result: ImportedFields; error?: string; table?: string }>();
  const source = IMPORT_SOURCES.find((x) => x.key === template);
  /** Tables the signed-in person may use from the organisation's connectors, asked for when that way of starting is chosen. */
  const [tables, setTables] = useState<{ key: string; name: string; fields: (string | TableField)[] }[]>();
  const fromTable = template === 'connector';
  useEffect(() => {
    if (!fromTable || tables) return;
    api<{ id: string; name: string; permissions: { use: boolean }; entities: { key: string; label: string; fields: string[]; about?: TableField[] }[] }[]>('/connectors')
      .then((list) => setTables(list.filter((c) => c.permissions.use).flatMap((c) => c.entities.map((e) => ({ key: `${c.id}/${e.key}`, name: `${c.name} · ${e.label}`, fields: e.fields.map((f) => e.about?.find((a) => a.name === f) ?? f) })))))
      .catch(() => setTables([]));
  }, [fromTable, tables]);
  const pickTable = (key: string) => {
    const table = tables?.find((t) => t.key === key);
    if (!table) return setImported(undefined);
    setImported({ file: table.name, table: table.key, result: fieldsFromEntity({ fields: table.fields }) });
    if (!name) setName(table.name.split(' · ').pop() ?? '');
  };
  const readFile = async (file: File | undefined) => {
    if (!file || !source) return;
    const limitMb = source.key === 'pdf' ? 10 : 1;
    if (file.size > limitMb * 1024 * 1024) return setImported({ file: file.name, result: { fields: [], notes: [] }, error: `The file is larger than ${limitMb} MB.` });
    if (source.key === 'pdf') {
      try {
        const { readPdfFields } = await import('../lib/pdf-fields');
        setImported({ file: file.name, result: fieldsFromPdfFields(await readPdfFields(await file.arrayBuffer())) });
        if (!name) setName(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim());
      } catch {
        setImported({ file: file.name, result: { fields: [], notes: [] }, error: 'This file could not be read as a PDF form. If it is protected with a password, remove the protection first.' });
      }
      return;
    }
    const text = await file.text();
    try {
      const result = source.key === 'schema' ? fieldsFromJsonSchema(JSON.parse(text)) : fieldsFromCsv(text);
      setImported({ file: file.name, result });
      // The file's name is a fair first guess at the form's.
      if (!name) setName(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim());
    } catch {
      setImported({ file: file.name, result: { fields: [], notes: [] }, error: 'This file could not be read as JSON.' });
    }
  };
  const create = useSubmit(async () => {
    if (source || fromTable) {
      const fields = imported?.result.fields ?? [];
      await api('/forms', { method: 'POST', body: { folderId, definition: { ...FORM_TEMPLATES[0].definition, fields, name: name.trim(), code: shownCode, ...(fromTable && imported?.table ? { startedFrom: { table: imported.table, name: imported.file } } : {}) } } });
      return onDone(`"${name.trim()}" was created as a draft with ${fields.length} field${fields.length === 1 ? '' : 's'} from ${imported?.file}. Check them in the builder before publishing.`);
    }
    const tpl = FORM_TEMPLATES.find((t) => t.key === template)!;
    // A template's own styles go into the library first, so the form can be published as it comes.
    const { definition, leftOut } = await prepareTemplate(tpl.definition, {
      existing: async () => (await api<{ id: string }[]>('/styles')).map((s) => s.id),
      add: (style) => api(`/styles/${style.id}`, { method: 'PUT', body: style }),
    });
    // Sections that are copies of library fragments (Address, Bank account) are linked to the library's own.
    const withFragments = await linkTemplateFragments(definition, {
      existing: () => api<{ id: string; name: string }[]>('/fragments'),
      add: (fragment) => api<{ id: string }>('/fragments', { method: 'POST', body: fragment }),
    });
    // A form that runs on a library workflow (Service request) is linked to the library's own.
    const ready = await linkTemplateWorkflow(withFragments.definition, {
      existing: () => api<{ id: string; name: string }[]>('/workflows'),
      add: (workflow) => api<{ id: string }>('/workflows', { method: 'POST', body: workflow }),
    });
    await api('/forms', { method: 'POST', body: { folderId, definition: { ...ready.definition, name: name.trim(), code: shownCode } } });
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
        <div className="st-field" style={{ maxWidth: 360 }}>
          <label htmlFor="new-form-industry">Show starting points for</label>
          <select id="new-form-industry" className="st-select" value={industry} onChange={(e) => setIndustry(e.target.value)}>
            <option value="">Any kind of form</option>
            {INDUSTRIES.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
          {industry && <span className="st-field__hint">Long, ready-made forms in steps, with their calculations and workflow. Everything in them can be changed.</span>}
        </div>
        <div className="st-row" role="radiogroup" aria-label="Start from" style={{ alignItems: 'stretch' }}>
          {FORM_TEMPLATES.filter((t) => (t.industry ?? '') === industry).map((t) => (
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
          {!industry && IMPORT_SOURCES.map((x) => (
            <label key={x.key} className="st-card" style={{ flex: '1 1 200px', padding: 14, cursor: 'pointer', borderColor: template === x.key ? 'var(--fb-accent)' : undefined, boxShadow: template === x.key ? 'var(--fb-ring)' : undefined, position: 'relative' }}>
              <input
                type="radio"
                name="template"
                value={x.key}
                checked={template === x.key}
                onChange={() => {
                  setTemplate(x.key);
                  setImported(undefined);
                }}
                style={{ position: 'absolute', opacity: 0 }}
              />
              <strong>{x.label}</strong>
              <div className="st-muted" style={{ fontSize: 12 }}>
                {x.description}
              </div>
            </label>
          ))}
          <label className="st-card" style={{ flex: '1 1 200px', padding: 14, cursor: 'pointer', borderColor: fromTable ? 'var(--fb-accent)' : undefined, boxShadow: fromTable ? 'var(--fb-ring)' : undefined, position: 'relative' }}>
            <input
              type="radio"
              name="template"
              value="connector"
              checked={fromTable}
              onChange={() => {
                setTemplate('connector');
                setImported(undefined);
              }}
              style={{ position: 'absolute', opacity: 0 }}
            />
            <strong>A table from a connector</strong>
            <div className="st-muted" style={{ fontSize: 12 }}>
              One field for each field of a table your organisation has connected, named the same so answers can be saved back.
            </div>
          </label>
        </div>
        {(source || fromTable) && (
          <div className="st-stack" style={{ gap: 8 }}>
            {source && (
              <label className="st-stack" style={{ gap: 4 }}>
                <strong>{source.fileLabel}</strong>
                <input key={source.key} type="file" accept={source.accept} aria-label={source.fileLabel} onChange={(e) => void readFile(e.target.files?.[0])} />
              </label>
            )}
            {fromTable && (
              <label className="st-stack" style={{ gap: 4 }}>
                <strong>Table</strong>
                <select className="st-select" aria-label="Table" defaultValue="" disabled={!tables?.length} onChange={(e) => pickTable(e.target.value)}>
                  <option value="">{!tables ? 'Loading…' : tables.length ? 'Choose a table' : 'No connector tables you can use yet'}</option>
                  {(tables ?? []).map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {imported?.error && <Alert tone="error">{imported.error}</Alert>}
            {imported && !imported.error && (
              <div role="status" className="st-stack" style={{ gap: 4 }}>
                <span>
                  <strong>{imported.result.fields.length}</strong> field{imported.result.fields.length === 1 ? '' : 's'} found in {imported.file}
                  {imported.result.fields.length > 0 && <span className="st-muted">: {imported.result.fields.slice(0, 8).map((f) => f.label || f.name).join(', ')}{imported.result.fields.length > 8 ? '…' : ''}</span>}
                </span>
                {imported.result.notes.length > 0 && (
                  <ul className="st-muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                    {imported.result.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
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
          <Button type="submit" busy={create.busy} disabled={!name.trim() || !shownCode || !folderId || ((!!source || fromTable) && !imported?.result.fields.length)}>
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

/** What a connector kept about a table's field: its kind and the limits the table itself sets. */
type TableField = SourceField;

export default function FormsPage() {
  const { me } = useAuth();
  const forms = useForms();
  const folders = useFolders();
  const [folderFilter, setFolderFilter] = useState('');
  const [creating, setCreating] = useState(false);
  // By form code, not version id: restoring or publishing gives the form a new latest version, and the panel should stay open.
  const [openVersions, setOpenVersions] = useState<string>();
  const [qrFor, setQrFor] = useState<{ url: string; title: string; note?: string }>();
  const [linkFor, setLinkFor] = useState<string>();
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
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const matching = useMemo(() => {
    const words = search.trim().toLowerCase();
    return (forms.data ?? []).filter((f) => (!folderFilter || all.find((x) => x.id === f.folderId)?.path.includes(folderFilter)) && (!words || f.name.toLowerCase().includes(words) || f.code.toLowerCase().includes(words.replace(/\s+/g, '_'))));
  }, [forms.data, folderFilter, all, search]);
  // A page at a time: a long list is slow to read and to draw.
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const shown = Math.min(page, pages);
  const visible = useMemo(() => matching.slice((shown - 1) * PAGE_SIZE, shown * PAGE_SIZE), [matching, shown]);
  // Whether the caller can create in a given folder is the server's call (it says so clearly if not).
  const canCreate = all.length > 0;

  return (
    <>
      <PageHead
        title="Forms"
        subtitle="Every form in the folders you can see. Drafts are private to editors until published."
        actions={
          <div className="st-row">
            <input
              className="st-input"
              style={{ width: 220 }}
              type="search"
              aria-label="Find a form"
              placeholder="Find a form"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
            <select
              className="st-select"
              style={{ width: 200 }}
              aria-label="Folder"
              value={folderFilter}
              onChange={(e) => {
                setFolderFilter(e.target.value);
                setPage(1);
              }}
            >
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
                    <th className="st-col-wide">Folder</th>
                    <th>Status</th>
                    <th className="st-col-wide">Updated</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((f) => {
                    const edit = f.permissions.includes('form.edit');
                    const publish = f.permissions.includes('form.publish');
                    return (
                      <tr key={f.code}>
                        <td>
                          <Link className="st-link" to={`/forms/${f.id}/edit`}>
                            {f.name}
                          </Link>
                          <div className="st-mono st-muted">{f.code}</div>
                          {openVersions === f.code && (
                            <div style={{ marginTop: 8 }}>
                              <FormVersions form={f} canEdit={edit} />
                            </div>
                          )}
                          {linkFor === f.code && f.recordLink !== undefined && (
                            <div style={{ marginTop: 8, maxWidth: 520 }}>
                              <MakeRecordLink form={{ id: f.id, orgId: me?.org.id ?? '', code: f.code }} what={f.recordLink} />
                            </div>
                          )}
                        </td>
                        <td className="st-muted st-col-wide">{folderLabel(all, f.folderId)}</td>
                        <td>
                          <div className="st-row" style={{ gap: 6 }}>
                            <Badge tone={STATUS[f.status].tone}>
                              {STATUS[f.status].label} v{f.version}
                            </Badge>
                            {f.status === 'DRAFT' && f.publishedVersion && <Badge tone="success">Live v{f.publishedVersion}</Badge>}
                            {f.status === 'DRAFT' && f.publishAt && <Badge tone="accent">Publishes {new Date(f.publishAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Badge>}
                            {(f.status === 'PUBLISHED' || f.publishedVersion != null) && !f.publicLink && <Badge>Sign-in only</Badge>}
                            {f.status === 'DRAFT' && f.scheduleError && <Badge tone="danger">Scheduled publish failed</Badge>}
                            {f.status === 'DRAFT' && f.review === 'REQUESTED' && <Badge tone="warn">Waiting for review</Badge>}
                            {f.status === 'DRAFT' && f.review === 'CHANGES_REQUESTED' && <Badge tone="danger">Changes asked</Badge>}
                            {f.status === 'DRAFT' && f.review === 'APPROVED' && <Badge tone="success">Approved</Badge>}
                          </div>
                        </td>
                        <td className="st-muted st-col-wide" style={{ whiteSpace: 'nowrap' }}>
                          {new Date(f.updatedAt).toLocaleDateString()}
                        </td>
                        <td>
                          <div className="st-actions">
                            {(f.status === 'PUBLISHED' || f.publishedVersion != null) && (
                              <>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  aria-label={`Copy the link to ${f.name}`}
                                  title={f.publicLink ? "Copy the form's address, to send to people or put on a page" : "Copy the form's address. Only people signed in to your organisation can open it"}
                                  onClick={() => void copyPublicFormLink(me?.org.id ?? '', f.code, !f.publicLink)}
                                >
                                  <Link2 size={14} /> Copy link
                                </Button>
                                <Button variant="ghost" size="sm" aria-label={`QR code for ${f.name}`} title="A QR code that opens the form: for a poster, a door or a machine" onClick={() => setQrFor({ url: publicFormUrl(me?.org.id ?? '', f.code), title: f.name, note: f.publicLink ? undefined : 'Only people signed in to your organisation can open this form.' })}>
                                  <QrCode size={14} />
                                </Button>
                                <a className="st-btn st-btn--ghost st-btn--sm" href={publicFormUrl(me?.org.id ?? '', f.code)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${f.name} as people see it`} title="Open the form as people see it">
                                  <ExternalLink size={14} />
                                </a>
                                {f.recordLink !== undefined && (
                                  <Button variant="ghost" size="sm" aria-label={`Link for a record, for ${f.name}`} aria-expanded={linkFor === f.code} title="Make a link that opens this form filled from one record" onClick={() => setLinkFor(linkFor === f.code ? undefined : f.code)}>
                                    <FileKey2 size={14} /> Link for a record
                                  </Button>
                                )}
                                {/* Putting it on a website is for forms anyone may fill in. */}
                                {f.publicLink && (
                                  <Button variant="ghost" size="sm" aria-label={`Copy the embed code for ${f.name}`} title="Copy a line of HTML that puts this form on your own website" onClick={() => void copyEmbedCode(me?.org.id ?? '', f.code)}>
                                    <Code2 size={14} />
                                  </Button>
                                )}
                              </>
                            )}
                            {(edit || publish) && (
                              <Link className="st-btn st-btn--ghost st-btn--sm" to={`/forms/${f.id}/submissions`} aria-label={`Submissions of ${f.name}`} title="Submissions">
                                <Inbox size={14} />
                              </Link>
                            )}
                            <Button variant="ghost" size="sm" aria-label={`Export ${f.name}`} title="Export (copy to another environment)" onClick={() => downloadPackage(f).catch((e: Error) => setMessage({ tone: 'error', text: errorMessage(e) }))}>
                              <Download size={14} />
                            </Button>
                            <Button variant="ghost" size="sm" aria-label={`Versions of ${f.name}`} onClick={() => setOpenVersions(openVersions === f.code ? undefined : f.code)}>
                              <History size={14} />
                            </Button>
                            {f.status === 'DRAFT' && publish && (
                              <Button size="sm" busy={act.isPending && act.variables?.id === f.id} onClick={() => act.mutate({ id: f.id, path: 'publish' }, feedback(`${f.name} v${f.version} is live.`))}>
                                <Rocket size={14} /> Publish
                              </Button>
                            )}
                            {f.status !== 'DRAFT' && edit && (
                              <Button variant="ghost" size="sm" aria-label={`New version of ${f.name}`} title="Start a new version: a draft you can change while this one stays live" onClick={() => act.mutate({ id: f.id, path: 'new-version' }, feedback(`A new draft of ${f.name} is open.`))}>
                                <GitBranchPlus size={14} />
                              </Button>
                            )}
                            {f.status === 'PUBLISHED' && publish && (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Take it offline"
                                aria-label={`Archive ${f.name}`}
                                onClick={() => window.confirm(`Take ${f.name} offline? People can no longer fill it in.`) && act.mutate({ id: f.id, path: 'archive' }, feedback(`${f.name} was archived.`))}
                              >
                                <Archive size={14} />
                              </Button>
                            )}
                            {edit && all.length > 1 && (
                              <select
                                className="st-select st-actions__move"
                                title="Move to another folder"
                                aria-label={`Move ${f.name} to folder`}
                                value=""
                                onChange={(e) => e.target.value && move.mutate({ id: f.id, folderId: e.target.value }, feedback(`${f.name} moved to ${folderLabel(all, e.target.value)}.`))}
                              >
                                <option value="">Move…</option>
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
            <p className="st-empty">{forms.isLoading ? 'Loading…' : search.trim() ? `No form matches "${search.trim()}".` : folderFilter ? 'No forms in this folder.' : 'No forms yet.'}</p>
          )}
        </Card>
        {matching.length > PAGE_SIZE && (
          <nav className="st-pager" aria-label="Pages of forms">
            <span className="st-muted">
              Showing {(shown - 1) * PAGE_SIZE + 1} to {Math.min(shown * PAGE_SIZE, matching.length)} of {matching.length}
            </span>
            <Button variant="secondary" size="sm" disabled={shown <= 1} onClick={() => setPage(shown - 1)}>
              Previous
            </Button>
            <span aria-current="page">
              Page {shown} of {pages}
            </span>
            <Button variant="secondary" size="sm" disabled={shown >= pages} onClick={() => setPage(shown + 1)}>
              Next
            </Button>
          </nav>
        )}
        <p className="st-muted" style={{ margin: 0, fontSize: 12 }}>
          <FolderInput size={12} style={{ verticalAlign: -2 }} /> Click a form to open it in the builder.
        </p>
      </div>
      {qrFor && <QrCodeDialog open url={qrFor.url} title={qrFor.title} note={qrFor.note} onClose={() => setQrFor(undefined)} />}
    </>
  );
}
