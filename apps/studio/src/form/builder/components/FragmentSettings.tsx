import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import type { FormDefinition, FormField } from '../../types';
import { descendants, extractFragment, FormDefinitionError, fragmentUse, isFragmentPrefix, syncFragments, type Fragment } from '../../engine';
import { messageOf } from '../../adapters/backend';
import { useFragments, useSaveFragment } from '../../adapters/fragments';
import { useFormBuilderStore } from '../store/useFormBuilderStore';
import { TextSetting } from './settings';

const problemOf = (e: unknown) => (e instanceof FormDefinitionError ? e.issues.map((i) => i.message).join(' ') : messageOf(e));

/** "Bank details" + what is taken -> bankDetails2: a prefix for a second copy of the same fragment. */
export function nextPrefix(name: string, taken: ReadonlySet<string>): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, '').trim().split(/\s+/).filter(Boolean);
  const base = (words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('').replace(/^[0-9]+/, '') || 'copy').slice(0, 16);
  for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

/**
 * The form with a fragment added at the end as a section. A second copy of
 * the same fragment is given a prefix straight away, so the two never share
 * field names.
 */
export function addFragmentSection(form: FormDefinition, fragment: Fragment, section: FormField): FormField[] {
  const others = form.fields.map((f) => fragmentUse(f)).filter((u) => u?.id === fragment.id);
  const prefix = others.length ? nextPrefix(fragment.name, new Set(others.map((u) => u!.prefix ?? ''))) : undefined;
  const placed: FormField = { ...section, label: fragment.name, props: { ...section.props, fragment: { id: fragment.id, ...(prefix ? { prefix } : {}) } } };
  return syncFragments({ fields: [...form.fields, placed] }, [fragment]).definition.fields;
}

interface FragmentSettingsProps {
  field: FormField;
  form: FormDefinition;
  /** May change the organisation's fragment library. */
  canManageLibrary: boolean;
  onFormChange: (changes: Partial<FormDefinition>) => void;
}

/**
 * What a section has to do with the fragment library: a copy of a fragment
 * says so, with its prefix and a way to detach it; an ordinary section can be
 * put into the library by an admin.
 */
export function FragmentSettings({ field, form, canManageLibrary, onFormChange }: FragmentSettingsProps) {
  const { data: library = [], isSuccess } = useFragments();
  const save = useSaveFragment();
  const unlocked = useFormBuilderStore((s) => s.unlockedFragment) === field.id;
  const unlock = useFormBuilderStore((s) => s.unlockFragment);
  const [newName, setNewName] = useState<string | null>(null);
  const use = fragmentUse(field);
  const fragment = use ? library.find((f) => f.id === use.id) : undefined;

  const replaceSection = (next: FormField, lib: Fragment[] = library) =>
    onFormChange({ fields: syncFragments({ fields: form.fields.map((f) => (f.id === field.id ? next : f)) }, lib).definition.fields });
  const withUse = (fragmentProp: unknown): FormField => {
    const { fragment: _old, ...props } = field.props ?? {};
    return { ...field, props: fragmentProp === undefined ? props : { ...props, fragment: fragmentProp } };
  };

  if (!use) {
    if (!canManageLibrary || !descendants(form.fields, field.id).length) return null;
    return newName === null ? (
      <div>
        <Button type="button" variant="outline" onClick={() => setNewName(field.label || 'Fragment')}>
          Save as fragment
        </Button>
        <span className="fb-setting__hint" style={{ display: 'block' }}>
          Keeps this section in the library so other forms can use it.
        </span>
      </div>
    ) : (
      <div className="fb-source fb-source--box" style={{ marginBottom: 0 }}>
        <div style={{ flex: '1 1 160px' }}>
          <TextSetting label="Name in the library" value={newName} onChange={setNewName} />
        </div>
        <Button
          type="button"
          disabled={!newName.trim() || save.isPending}
          onClick={() =>
            void save
              .mutateAsync({ name: newName.trim(), fields: extractFragment(form.fields, field.id) })
              .then((saved) => {
                replaceSection(withUse({ id: saved.id }), [...library, saved]);
                setNewName(null);
                toast.success(`"${saved.name}" is in the library. This section is now a copy of it.`);
              })
              .catch((e) => toast.error(problemOf(e)))
          }
        >
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={() => setNewName(null)}>
          Cancel
        </Button>
      </div>
    );
  }

  const prefixProblem = use.prefix && !isFragmentPrefix(use.prefix) ? 'Letters and digits only, starting with a letter.' : undefined;
  return (
    <div className="fb-settings" style={{ gap: 10 }}>
      <div className="fb-banner">
        {fragment ? (
          <>
            A copy of the fragment <strong>{fragment.name}</strong>. Its fields come from the library and are brought up to date when this form is opened here and when it is published.
          </>
        ) : isSuccess ? (
          <>This section was copied from a fragment that is no longer in the library. Detach it to keep its fields as this form's own.</>
        ) : (
          <>A copy of a fragment from the library.</>
        )}
      </div>
      <TextSetting
        label="Prefix for its field keys"
        value={use.prefix}
        placeholder="none"
        hint={prefixProblem ?? (use.prefix ? `Its answers are stored as ${use.prefix}_… Needed when the form uses this fragment more than once.` : 'Leave empty unless the form uses this fragment more than once.')}
        onChange={(prefix) => replaceSection(withUse({ id: use.id, ...(prefix ? { prefix } : {}) }))}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            unlock(undefined);
            onFormChange({ fields: form.fields.map((f) => (f.id === field.id ? withUse(undefined) : f)) });
          }}
          title="Its fields stay, as this form's own, and stop following the library"
        >
          Detach from the library
        </Button>
        {canManageLibrary && fragment && !unlocked && (
          <Button type="button" variant="outline" onClick={() => unlock(field.id)} title="Change its fields here, then save them to the library for every form">
            Change this fragment
          </Button>
        )}
        {canManageLibrary && fragment && unlocked && (
          <>
            <Button
              type="button"
              disabled={save.isPending}
              onClick={() =>
                void save
                  .mutateAsync({ id: fragment.id, name: fragment.name, description: fragment.description, fields: extractFragment(form.fields, field.id) })
                  .then((saved) => {
                    unlock(undefined);
                    replaceSection(field, library.map((f) => (f.id === saved.id ? saved : f)));
                    toast.success(`"${saved.name}" saved. Other forms get the change when they are next published.`);
                  })
                  .catch((e) => toast.error(problemOf(e)))
              }
            >
              Save to the library
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                unlock(undefined);
                replaceSection(field);
              }}
            >
              Discard my changes
            </Button>
          </>
        )}
      </div>
      {unlocked && <span className="fb-setting__hint">You are changing the fragment itself. Add, change or remove fields in this section, then save to the library.</span>}
    </div>
  );
}
