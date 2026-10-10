import { useState } from 'react';
import { Button } from '@ui/button';
import { Checkbox } from '@ui/checkbox';
import { Input } from '@ui/input';
import type { FormDefinition, FormField } from '../../types';
import { isValueField } from '../../engine';
import { api } from '../../../lib/api';
import { messageOf, USE_API } from '../../adapters/backend';
import { useDataSources } from '../../adapters/data-source/data-source-adapter';
import { publicFormUrl } from '../../links';
import { VISIBLE_BORDER } from '../../runtime/styles';
import { ChoiceSelect, SelectSetting, Setting, SwitchSetting } from './settings';

type Open = NonNullable<FormDefinition['openWith']>;

const EMPTY = '__empty__';
const RECORD = '__record__';
const NOTHING = '__nothing__';
const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const labelOf = (f: FormField) => f.label || f.name;
/** A property named like the question (give or take capitals, spaces and underscores), when there is one. */
const match = (q: FormField, properties: string[]) => properties.find((p) => plain(p) === plain(q.name)) ?? properties.find((p) => !!q.label && plain(p) === plain(q.label));

/** What a question of a repeating section, or of the form itself, can be filled from. */
function fillFrom(questions: FormField[], properties: string[]): Record<string, string> {
  return Object.fromEntries(questions.flatMap((q) => (match(q, properties) ? [[q.name, match(q, properties)!]] : [])));
}

/**
 * "Opens with a record": the form opens already filled from a record in one of the organisation's systems (a
 * renewal that knows the customer, a request that knows the employee). The record is read on our server, so the
 * person filling the form sees only the answers chosen here. Questions named like the record's fields are
 * matched by themselves.
 */
export function OpenWithSetting({ form, onChange }: { form: FormDefinition; onChange: (openWith: Open | undefined) => void }) {
  const { data: sources = [] } = useDataSources();
  const open = form.openWith;
  const usable = sources.filter((x) => (x.params?.length ?? 0) > 0 && !x.list);
  const source = sources.find((x) => x.key === open?.source);
  const properties = source?.params ?? [];
  const questions = form.fields.filter((f) => isValueField(f) && !f.parentId && !['HIDDEN', 'CAPTCHA', 'FILE', 'SIGNATURE', 'REPEAT', 'BUTTON'].includes(f.type));
  const sections = form.fields.filter((f) => f.type === 'REPEAT');
  const signedIn = form.access === 'AUTHENTICATED';

  /** Everything that follows from the record being in `key`: what finds it, and every question that can be matched by name. */
  const startFrom = (key: string): Open => {
    const picked = sources.find((x) => x.key === key);
    const fields = picked?.params ?? [];
    return { source: key, param: fields.find((f) => /^(id|no|number|code|key|email)$/i.test(f)) ?? fields[0] ?? '', by: 'LINK', set: fillFrom(questions, fields) };
  };
  const set = (changes: Partial<Open>) => open && onChange({ ...open, ...changes });
  const locked = new Set(open?.lock ?? []);
  const lock = (name: string, on: boolean) => {
    const next = on ? [...locked, name] : [...locked].filter((n) => n !== name);
    set({ lock: next.length ? next : undefined });
  };

  return (
    <div className="fb-settings" style={{ gap: 10 }} role="group" aria-label="Opens with a record">
      <SelectSetting
        label="This form opens"
        value={open ? RECORD : EMPTY}
        options={[
          { label: 'Empty', value: EMPTY },
          { label: 'Filled from a record', value: RECORD },
        ]}
        hint={
          open
            ? 'The record is read on our server: the person filling the form sees only the answers chosen below, never the rest of the record.'
            : usable.length
              ? 'For a form about something you already hold: a renewal that knows the customer, a request that knows the employee.'
              : 'To open a form with a record, first connect the system the records are in (Connectors) and tick the table there.'
        }
        onChange={(v) => onChange(v === RECORD ? startFrom(usable[0]?.key ?? '') : undefined)}
      />
      {open && (
        <>
          <SelectSetting
            label="The record is in"
            value={open.source || undefined}
            options={[...usable.map((x) => ({ label: x.name, value: x.key })), ...(open.source && !usable.some((x) => x.key === open.source) ? [{ label: 'A table that is no longer offered', value: open.source }] : [])]}
            onChange={(key) => onChange({ ...startFrom(key), by: open.by, only: open.only })}
          />
          <SelectSetting label="It is found by its" value={open.param || undefined} options={[...new Set([...properties, ...(open.param ? [open.param] : [])])].map((p) => ({ label: p, value: p }))} onChange={(param) => set({ param })} />
          <SelectSetting<Open['by']>
            label="Which record"
            value={open.by}
            options={[
              { label: 'The one a link was made for', value: 'LINK' },
              ...(signedIn || open.by === 'USER_EMAIL' ? [{ label: 'The one with the email of whoever is signed in', value: 'USER_EMAIL' as const }] : []),
              ...(signedIn || open.by === 'EMPLOYEE_ID' ? [{ label: 'The one with the employee number of whoever is signed in', value: 'EMPLOYEE_ID' as const }] : []),
            ]}
            hint={
              open.by === 'LINK'
                ? 'You make a link for each record (below, once the form is published) and send it to the person. A link cannot be guessed or changed to show another record.'
                : signedIn
                  ? 'Each person opens the form with their own record.'
                  : 'This needs "Who can open it" set to people who are signed in.'
            }
            onChange={(by) => set({ by, ...(by === 'LINK' ? {} : { only: undefined }) })}
          />
          {!signedIn && <span className="fb-setting__hint">To find the record by who is signed in instead, set "Who can open it" to people who are signed in.</span>}
          {open.by === 'LINK' && (
            <SwitchSetting label="Only open from such a link" hint="Without a link the form does not open, and cannot be sent." checked={!!open.only} onChange={(on) => set({ only: on || undefined })} />
          )}

          <div className="fb-panel__title">What the record fills</div>
          {questions.length === 0 && <p className="fb-muted">Add questions to the form first.</p>}
          {questions.map((q) => (
            <div key={q.name} className="flex items-center gap-2" role="group" aria-label={`Fill ${labelOf(q)}`}>
              <span className="text-sm" style={{ flex: 1, minWidth: 0 }}>
                {labelOf(q)}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ChoiceSelect
                  ariaLabel={`${labelOf(q)} comes from`}
                  value={open.set[q.name] ?? NOTHING}
                  options={[{ label: 'Not filled', value: NOTHING }, ...[...new Set([...properties, ...(open.set[q.name] ? [open.set[q.name]!] : [])])].map((p) => ({ label: p, value: p }))]}
                  onChange={(p) => {
                    const next = { ...open.set };
                    if (p === NOTHING) delete next[q.name];
                    else next[q.name] = p;
                    onChange({ ...open, set: next, lock: p === NOTHING ? (open.lock ?? []).filter((n) => n !== q.name) : open.lock });
                  }}
                />
              </div>
              <label className="flex items-center gap-2 text-sm" title="Shown but not changeable, and read from the record again when the form is sent">
                <Checkbox className={VISIBLE_BORDER} aria-label={`Keep ${labelOf(q)} as the record says`} disabled={!(q.name in open.set)} checked={locked.has(q.name)} onCheckedChange={(c) => lock(q.name, c === true)} />
                Keep
              </label>
            </div>
          ))}
          {questions.length > 0 && <span className="fb-setting__hint">"Keep" shows the answer as the record has it: the person cannot change it, and it is read from the record again when the form is sent.</span>}

          {sections.map((section) => {
            const rows = open.rows?.find((r) => r.into === section.name);
            const lists = source?.related ?? [];
            const list = lists.find((l) => l.name === rows?.from);
            const children = form.fields.filter((f) => f.parentId === section.id && isValueField(f));
            const others = (open.rows ?? []).filter((r) => r.into !== section.name);
            const put = (next: NonNullable<Open['rows']>[number] | undefined) => {
              const all = next ? [...others, next] : others;
              onChange({ ...open, rows: all.length ? all : undefined, lock: next ? open.lock : (open.lock ?? []).filter((n) => n !== section.name) });
            };
            if (!lists.length && !rows) return null;
            return (
              <div key={section.name} className="fb-settings" style={{ gap: 6 }} role="group" aria-label={`Fill the rows of ${labelOf(section)}`}>
                <span className="fb-setting__label">The rows of {labelOf(section)}</span>
                <ChoiceSelect
                  ariaLabel={`Rows of ${labelOf(section)} come from`}
                  value={rows?.from ?? NOTHING}
                  options={[
                    { label: 'Not filled', value: NOTHING },
                    ...lists.map((l) => ({ label: `One for each of the record's "${l.name}"`, value: l.name })),
                    ...(rows?.from && !list ? [{ label: `The record's "${rows.from}"`, value: rows.from }] : []),
                  ]}
                  onChange={(from) => put(from === NOTHING ? undefined : { into: section.name, from, set: fillFrom(children, lists.find((l) => l.name === from)?.fields ?? []) })}
                />
                {rows &&
                  children.map((q) => (
                    <div key={q.name} className="flex items-center gap-2">
                      <span className="text-sm" style={{ flex: 1, minWidth: 0 }}>
                        {labelOf(q)}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <ChoiceSelect
                          ariaLabel={`${labelOf(q)} of ${labelOf(section)} comes from`}
                          value={rows.set[q.name] ?? NOTHING}
                          options={[{ label: 'Not filled', value: NOTHING }, ...[...new Set([...(list?.fields ?? []), ...(rows.set[q.name] ? [rows.set[q.name]!] : [])])].map((p) => ({ label: p, value: p }))]}
                          onChange={(p) => {
                            const next = { ...rows.set };
                            if (p === NOTHING) delete next[q.name];
                            else next[q.name] = p;
                            put({ ...rows, set: next });
                          }}
                        />
                      </div>
                    </div>
                  ))}
                {rows && (
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox className={VISIBLE_BORDER} aria-label={`Keep the rows of ${labelOf(section)} as the record says`} checked={locked.has(section.name)} onCheckedChange={(c) => lock(section.name, c === true)} />
                    Keep these rows as the record has them
                  </label>
                )}
              </div>
            );
          })}
          {sections.length > 0 && !(source?.related?.length || open.rows?.length) && (
            <span className="fb-setting__hint">To fill a repeating section too (a customer's orders), say on the connector which rows belong to the record: "Related rows" on its table.</span>
          )}
          {open.by === 'LINK' && <span className="fb-setting__hint">Once the form is published, make the link for each record from the Forms list: "Link for a record" beside this form.</span>}
        </>
      )}
    </div>
  );
}

/** Makes the link for one record: type what identifies it (its number, its code) and copy the link that comes back. */
export function MakeRecordLink({ form, what }: { form: { id: string; orgId: string; code: string }; what: string }) {
  const [value, setValue] = useState('');
  const [made, setMade] = useState<{ url: string; until: string }>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    setProblem(undefined);
    setMade(undefined);
    try {
      if (!USE_API) throw new Error('Links are made once the form is published.');
      const { token, expiresAt } = await api<{ token: string; expiresAt: string }>(`/forms/${form.id}/fill-links`, { method: 'POST', body: { value: value.trim() } });
      setMade({ url: `${publicFormUrl(form.orgId, form.code)}?fill=${encodeURIComponent(token)}`, until: new Date(expiresAt).toLocaleDateString() });
    } catch (e) {
      setProblem(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fb-settings" style={{ gap: 6 }} role="group" aria-label="Make a link for a record">
      <div className="fb-panel__title">Make a link for a record</div>
      <Setting label={`The record's ${what || 'key'}`} hint="The link opens the published form with that record. It works for 30 days.">
        {(id) => (
          <div className="flex items-center gap-2">
            <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} />
            <Button type="button" variant="outline" size="sm" disabled={!value.trim() || busy} onClick={() => void make()}>
              Make the link
            </Button>
          </div>
        )}
      </Setting>
      {problem && (
        <p className="fb-muted" role="alert">
          {problem}
        </p>
      )}
      {made && (
        <div className="flex items-center gap-2">
          <Input readOnly aria-label="Link for this record" value={made.url} onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(made.url)}>
            Copy
          </Button>
        </div>
      )}
      {made && <span className="fb-setting__hint">Good until {made.until}. Anyone who has the link sees this record's answers, so send it only to the person it is for.</span>}
    </div>
  );
}
