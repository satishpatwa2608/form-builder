import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import type { FormStyle, StyleProps } from '../types';
import { styleClass, styleToCss } from '../engine';
import { messageOf } from '../adapters/backend';
import { styleIdFor, useDeleteStyle, useSaveStyle, useStyles } from '../adapters/styles/style-master';
import { useFormPermissions } from '../hooks/useFormPermissions';
import { ColorSetting, NumberSetting, SelectSetting, TextSetting } from '../builder/components/settings';
import { ConfirmDialog, type ConfirmRequest } from '../builder/components/ConfirmDialog';
import '../styles/form-builder.css';

const blank = (): FormStyle => ({ id: '', name: '', props: { borderWidth: 1, borderRadius: 10, padding: 16 } });
const SCOPE = '.fb-style-preview';

/** What a style looks like, drawn with the same CSS a form would get: a heading, a line of text and a box to type in. */
function Preview({ style }: { style: FormStyle }) {
  const shown = { ...style, id: style.id || 'preview' };
  return (
    <div className="fb-style-preview" aria-label={`How ${style.name || 'this style'} looks`}>
      <style>{styleToCss(SCOPE, shown)}</style>
      <div className={styleClass(shown.id)}>
        <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>A question</label>
        <input readOnly value="An answer" aria-label="Example answer" style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6 }} />
        <p style={{ margin: '8px 0 0' }}>Some words under it, to show the text.</p>
      </div>
    </div>
  );
}

/** One style's choices: colours, edges, room and text, each a picker or a number within its range. No CSS is typed. */
function StyleEditor({ initial, taken, readOnly, onClose }: { initial: FormStyle | null; taken: string[]; readOnly: boolean; onClose: () => void }) {
  const save = useSaveStyle();
  const [draft, setDraft] = useState<FormStyle>(() => initial ?? blank());
  const [problem, setProblem] = useState<string>();
  const set = (props: Partial<StyleProps>) => setDraft((d) => ({ ...d, props: Object.fromEntries(Object.entries({ ...d.props, ...props }).filter(([, v]) => v !== undefined && v !== '')) as StyleProps }));
  const p = draft.props;
  const submit = async () => {
    if (!draft.name.trim()) return setProblem('Give the style a name');
    try {
      await save.mutateAsync({ ...draft, name: draft.name.trim(), id: initial?.id ?? styleIdFor(draft.name, taken) });
      toast.success(`"${draft.name.trim()}" saved. Forms get it when they are next published.`);
      onClose();
    } catch (e) {
      setProblem(messageOf(e));
    }
  };
  return (
    <section className="fb-designer" aria-label="Style editor">
      <header className="fb-designer__head">
        <div>
          <button type="button" className="fb-link" onClick={onClose}>
            ← All styles
          </button>
          <h1 className="text-2xl font-semibold text-gray-900">{initial ? initial.name : 'New style'}</h1>
          <p className="text-sm text-muted-foreground">A look that a question, a section or a whole form can be given. Every choice is a colour, a size or a pick from a list.</p>
        </div>
        <div className="fb-designer__actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button type="button" disabled={save.isPending} onClick={() => void submit()}>
              Save style
            </Button>
          )}
        </div>
      </header>
      {problem && (
        <div className="fb-issues" role="alert">
          {problem}
        </div>
      )}
      <div className="fb-style-editor">
        <fieldset disabled={readOnly} className="fb-settings" style={{ border: 0, padding: 0, margin: 0, minWidth: 0, gap: 12 }}>
          <TextSetting label="Name" value={draft.name} placeholder="e.g. Highlight box" onChange={(name) => setDraft((d) => ({ ...d, name }))} />
          <TextSetting label="What it is for" value={draft.description} placeholder="Shown to designers choosing a style" onChange={(description) => setDraft((d) => ({ ...d, description: description || undefined }))} />
          <div className="fb-panel__title">Colours</div>
          <ColorSetting label="Text" value={p.textColor} onChange={(textColor) => set({ textColor })} />
          <ColorSetting label="Question labels" value={p.labelColor} onChange={(labelColor) => set({ labelColor })} />
          <ColorSetting label="Background" value={p.backgroundColor} onChange={(backgroundColor) => set({ backgroundColor })} />
          <ColorSetting label="Background when pointed at" value={p.hoverBackgroundColor} onChange={(hoverBackgroundColor) => set({ hoverBackgroundColor })} hint="Shown while the mouse is over it. Leave empty for no change." />
          <ColorSetting label="Edge" value={p.borderColor} onChange={(borderColor) => set({ borderColor })} />
          <ColorSetting label="Background of answer boxes" value={p.inputBackground} onChange={(inputBackground) => set({ inputBackground })} />
          <ColorSetting label="Edge of answer boxes" value={p.inputBorderColor} onChange={(inputBorderColor) => set({ inputBorderColor })} />
          <div className="fb-panel__title">Shape and room</div>
          <div className="fb-row">
            <NumberSetting label="Edge thickness (0 to 8)" min={0} value={p.borderWidth} onChange={(borderWidth) => set({ borderWidth })} />
            <NumberSetting label="Roundness (0 to 32)" min={0} value={p.borderRadius} onChange={(borderRadius) => set({ borderRadius })} />
            <NumberSetting label="Room inside (0 to 48)" min={0} value={p.padding} onChange={(padding) => set({ padding })} />
          </div>
          <SelectSetting
            label="Shadow"
            value={p.shadow ?? 'none'}
            options={[
              { label: 'None', value: 'none' },
              { label: 'Faint', value: 'sm' },
              { label: 'Soft', value: 'md' },
              { label: 'Deep', value: 'lg' },
            ]}
            onChange={(shadow) => set({ shadow: shadow === 'none' ? undefined : (shadow as StyleProps['shadow']) })}
          />
          <div className="fb-panel__title">Text</div>
          <div className="fb-row">
            <NumberSetting label="Size (10 to 36)" min={10} value={p.fontSize} onChange={(fontSize) => set({ fontSize })} />
            <SelectSetting
              label="Weight"
              value={String(p.fontWeight ?? 'default')}
              options={[
                { label: 'As the form', value: 'default' },
                { label: 'Normal', value: '400' },
                { label: 'Medium', value: '500' },
                { label: 'Semi-bold', value: '600' },
                { label: 'Bold', value: '700' },
              ]}
              onChange={(w) => set({ fontWeight: w === 'default' ? undefined : (Number(w) as StyleProps['fontWeight']) })}
            />
            <SelectSetting
              label="Lined up"
              value={p.textAlign ?? 'default'}
              options={[
                { label: 'As the form', value: 'default' },
                { label: 'Left', value: 'left' },
                { label: 'Centre', value: 'center' },
                { label: 'Right', value: 'right' },
              ]}
              onChange={(a) => set({ textAlign: a === 'default' ? undefined : (a as StyleProps['textAlign']) })}
            />
          </div>
        </fieldset>
        <div>
          <div className="fb-panel__title">How it looks</div>
          <Preview style={draft} />
        </div>
      </div>
    </section>
  );
}

/** The style library: looks made once and given to questions, sections and forms. Admins change it; everyone can look. */
export default function StylesPage() {
  const { canManagePages } = useFormPermissions();
  const { data: styles = [], isLoading } = useStyles();
  const remove = useDeleteStyle();
  const [editing, setEditing] = useState<FormStyle | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const taken = useMemo(() => styles.map((s) => s.id), [styles]);

  if (editing !== undefined) {
    return (
      <div className="p-6">
        <StyleEditor key={editing?.id ?? 'new'} initial={editing} taken={taken} readOnly={!canManagePages} onClose={() => setEditing(undefined)} />
      </div>
    );
  }
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4" style={{ flexWrap: 'wrap' }}>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-gray-900">Styles</h1>
          <p className="text-sm text-muted-foreground">Looks made once and used on many forms. In a form, pick one for a question, a section, or the whole form.</p>
        </div>
        {canManagePages && (
          <Button type="button" onClick={() => setEditing(null)}>
            <Plus /> New style
          </Button>
        )}
      </div>
      {isLoading ? (
        <p className="fb-muted">Loading…</p>
      ) : styles.length === 0 ? (
        <p className="fb-muted">{canManagePages ? 'No styles yet. Make one with New style.' : 'No styles yet. An administrator can add them.'}</p>
      ) : (
        <ul className="fb-style-list" aria-label="Styles">
          {styles.map((s) => (
            <li key={s.id} className="fb-style-card">
              <Preview style={s} />
              <div className="fb-style-card__foot">
                <span>
                  <strong>{s.name}</strong>
                  {s.description && <span className="fb-muted" style={{ display: 'block' }}>{s.description}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <button type="button" className="fb-link" aria-label={`${canManagePages ? 'Edit' : 'View'} ${s.name}`} onClick={() => setEditing(s)}>
                    {canManagePages ? 'Edit' : 'View'}
                  </button>
                  {canManagePages && (
                    <button
                      type="button"
                      className="fb-link"
                      aria-label={`Delete ${s.name}`}
                      onClick={() =>
                        setConfirm({
                          title: `Delete "${s.name}"?`,
                          description: 'It is removed from the library. Forms already published keep the look they were published with; drafts that use it lose it.',
                          confirmLabel: 'Delete',
                          destructive: true,
                          onConfirm: () => void remove.mutateAsync(s.id).catch((e) => toast.error(messageOf(e))),
                        })
                      }
                    >
                      Delete
                    </button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
