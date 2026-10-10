import { useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import type { FormDefinition } from '../../types';
import { isValueField } from '../../engine';
import { messageOf } from '../../adapters/backend';
import { useAddOwnPdf, useOwnPdfs } from '../../adapters/pdf-templates';
import { ChoiceSelect, SelectSetting } from './settings';

const OURS = '__ours__';
const SAME_NAME = '__same_name__';
const NOTHING = '__nothing__';
const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

type Doc = NonNullable<FormDefinition['document']>;

/**
 * "Use your own PDF": the organisation's fillable PDF (their claim form, their application form) in place of
 * the product's layout. Pick one from the library or add one; each of its boxes then says which question goes
 * into it. A box named like a question is matched by itself, so a well-named PDF needs no choosing at all.
 */
export function OwnPdfSetting({ form, onChange }: { form: FormDefinition; onChange: (document: Doc) => void }) {
  const { data: pdfs = [] } = useOwnPdfs();
  const add = useAddOwnPdf();
  const file = useRef<HTMLInputElement>(null);
  const chosen = form.document?.ownPdf;
  const pdf = pdfs.find((p) => p.id === chosen?.id);
  const questions = form.fields.filter((f) => isValueField(f) && !['HIDDEN', 'CAPTCHA', 'FILE', 'SIGNATURE', 'REPEAT'].includes(f.type));
  const sameName = (box: string) => questions.find((q) => plain(q.name) === plain(box)) ?? questions.find((q) => !!q.label && plain(q.label) === plain(box));
  const set = (ownPdf: Doc['ownPdf']) => onChange({ ...form.document, ownPdf });

  return (
    <div className="fb-settings" style={{ gap: 10 }} role="group" aria-label="Use your own PDF">
      <SelectSetting
        label="The PDF of a response is"
        value={chosen?.id && (pdf || chosen) ? chosen.id : OURS}
        options={[{ label: "Form Builder's own layout", value: OURS }, ...pdfs.map((p) => ({ label: `Our PDF: ${p.name}`, value: p.id })), ...(chosen && !pdf ? [{ label: `Our PDF: ${chosen.name} (no longer in the library)`, value: chosen.id }] : [])]}
        hint={chosen ? 'Each response is written into your PDF. The choices above about our own layout do not apply to it.' : 'To use your own fillable PDF (a form you already have), add it here.'}
        onChange={(id) => {
          const picked = pdfs.find((p) => p.id === id);
          set(picked ? { id: picked.id, name: picked.name } : undefined);
        }}
      />
      <div>
        <Button type="button" variant="outline" size="sm" disabled={add.isPending} onClick={() => file.current?.click()}>
          {add.isPending ? 'Checking the PDF…' : 'Add a fillable PDF'}
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          aria-label="Fillable PDF file"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (!picked) return;
            add.mutate(picked, {
              onSuccess: (made) => {
                set({ id: made.id, name: made.name });
                toast.success(`"${made.name}" added, with ${made.boxes.length} ${made.boxes.length === 1 ? 'box' : 'boxes'} to fill in`);
              },
              onError: (err) => toast.error(messageOf(err)),
            });
          }}
        />
      </div>
      {chosen && pdf && pdf.boxes.length > 0 && (
        <div className="fb-settings" style={{ gap: 6 }} role="group" aria-label="What goes into each box">
          <span className="fb-setting__label">What goes into each box</span>
          {pdf.boxes.map((box) => {
            const auto = sameName(box.name);
            const mapped = chosen.map?.[box.name];
            return (
              <div key={box.name} className="flex items-center gap-2">
                <span className="text-sm" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                  {box.name}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ChoiceSelect<string>
                    ariaLabel={`Question for the box ${box.name}`}
                    value={mapped === undefined ? SAME_NAME : mapped === '' ? NOTHING : mapped}
                    options={[
                      { label: auto ? `${auto.label || auto.name} (same name)` : 'Nothing (no question has this name)', value: SAME_NAME },
                      ...(auto ? [{ label: 'Nothing', value: NOTHING }] : []),
                      ...questions.map((q) => ({ label: q.label || q.name, value: q.name })),
                    ]}
                    onChange={(to) => {
                      const map = { ...(chosen.map ?? {}) };
                      if (to === SAME_NAME) delete map[box.name];
                      else map[box.name] = to === NOTHING ? '' : to;
                      set({ ...chosen, map: Object.keys(map).length ? map : undefined });
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
