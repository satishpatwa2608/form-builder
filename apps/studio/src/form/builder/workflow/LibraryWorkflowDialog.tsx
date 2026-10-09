import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ui/dialog';
import { Input } from '@ui/input';
import type { FormDefinition, FormField, SelectOption } from '../../types';
import { FormDefinitionError, isOptionField, sharedWorkflowForm, workflowFormFields, type SharedWorkflowField } from '../../engine';
import { messageOf } from '../../adapters/backend';
import { useSaveSharedWorkflow, type LibraryWorkflow, type LibraryWorkflowInput } from '../../adapters/shared-workflows';
import { useCustomWorkflows, usePeople } from '../../adapters/workflow';
import { VISIBLE_BORDER } from '../../runtime/styles';
import { ChoiceSelect, TextSetting } from '../components/settings';
import { STARTER_WORKFLOW } from './workflow-edits';
import { WorkflowTabs } from './WorkflowTabs';

type Kind = 'TEXT' | 'EMAIL' | 'NUMBER' | 'DATE' | 'CHECKBOX' | 'DROPDOWN' | 'MULTI_SELECT';
const KINDS: { label: string; value: Kind }[] = [
  { label: 'Text', value: 'TEXT' },
  { label: 'Email address', value: 'EMAIL' },
  { label: 'Number', value: 'NUMBER' },
  { label: 'Date', value: 'DATE' },
  { label: 'Yes / no', value: 'CHECKBOX' },
  { label: 'One choice from a list', value: 'DROPDOWN' },
  { label: 'Several choices from a list', value: 'MULTI_SELECT' },
];
/** The kind shown for a field type: a radio group and a dropdown are both "one choice" to a workflow. */
const kindOf = (type: FormField['type']): Kind => {
  if (type === 'RADIO' || type === 'DROPDOWN') return 'DROPDOWN';
  if (type === 'MULTI_SELECT' || type === 'CHECKBOX_GROUP') return 'MULTI_SELECT';
  if (type === 'CHECKBOX' || type === 'SWITCH') return 'CHECKBOX';
  if (type === 'NUMBER' || type === 'STEPPER') return 'NUMBER';
  if (type === 'DATE' || type === 'DATETIME') return 'DATE';
  return type === 'EMAIL' ? 'EMAIL' : 'TEXT';
};

/** "Requester's email" -> requestersEmail: the name a form's field must have to be matched without asking. */
export function answerName(label: string, taken: ReadonlySet<string>): string {
  const words = label
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9 ]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const base = words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('').replace(/^[0-9]+/, '') || 'answer';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
  return name;
}

/** Choices typed as "Minor, Serious". A choice that was there before keeps the value rules were written against. */
function ChoicesInput({ options, label, onChange }: { options: SelectOption[]; label: string; onChange: (options: SelectOption[]) => void }) {
  const [text, setText] = useState(options.map((o) => o.label).join(', '));
  return (
    <Input
      className={VISIBLE_BORDER}
      aria-label={label}
      placeholder="Choices, separated by commas"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const labels = [...new Set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))];
        onChange(labels.map((l) => options.find((o) => o.label === l) ?? { label: l, value: l }));
      }}
    />
  );
}

interface AnswersEditorProps {
  fields: SharedWorkflowField[];
  /** Names the workflow's rules and messages read: these cannot be removed. */
  used: ReadonlySet<string>;
  /** Names saved earlier: forms may already be matched to them, so they stay as they are. */
  settled: ReadonlySet<string>;
  onChange: (fields: SharedWorkflowField[]) => void;
}

/** The answers a library workflow reads from whichever form uses it. */
function AnswersEditor({ fields, used, settled, onChange }: AnswersEditorProps) {
  const set = (index: number, next: SharedWorkflowField) => onChange(fields.map((f, i) => (i === index ? next : f)));
  const relabel = (index: number, label: string) => {
    const f = fields[index];
    // A new answer is named after its label until something depends on the name.
    const free = !settled.has(f.name) && !used.has(f.name);
    const others = new Set(fields.filter((_, i) => i !== index).map((x) => x.name));
    set(index, { ...f, label, name: free ? answerName(label, others) : f.name });
  };
  return (
    <div className="fb-settings" style={{ gap: 8 }}>
      <p className="fb-muted">
        What this workflow needs to know from a form, for example the requester's email or how urgent it is. Its rules and messages can then use them. A form with a field of the same
        name is matched automatically; otherwise the designer picks the field from a list.
      </p>
      {fields.map((f, i) => (
        <div key={i} className="fb-answers__row">
          <div>
            <Input className={VISIBLE_BORDER} aria-label={`Answer ${i + 1}`} placeholder="What it is, e.g. Requester's email" value={f.label} onChange={(e) => relabel(i, e.target.value)} />
            <span className="fb-muted">Matches a form field named {f.name}</span>
          </div>
          <ChoiceSelect
            ariaLabel={`Kind of answer ${i + 1}`}
            value={kindOf(f.type)}
            options={KINDS}
            onChange={(type) => {
              const { options, ...rest } = f;
              set(i, { ...rest, type, ...(isOptionField({ type }) && options ? { options } : {}) });
            }}
          />
          {isOptionField(f) ? <ChoicesInput label={`Choices of answer ${i + 1}`} options={f.options ?? []} onChange={(options) => set(i, { ...f, options })} /> : <span />}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove answer ${i + 1}`}
            disabled={used.has(f.name)}
            title={used.has(f.name) ? 'The workflow uses this answer. Remove it from the rules and messages first.' : 'Remove'}
            onClick={() => onChange(fields.filter((_, x) => x !== i))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" onClick={() => onChange([...fields, { name: answerName('', new Set(fields.map((f) => f.name))), label: '', type: 'TEXT' }])}>
          <Plus /> Add an answer
        </Button>
      </div>
    </div>
  );
}

const blank = (): LibraryWorkflowInput => ({ name: '', description: '', workflow: STARTER_WORKFLOW, automations: [], fields: [] });

interface LibraryWorkflowDialogProps {
  /** The workflow to change, or null for a new one. */
  initial: LibraryWorkflow | null;
  readOnly: boolean;
  onClose: () => void;
}

/** Builds or changes a workflow in the library, with the same editors a form's own workflow has. */
export function LibraryWorkflowDialog({ initial, readOnly, onClose }: LibraryWorkflowDialogProps) {
  const { data: people = [] } = usePeople(true);
  const { data: customWorkflows = [] } = useCustomWorkflows(true);
  const save = useSaveSharedWorkflow();
  const [draft, setDraft] = useState<LibraryWorkflowInput>(() =>
    initial ? { id: initial.id, name: initial.name, description: initial.description ?? '', workflow: initial.workflow, automations: initial.automations, fields: initial.fields } : blank(),
  );
  const [problems, setProblems] = useState<string[]>([]);

  // The editors work on a form; this one has exactly the answers the workflow says it reads.
  const form = useMemo<FormDefinition>(() => {
    const standIn = sharedWorkflowForm({ ...draft, name: draft.name || 'this workflow' });
    return draft.fields.length ? standIn : { ...standIn, fields: [] };
  }, [draft]);
  const used = useMemo(() => new Set(workflowFormFields(draft.workflow, draft.automations)), [draft.workflow, draft.automations]);
  const settled = useMemo(() => new Set(initial?.fields.map((f) => f.name) ?? []), [initial]);
  // Once forms use it, records carry its status keys, so those keep their meaning.
  const publishedKeys = useMemo(() => new Set(initial?.usedBy.length ? initial.workflow.statuses.map((s) => s.key) : []), [initial]);

  const submit = async () => {
    const unnamed = draft.fields.findIndex((f) => !f.label.trim());
    if (!draft.name.trim()) return setProblems(['Give the workflow a name']);
    if (unnamed >= 0) return setProblems([`Say what answer ${unnamed + 1} is, or remove it`]);
    try {
      const saved = await save.mutateAsync({ ...draft, name: draft.name.trim() });
      toast.success(initial?.usedBy.length ? `"${saved.name}" saved. Forms that use it get the change when they are next published.` : `"${saved.name}" saved`);
      onClose();
    } catch (e) {
      setProblems(e instanceof FormDefinitionError ? e.issues.map((i) => i.message) : [messageOf(e)]);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="large" style={{ width: 'min(1180px, calc(100vw - 2rem))', maxWidth: 'none', maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>{initial ? initial.name : 'New workflow'}</DialogTitle>
          <DialogDescription>A workflow in the library can be used by any number of forms. Each form says which of its fields the workflow reads.</DialogDescription>
        </DialogHeader>
        <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="fb-source" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 260px', maxWidth: 380 }}>
              <TextSetting label="Name" value={draft.name} placeholder="e.g. Complaint handling" onChange={(name) => setDraft((d) => ({ ...d, name }))} />
            </div>
            <div style={{ flex: '2 1 320px' }}>
              <TextSetting label="What it is for" value={draft.description} placeholder="Shown to designers choosing a workflow" onChange={(description) => setDraft((d) => ({ ...d, description }))} />
            </div>
          </div>
        </fieldset>
        <WorkflowTabs
          form={form}
          people={people}
          customWorkflows={customWorkflows}
          publishedKeys={publishedKeys}
          readOnly={readOnly}
          shared
          first={{
            value: 'answers',
            label: `Form answers${draft.fields.length ? ` (${draft.fields.length})` : ''}`,
            content: <AnswersEditor fields={draft.fields} used={used} settled={settled} onChange={(fields) => setDraft((d) => ({ ...d, fields }))} />,
          }}
          onChange={(changes) =>
            setDraft((d) => ({
              ...d,
              ...('workflow' in changes && changes.workflow ? { workflow: changes.workflow } : {}),
              ...('automations' in changes ? { automations: changes.automations ?? [] } : {}),
            }))
          }
        />
        {!!problems.length && (
          <div className="fb-issues" role="alert">
            <div className="fb-issues__title">This workflow can't be saved yet</div>
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && (
            <Button type="button" disabled={save.isPending} onClick={() => void submit()}>
              Save workflow
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
