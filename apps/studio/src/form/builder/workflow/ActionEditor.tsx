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
export function ActionEditor({ form, action, people, customWorkflows, onChange }: ActionEditorProps) {
  const statuses = form.workflow?.statuses ?? [];

  const body = () => {
    switch (action.type) {
      case 'EMAIL':
        return (
          <>
            <Setting label="To">{() => <RecipientsEditor form={form} people={people} value={action.to} onChange={(to) => onChange({ ...action, to })} />}</Setting>
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
            <Setting label="Approvers" hint="Any one of them decides. The flow waits here until they approve or reject in the Inbox.">
              {() => <RecipientsEditor form={form} people={people} usersOnly value={action.to} onChange={(to) => onChange({ ...action, to })} />}
            </Setting>
            <TextSetting label="What to approve" value={action.title} onChange={(title) => onChange({ ...action, title })} />
            <TextSetting
              label="Instructions"
              multiline
              value={action.instructions}
              onChange={(instructions) => onChange({ ...action, instructions: instructions || undefined })}
            />
            <NumberSetting label="Due in (hours)" min={1} value={action.dueInHours} onChange={(dueInHours) => onChange({ ...action, dueInHours })} />
            <p className="fb-muted">
              Branch on the answer: give later steps "Run only if… {'→'} decision is Approved / Rejected". The approver's comment is{' '}
              <span className="fb-code">{'{{$steps.<key>.comment}}'}</span>.
            </p>
          </>
        );
      case 'ASSIGN':
        return (
          <Setting label="Assign to">{() => <PersonSelect people={people} value={action.userId} onChange={(userId) => onChange({ ...action, userId })} />}</Setting>
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
      case 'HANDLER': {
        const chosen = customWorkflows.find((w) => w.key === action.key);
        const options = customWorkflows.map((w) => ({ label: w.label, value: w.key }));
        if (action.key && !chosen) options.push({ label: `${action.key} (not available on the server)`, value: action.key });
        return (
          <SelectSetting
            label="Custom API"
            value={action.key || undefined}
            options={options}
            placeholder={customWorkflows.length ? 'Choose...' : 'No custom APIs on the server yet'}
            hint={chosen?.description ?? 'Custom logic written by developers for this kind of form. Ask them to add one if nothing here fits.'}
            onChange={(key) => onChange({ ...action, key })}
          />
        );
      }
    }
  };

  return <div className="fb-settings" style={{ gap: 10 }}>{body()}</div>;
}
