import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GitCompare, History } from 'lucide-react';
import { diffForms, type FormChange, type FormDefinition } from '@fb/engine';
import { api, ApiError } from '../lib/api';
import { useFormVersions } from '../lib/queries';
import type { FormStatus, FormSummary, FormVersionRow } from '../lib/types';
import { Alert, Badge, Button } from './ui';

const STATUS: Record<FormStatus, { label: string; tone?: 'accent' | 'success' | 'warn' | 'danger' }> = {
  DRAFT: { label: 'Draft', tone: 'warn' },
  PUBLISHED: { label: 'Published', tone: 'success' },
  ARCHIVED: { label: 'Archived' },
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const definitionOf = async (id: string) => (await api<{ definition: FormDefinition }>(`/forms/${id}`)).definition;

const KIND: Record<FormChange['kind'], string> = { added: 'Added', removed: 'Removed', changed: 'Changed' };

/** What changed going from one version to another, in words. */
function Changes({ from, to, changes }: { from: FormVersionRow; to: FormVersionRow; changes: FormChange[] }) {
  return (
    <div role="region" aria-label={`Changes from v${from.version} to v${to.version}`} className="st-stack" style={{ gap: 6, marginTop: 8 }}>
      <strong>
        From v{from.version} to v{to.version}
      </strong>
      {!changes.length && <span className="st-muted">Nothing was changed.</span>}
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {changes.map((c, i) => (
          <li key={i}>
            {KIND[c.kind]} {c.area === 'Form' ? '' : `${c.area.toLowerCase()} `}
            <strong>{c.what}</strong>
            {c.details.length > 0 && <span className="st-muted">: {c.details.join('; ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Every version of a form: when each was published, what changed between a
 * version and the newest one, and a way to bring an earlier version back as
 * the draft.
 */
export function FormVersions({ form, canEdit }: { form: FormSummary; canEdit: boolean }) {
  const { data } = useFormVersions(form.id);
  const qc = useQueryClient();
  const versions = data ?? [];
  const newest = versions[0];
  const [compared, setCompared] = useState<{ from: FormVersionRow; changes: FormChange[] } | null>(null);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string }>();
  /** A restore that needs a second "yes": it would replace the open draft. */
  const [toReplace, setToReplace] = useState<{ version: FormVersionRow; text: string }>();

  const compare = async (from: FormVersionRow) => {
    if (compared?.from.id === from.id) return setCompared(null);
    setBusy(from.id);
    try {
      const [a, b] = await Promise.all([definitionOf(from.id), definitionOf(newest.id)]);
      setCompared({ from, changes: diffForms(a, b) });
    } catch (e) {
      setMessage({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const restore = async (version: FormVersionRow, replaceDraft: boolean) => {
    setBusy(version.id);
    setMessage(undefined);
    try {
      const made = await api<{ definition: { version: number } }>(`/forms/${version.id}/restore`, { method: 'POST', body: { replaceDraft } });
      setToReplace(undefined);
      setCompared(null);
      setMessage({ tone: 'success', text: `v${version.version} is back as draft v${made.definition.version}. Review and publish it when ready.` });
      await Promise.all([qc.invalidateQueries({ queryKey: ['forms'] }), qc.invalidateQueries({ queryKey: ['form-versions'] })]);
    } catch (e) {
      // An open draft would be overwritten: ask before doing that.
      if (e instanceof ApiError && e.status === 409 && !replaceDraft) setToReplace({ version, text: e.message });
      else setMessage({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="st-stack" style={{ gap: 8 }} role="group" aria-label={`Versions of ${form.name}`}>
      {message && <Alert tone={message.tone}>{message.text}</Alert>}
      {toReplace && (
        <Alert tone="warn">
          {toReplace.text}{' '}
          <Button size="sm" variant="danger" busy={busy === toReplace.version.id} onClick={() => void restore(toReplace.version, true)}>
            Replace the draft
          </Button>{' '}
          <Button size="sm" variant="ghost" onClick={() => setToReplace(undefined)}>
            Keep the draft
          </Button>
        </Alert>
      )}
      {versions.map((v) => (
        <div key={v.id} className="st-row" style={{ gap: 8, alignItems: 'center' }}>
          <Badge tone={STATUS[v.status].tone}>
            v{v.version} · {STATUS[v.status].label}
          </Badge>
          <span className="st-muted" style={{ fontSize: 12 }}>
            {v.publishedAt ? `published ${when(v.publishedAt)}` : `edited ${when(v.updatedAt)}`}
          </span>
          {newest && v.id !== newest.id && (
            <Button size="sm" variant="ghost" busy={busy === v.id} aria-label={`What changed since v${v.version}`} aria-pressed={compared?.from.id === v.id} onClick={() => void compare(v)}>
              <GitCompare size={14} /> What changed since
            </Button>
          )}
          {canEdit && v.status !== 'DRAFT' && newest && v.id !== newest.id && (
            <Button size="sm" variant="ghost" busy={busy === v.id} aria-label={`Restore v${v.version}`} onClick={() => void restore(v, false)}>
              <History size={14} /> Restore
            </Button>
          )}
        </div>
      ))}
      {compared && newest && <Changes from={compared.from} to={newest} changes={compared.changes} />}
    </div>
  );
}
