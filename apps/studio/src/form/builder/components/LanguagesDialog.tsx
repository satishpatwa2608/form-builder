import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import { Input } from '@ui/input';
import type { FormDefinition } from '../../types';
import { isRtl, LANGUAGE_NAMES, languageName, languagesOf, translatableStrings, translationProgress, translationsFromCsv, translationsFromXliff, translationsToCsv, translationsToXliff, UI_KEYS, UI_TEXT } from '../../engine';
import { VISIBLE_BORDER } from '../../runtime/styles';
import { ChoiceSelect, SelectSetting } from './settings';

interface LanguagesDialogProps {
  form: FormDefinition;
  readOnly: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (changes: Partial<FormDefinition>) => void;
}

const CHOICES = Object.entries(LANGUAGE_NAMES).map(([value, label]) => ({ value, label: value === 'en' ? label : `${label} (${value})` }));

/**
 * The languages a form is offered in. The form is written in one; each other
 * language is a column of translations, typed here or filled in by a
 * translator in a spreadsheet. Anything not translated shows in the form's
 * own language, so a form can go live before every word is done.
 */
export function LanguagesDialog({ form, readOnly, open, onOpenChange, onChange }: LanguagesDialogProps) {
  const [own, ...others] = languagesOf(form);
  const [current, setCurrent] = useState<string | undefined>(others[0]);
  const active = current && others.includes(current) ? current : others[0];
  const file = useRef<HTMLInputElement>(null);
  const strings = useMemo(() => translatableStrings(form), [form]);
  // A language the form app does not speak itself has its own phrases ("Submit") to translate as well.
  const builtIn = (l: string) => l in UI_TEXT || l.split('-')[0]! in UI_TEXT;
  const table = (active && form.translations?.[active]) || {};

  const setLanguages = (def: string, rest: string[]) => {
    const kept = Object.fromEntries(Object.entries(form.translations ?? {}).filter(([l]) => rest.includes(l)));
    onChange({ languages: rest.length || def !== 'en' ? { default: def, others: rest } : undefined, translations: Object.keys(kept).length ? kept : undefined });
  };
  const setText = (key: string, text: string) => {
    if (!active) return;
    const next = { ...table };
    if (text.trim()) next[key] = text;
    else delete next[key];
    onChange({ translations: { ...form.translations, [active]: next } });
  };

  const save = (text: string, type: string, name: string) => {
    const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  const download = () => save(translationsToCsv(form), 'text/csv;charset=utf-8', `${form.code}-translations.csv`);
  /** XLIFF is one language to a file: the one being worked on. */
  const downloadXliff = () => active && save(translationsToXliff(form, active), 'application/xliff+xml;charset=utf-8', `${form.code}-${active}.xlf`);
  const upload = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > 2 * 1024 * 1024) return void toast.error('The file is larger than 2 MB.');
    const text = (await picked.text()).replace(/^\uFEFF/, '');
    // An XLIFF file is XML; anything else is read as the spreadsheet.
    const xliff = text.trimStart().startsWith('<');
    const { translations, notes } = xliff ? translationsFromXliff(form, text) : translationsFromCsv(form, text);
    // Nothing was read: say why, and change nothing.
    if (notes[0]?.startsWith('The first column') || (xliff && !/ read\.$/.test(notes[0] ?? ''))) return void toast.error(notes[0]);
    onChange({ translations });
    toast.success(notes.join(' '));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="large" style={{ width: 'min(1100px, calc(100vw - 2rem))', maxWidth: 'none', maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>Languages</DialogTitle>
          <DialogDescription>People choose their language on the form. What is not translated yet is shown in the form's own language.</DialogDescription>
        </DialogHeader>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="fb-source" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: '0 1 240px' }}>
              <SelectSetting label="The form is written in" value={own} options={CHOICES} onChange={(def) => setLanguages(def, others.filter((l) => l !== def))} />
            </div>
            <div style={{ flex: '1 1 320px' }}>
              <div className="fb-setting">
                <span className="fb-setting__label">Also offered in</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  {others.map((l) => {
                    const p = translationProgress(form, l);
                    return (
                      <span key={l} className="fb-chip" style={{ gap: 6 }}>
                        <button type="button" className="fb-link" aria-pressed={l === active} onClick={() => setCurrent(l)} style={{ fontWeight: l === active ? 700 : 400 }}>
                          {languageName(l)} · {p.done} of {p.total}
                        </button>
                        <button type="button" className="fb-link" aria-label={`Remove ${languageName(l)}`} title="Remove this language and its translations" onClick={() => setLanguages(own!, others.filter((x) => x !== l))}>
                          ×
                        </button>
                      </span>
                    );
                  })}
                  <span style={{ minWidth: 200 }}>
                    <ChoiceSelect
                      ariaLabel="Add a language"
                      value={undefined}
                      placeholder="Add a language"
                      options={CHOICES.filter((c) => c.value !== own && !others.includes(c.value))}
                      onChange={(l) => {
                        setLanguages(own!, [...others, l]);
                        setCurrent(l);
                      }}
                    />
                  </span>
                </div>
              </div>
            </div>
          </div>
        </fieldset>

        {!others.length ? (
          <p className="fb-muted">Add a language to translate the form into it.</p>
        ) : (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <Button type="button" variant="outline" onClick={download}>
                Export for a translator
              </Button>
              {!readOnly && (
                <Button type="button" variant="outline" onClick={() => file.current?.click()}>
                  Import translations
                </Button>
              )}
              <Button type="button" variant="outline" onClick={downloadXliff}>
                Export {languageName(active!)} as XLIFF
              </Button>
              <input ref={file} type="file" accept="text/csv,.csv,.xlf,.xliff,application/xliff+xml" hidden aria-label="Translations file (.csv or .xlf)" onChange={(e) => void upload(e.target.files?.[0]).then(() => (e.target.value = ''))} />
              <span className="fb-muted">A spreadsheet with one row for each piece of wording and a column for each language, or an XLIFF file for one language (what translation tools exchange). Either can be imported.</span>
            </div>

            <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <table className="fb-translations" aria-label={`Translations into ${languageName(active!)}`}>
                <thead>
                  <tr>
                    <th>Where</th>
                    <th>{languageName(own!)}</th>
                    <th>{languageName(active!)}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...strings, ...(builtIn(active!) ? [] : UI_KEYS.map((k) => ({ key: `ui.${k}`, text: UI_TEXT.en[k], context: 'Said by the form itself' })))].map((s) => (
                    <tr key={s.key}>
                      <td className="fb-muted">{s.context}</td>
                      <td>{s.text}</td>
                      <td>
                        <Input
                          className={VISIBLE_BORDER}
                          aria-label={`${languageName(active!)}: ${s.text}`}
                          dir={isRtl(active) ? 'rtl' : 'ltr'}
                          lang={active}
                          value={table[s.key] ?? ''}
                          onChange={(e) => setText(s.key, e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </fieldset>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
