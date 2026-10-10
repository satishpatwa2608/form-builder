import { MultiSelect } from '@ui/multiselect';
import { useSavedEmails, type SavedEmail } from '../../adapters/email-templates';
import { FLOW_SERVICE_INFO, FLOW_SERVICES, guessSource, isFlowAddress } from '../../engine';
import { answerFields } from './workflow-edits';

/** Choices in the "what goes into each field" lists that are not an answer's name. */
const AUTO = '__auto__';
const EMPTY = '__empty__';
import type { AutomationAction, FormDefinition } from '../../types';
import type { CustomWorkflow, Person } from '../../adapters/workflow';
import { NumberSetting, SelectSetting, Setting, TextSetting, SwitchSetting } from '../components/settings';
import { PersonSelect } from './PersonSelect';
import { RecipientsEditor } from './RecipientsEditor';

interface ActionEditorProps {
  form: FormDefinition;
  action: AutomationAction;
  people: Person[];
  customWorkflows: CustomWorkflow[];
  onChange: (action: AutomationAction) => void;
}

/** What one step does - the type-specific settings in the flow's side panel. */
type AssignAction = Extract<AutomationAction, { type: 'ASSIGN' }>;
const WAYS: { label: string; value: NonNullable<AssignAction['by']> }[] = [
  { label: 'A person I choose now', value: 'PERSON' },
  { label: 'It depends on an answer', value: 'ANSWER' },
  { label: 'The next person in a team, in turn', value: 'TURN' },
  { label: 'The manager of whoever has it', value: 'MANAGER' },
  { label: 'The person an answer or an earlier step names', value: 'EMAIL' },
];

/** Who an Assign step gives the record to: someone chosen now, or worked out when the step runs. */
function AssignSettings({ form, people, action, onChange }: { form: FormDefinition; people: Person[]; action: AssignAction; onChange: (action: AutomationAction) => void }) {
  const by = action.by ?? 'PERSON';
  const set = (change: Partial<AssignAction>) => onChange({ ...action, ...change });
  const choices = form.fields.filter((f) => (f.type === 'DROPDOWN' || f.type === 'RADIO') && f.dataSource?.type === 'STATIC');
  const deciding = choices.find((f) => f.name === action.field);
  const emails = form.fields.filter((f) => f.type === 'EMAIL');
  const fromField = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/.exec(action.from ?? '')?.[1];
  return (
    <>
      <SelectSetting
        label="Who gets it"
        value={by}
        options={WAYS}
        onChange={(next) => {
          // Only what this way of choosing uses is kept.
          const { by: _by, field: _f, map: _m, userIds: _u, from: _e, ...rest } = action;
          onChange({ ...rest, userId: next === 'PERSON' || next === 'ANSWER' ? action.userId : '', ...(next === 'PERSON' ? {} : { by: next }) });
        }}
      />
      {by === 'PERSON' && <Setting label="Assign to">{() => <PersonSelect people={people} value={action.userId} onChange={(userId) => set({ userId })} />}</Setting>}
      {by === 'ANSWER' && (
        <>
          <SelectSetting
            label="Which answer decides"
            value={deciding?.name}
            placeholder={choices.length ? 'Pick a dropdown or a choice…' : 'This form has no dropdown or choice field'}
            options={choices.map((f) => ({ label: f.label || f.name, value: f.name }))}
            onChange={(field) => set({ field, map: {} })}
          />
          {deciding?.dataSource?.options?.map((o) => (
            <Setting key={o.value} label={`${o.label} goes to`}>
              {() => (
                <PersonSelect
                  people={people}
                  value={action.map?.[o.value] ?? ''}
                  placeholder="The person for any other answer"
                  onChange={(userId) => {
                    const { [o.value]: _was, ...others } = action.map ?? {};
                    set({ map: userId ? { ...others, [o.value]: userId } : others });
                  }}
                />
              )}
            </Setting>
          ))}
          {deciding && <Setting label="Any other answer goes to">{() => <PersonSelect people={people} value={action.userId} placeholder="No one" onChange={(userId) => set({ userId })} />}</Setting>}
        </>
      )}
      {by === 'TURN' && (
        <Setting label="The team" hint="Each new record goes to the next of them, round and round.">
          {() => <MultiSelect options={people.map((p) => ({ label: p.name, value: p.uuid }))} value={action.userIds ?? []} onChange={(userIds) => set({ userIds })} placeholder="Add people…" maxVisibleTags={6} />}
        </Setting>
      )}
      {by === 'MANAGER' && <p className="fb-setting__hint">The record goes to the manager of the person it is with when this step runs (set on Members). With nobody, or no manager, the step fails and says so.</p>}
      {by === 'EMAIL' && (
        <>
          <SelectSetting
            label="Whose email it is"
            value={fromField && emails.some((f) => f.name === fromField) ? fromField : action.from ? 'OTHER' : undefined}
            placeholder="Pick where the email comes from…"
            options={[...emails.map((f) => ({ label: `The answer to "${f.label || f.name}"`, value: f.name })), { label: 'What an earlier step returned', value: 'OTHER' }]}
            onChange={(v) => set({ from: v === 'OTHER' ? '{{$steps.}}' : `{{${v}}}` })}
            hint="The record goes to the member with that email address. If there is no such member, the step fails and says so."
          />
          {action.from !== undefined && !(fromField && emails.some((f) => f.name === fromField)) && (
            <TextSetting label="From the step" value={action.from} placeholder="{{$steps.lookup.ownerEmail}}" hint="For example a Custom API step that looks the owner up in your own system: {{$steps.<step>.<what it returned>}}." onChange={(from) => set({ from })} />
          )}
        </>
      )}
    </>
  );
}

/** Fills an email step from one of the organisation's saved emails (Email templates in the menu). The words are copied. */
function SavedEmailPick({ onPick }: { onPick: (mail: SavedEmail) => void }) {
  const { data: saved = [] } = useSavedEmails();
  if (!saved.length) return null;
  return (
    <SelectSetting
      label="Start from a saved email"
      value={undefined}
      placeholder="Pick one to fill in the subject and message…"
      options={saved.map((m) => ({ label: m.name, value: m.id }))}
      onChange={(id) => {
        const mail = saved.find((m) => m.id === id);
        if (mail) onPick(mail);
      }}
      hint="From Email templates in the menu. You can change the words afterwards."
    />
  );
}

export function ActionEditor({ form, action, people, customWorkflows, onChange }: ActionEditorProps) {
  const statuses = form.workflow?.statuses ?? [];

  const body = () => {
    switch (action.type) {
      case 'EMAIL':
        return (
          <>
            <Setting label="To">{() => <RecipientsEditor form={form} people={people} value={action.to} onChange={(to) => onChange({ ...action, to })} />}</Setting>
            <SavedEmailPick onPick={(mail) => onChange({ ...action, subject: mail.subject, body: mail.body })} />
            <TextSetting label="Subject" value={action.subject} onChange={(subject) => onChange({ ...action, subject })} />
            <TextSetting label="Message" multiline value={action.body} hint="Plain text. Insert data from the list below, e.g. {{name}}" onChange={(b) => onChange({ ...action, body: b })} />
            <SwitchSetting
              label="Attach the PDF of the response"
              hint="The same document as in Responses: every answer, with your organisation's name and logo."
              checked={action.attachDocument === true}
              onChange={(on) => {
                const { attachDocument: _was, ...rest } = action;
                onChange(on ? { ...rest, attachDocument: true } : rest);
              }}
            />
          </>
        );
      case 'NOTIFY':
        return (
          <>
            <Setting label="To">
              {() => <RecipientsEditor form={form} people={people} usersOnly value={action.to} onChange={(to) => onChange({ ...action, to })} />}
            </Setting>
            <TextSetting label="Message" value={action.message} hint="Insert data from the list below, e.g. {{$record.ref}}" onChange={(message) => onChange({ ...action, message })} />
          </>
        );
      case 'CREATE_TASK':
        return (
          <>
            <Setting label="Give it to" hint="The first person is accountable; anyone else is responsible.">
              {() => <RecipientsEditor form={form} people={people} usersOnly value={action.to} onChange={(to) => onChange({ ...action, to })} />}
            </Setting>
            <TextSetting label="Task title" value={action.title} onChange={(title) => onChange({ ...action, title })} />
            <TextSetting
              label="Description"
              multiline
              value={action.description}
              onChange={(description) => onChange({ ...action, description: description || undefined })}
            />
            <NumberSetting label="Due in (hours)" min={1} value={action.dueInHours} onChange={(dueInHours) => onChange({ ...action, dueInHours })} />
          </>
        );
      case 'SIGN':
        return (
          <>
            <Setting label="Signers" hint="Each gets a private link by email and signs the PDF of the response on a page of ours. The flow waits until all have signed.">
              {() => <RecipientsEditor form={form} people={people} value={action.to} onChange={(to) => onChange({ ...action, to })} />}
            </Setting>
            <TextSetting label="What is being signed" value={action.title} onChange={(title) => onChange({ ...action, title })} />
            <TextSetting label="Message to the signers" multiline value={action.message} onChange={(message) => onChange({ ...action, message: message || undefined })} />
            <SelectSetting
              label="When there are several signers"
              value={action.order ?? 'IN_ORDER'}
              options={[
                { label: 'One after another, in the order above', value: 'IN_ORDER' },
                { label: 'All at once', value: 'PARALLEL' },
              ]}
              onChange={(order) => onChange({ ...action, order })}
            />
            <NumberSetting label="Give up after (days)" min={1} value={action.expiresInDays ?? 14} onChange={(expiresInDays) => onChange({ ...action, expiresInDays: expiresInDays ? Math.min(90, Math.round(expiresInDays)) : undefined })} />
          </>
        );
      case 'APPROVAL':
        return (
          <>
            <Setting label="Approvers" hint="The flow waits here until they approve or reject in the Inbox. Anyone away is replaced by the colleague they named.">
              {() => <RecipientsEditor form={form} people={people} usersOnly value={action.to} onChange={(to) => onChange({ ...action, to })} />}
            </Setting>
            <ApprovalRules value={action} onChange={(rules) => onChange({ ...action, ...rules })} />
            <Setting label="Ask at the same time" hint="Other approvals asked at the same moment, each of its own people about its own part. The flow goes on when every one is approved; one rejection settles it as rejected.">
              {() => (
                <div className="fb-settings" style={{ gap: 10 }}>
                  {(action.together ?? []).map((part, i) => (
                    <div key={i} className="fb-panel fb-settings" style={{ gap: 8, padding: 10 }} role="group" aria-label={`Approval ${i + 2} at the same time`}>
                      <TextSetting label="What to approve" value={part.title} onChange={(title) => onChange({ ...action, together: action.together!.map((x, j) => (j === i ? { ...x, title } : x)) })} />
                      <RecipientsEditor form={form} people={people} usersOnly value={part.to} onChange={(to) => onChange({ ...action, together: action.together!.map((x, j) => (j === i ? { ...x, to } : x)) })} />
                      <div>
                        <button
                          type="button"
                          className="fb-link"
                          onClick={() => {
                            const rest = action.together!.filter((_, j) => j !== i);
                            onChange({ ...action, together: rest.length ? rest : undefined });
                          }}
                        >
                          Remove this approval
                        </button>
                      </div>
                    </div>
                  ))}
                  {(action.together ?? []).length < 5 && (
                    <div>
                      <button type="button" className="fb-link" onClick={() => onChange({ ...action, together: [...(action.together ?? []), { to: [], title: '' }] })}>
                        + Add an approval asked at the same time
                      </button>
                    </div>
                  )}
                </div>
              )}
            </Setting>
            <TextSetting label="What to approve" value={action.title} onChange={(title) => onChange({ ...action, title })} />
            <TextSetting
              label="Instructions"
              multiline
              value={action.instructions}
              onChange={(instructions) => onChange({ ...action, instructions: instructions || undefined })}
            />
            <p className="fb-muted">
              Branch on the answer: give later steps "Run only if… {'→'} decision is Approved / Rejected". The approver's comment is{' '}
              <span className="fb-code">{'{{$steps.<key>.comment}}'}</span>.
            </p>
          </>
        );
      case 'ASSIGN':
        return (
          <AssignSettings form={form} people={people} action={action} onChange={onChange} />
        );
      case 'SET_STATUS':
        return (
          <SelectSetting
            label="Move to"
            value={action.status || undefined}
            options={statuses.map((s) => ({ label: s.label, value: s.key }))}
            onChange={(status) => onChange({ ...action, status })}
          />
        );
      case 'WEBHOOK':
        return (
          <TextSetting
            label="URL"
            value={action.url}
            placeholder="https://..."
            hint="POSTs the payload and the outputs of earlier steps as JSON; a JSON reply becomes this step’s output. Only https hosts on the server allow-list (FORM_WEBHOOK_ALLOWLIST)."
            onChange={(url) => onChange({ ...action, url: url.trim() })}
          />
        );
      case 'FLOW': {
        const info = FLOW_SERVICE_INFO[action.service];
        const pasted = action.url.trim();
        return (
          <>
            <SelectSetting label="Which tool" value={action.service} options={FLOW_SERVICES.map((s) => ({ label: FLOW_SERVICE_INFO[s].label, value: s }))} onChange={(service) => onChange({ ...action, service })} />
            <TextSetting
              label="The flow's address"
              value={action.url}
              placeholder="https://..."
              hint={pasted && !isFlowAddress(action.service, pasted) ? `That is not a ${info.label} address. ${info.where}` : `${info.where} The response and the outputs of earlier steps are sent to it; what it answers becomes this step's output. Treat the address like a password: anyone who has it can start the flow.`}
              onChange={(url) => onChange({ ...action, url: url.trim() })}
            />
          </>
        );
      }
      case 'HANDLER': {
        const chosen = customWorkflows.find((w) => w.key === action.key);
        const options = customWorkflows.map((w) => ({ label: w.label, value: w.key }));
        if (action.key && !chosen) options.push({ label: `${action.key} (not available on the server)`, value: action.key });
        const picker = (
          <SelectSetting
            label="Custom API"
            value={action.key || undefined}
            options={options}
            placeholder={customWorkflows.length ? 'Choose...' : 'No custom APIs on the server yet'}
            hint={chosen?.description ?? 'Custom logic written by developers for this kind of form. Ask them to add one if nothing here fits.'}
            // Another step fills other fields: the choices made for the last one do not carry over.
            onChange={(key) => onChange({ id: action.id, if: action.if, continueOnError: action.continueOnError, label: action.label, type: 'HANDLER', key } as typeof action)}
          />
        );
        if (!chosen?.inputs?.length) return picker;
        // A step that writes to another system: each of its fields, and the answer that fills it.
        // A question that takes a file offers the file itself and, beside it, its name and its kind, so a table
        // with a column for each is matched by name like any other answer.
        const files = form.fields.filter((f) => f.type === 'FILE' && !f.parentId);
        const answers = [
          ...answerFields(form),
          ...(form.workflow?.workFields ?? []),
          ...files.flatMap((f) => [
            { name: f.name, label: `${f.label || f.name} (the file itself)` },
            { name: `${f.name}__name`, label: `${f.label || f.name}: the file's name` },
            { name: `${f.name}__type`, label: `${f.label || f.name}: the kind of file` },
          ]),
        ];
        const names = answers.map((f) => f.name);
        const setSource = (target: string, source: string) => {
          const map = { ...(action.map ?? {}) };
          // Kept only where it differs from what would be matched anyway, so later renames keep working by themselves.
          if (source === AUTO) delete map[target];
          else map[target] = source === EMPTY ? '' : source;
          onChange({ ...action, map: Object.keys(map).length ? map : undefined });
        };
        return (
          <>
            {picker}
            <Setting label="What goes into each field" hint={`Matched by name where it can be. Change any that are wrong.${files.length ? ' A file goes into a field that can hold one (a binary column), up to 10 MB; when several were uploaded, the first.' : ''}`}>
              {() => (
                <div className="fb-settings" style={{ gap: 6 }} role="group" aria-label="What goes into each field">
                  {chosen.inputs!.map((target) => {
                    const guess = guessSource(target, names);
                    const picked = action.map?.[target];
                    const value = picked === undefined || (picked !== '' && !names.includes(picked)) ? AUTO : picked === '' ? EMPTY : picked;
                    const guessLabel = guess ? (answers.find((f) => f.name === guess)?.label || guess) : undefined;
                    return (
                      <SelectSetting
                        key={target}
                        label={target}
                        value={value}
                        options={[
                          { label: guessLabel ? `${guessLabel} (matched by name)` : 'Nothing matches: left empty', value: AUTO },
                          ...answers.map((f) => ({ label: f.label || f.name, value: f.name })),
                          ...(guess ? [{ label: 'Leave empty', value: EMPTY }] : []),
                        ]}
                        onChange={(source) => setSource(target, source)}
                      />
                    );
                  })}
                </div>
              )}
            </Setting>
          </>
        );
      }
    }
  };

  return <div className="fb-settings" style={{ gap: 10 }}>{body()}</div>;
}

export interface ApprovalRuleValues {
  byEmail?: boolean;
  need?: 'ANY' | 'ALL';
  dueInHours?: number;
  whenLate?: 'REMIND' | 'MANAGER' | 'REJECT';
}

/**
 * How an approval is settled and what happens when nobody answers: the same three choices on an approval step
 * and on an action that needs approval.
 */
export function ApprovalRules({ value, onChange }: { value: ApprovalRuleValues; onChange: (rules: ApprovalRuleValues) => void }) {
  return (
    <>
      <SelectSetting
        label="Who must approve"
        value={value.need ?? 'ANY'}
        options={[
          { label: 'Any one of them', value: 'ANY' },
          { label: 'Every one of them', value: 'ALL' },
        ]}
        hint={value.need === 'ALL' ? 'It goes ahead once all have approved. One rejection refuses it.' : 'The first answer decides.'}
        onChange={(need) => onChange({ need: need === 'ALL' ? 'ALL' : undefined })}
      />
      <NumberSetting label="Time to answer (hours)" min={1} value={value.dueInHours} onChange={(dueInHours) => onChange({ dueInHours, whenLate: dueInHours ? value.whenLate : undefined })} />
      {!!value.dueInHours && (
        <SelectSetting
          label="If nobody answers in time"
          value={value.whenLate ?? 'REMIND'}
          options={[
            { label: 'Remind them', value: 'REMIND' },
            { label: 'Ask their manager instead', value: 'MANAGER' },
            { label: 'Treat it as rejected', value: 'REJECT' },
          ]}
          hint={value.whenLate === 'MANAGER' ? 'Each person who has not answered gives way to their manager (set on the Members page).' : undefined}
          onChange={(whenLate) => onChange({ whenLate: whenLate === 'REMIND' ? undefined : (whenLate as 'MANAGER' | 'REJECT') })}
        />
      )}
      <SwitchSetting
        label="Let approvers answer from the email"
        hint="Their email carries a private link to approve or reject without signing in. It is theirs alone, works once and for 7 days. Leave off where an approval must be given by someone signed in."
        checked={!!value.byEmail}
        onChange={(on) => onChange({ byEmail: on || undefined })}
      />
    </>
  );
}
