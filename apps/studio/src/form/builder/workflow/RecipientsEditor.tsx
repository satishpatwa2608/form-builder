import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import type { FormDefinition, RecipientRef } from '../../types';
import type { Person } from '../../adapters/workflow';
import { ChoiceSelect } from '../components/settings';
import { PersonSelect } from './PersonSelect';

interface RecipientsEditorProps {
  form: FormDefinition;
  people: Person[];
  value: RecipientRef[];
  onChange: (value: RecipientRef[]) => void;
  /** Notifications go to members only - no typed addresses or form answers. */
  usersOnly?: boolean;
}

type AddKind = 'ASSIGNEE' | 'MANAGER' | 'SUBMITTER' | 'USER' | 'EMAIL' | `FIELD:${string}`;

const same = (a: RecipientRef, b: RecipientRef) => JSON.stringify(a) === JSON.stringify(b);

/** Who a message or task goes to, as removable chips plus an "Add" picker. */
export function RecipientsEditor({ form, people, value, onChange, usersOnly }: RecipientsEditorProps) {
  const [adding, setAdding] = useState<AddKind | ''>('');
  const [email, setEmail] = useState('');
  const tracked = !!form.workflow?.enabled;

  const label = (r: RecipientRef) => {
    switch (r.kind) {
      case 'ASSIGNEE':
        return 'The assignee';
      case 'MANAGER':
        return "The assignee's manager";
      case 'SUBMITTER':
        return 'The person who submitted (if signed in)';
      case 'USER':
        return people.find((p) => p.uuid === r.userId)?.name ?? r.userId;
      case 'FIELD': {
        const f = form.fields.find((x) => x.name === r.field);
        return `Answer to "${f?.label ?? r.field}"`;
      }
      case 'EMAIL':
        return r.email;
    }
  };

  const add = (r: RecipientRef) => {
    if (!value.some((x) => same(x, r))) onChange([...value, r]);
    setAdding('');
    setEmail('');
  };

  const choices = [
    ...(tracked
      ? [
          { label: 'The assignee', value: 'ASSIGNEE' as AddKind },
          { label: "The assignee's manager", value: 'MANAGER' as AddKind },
        ]
      : []),
    { label: 'The person who submitted', value: 'SUBMITTER' as AddKind },
    { label: 'A person...', value: 'USER' as AddKind },
    ...(usersOnly
      ? []
      : [
          ...form.fields.filter((f) => f.type === 'EMAIL').map((f) => ({ label: `Answer to "${f.label || f.name}"`, value: `FIELD:${f.name}` as AddKind })),
          { label: 'An email address...', value: 'EMAIL' as AddKind },
        ]),
  ];

  const pick = (kind: AddKind) => {
    if (kind === 'ASSIGNEE' || kind === 'MANAGER' || kind === 'SUBMITTER') add({ kind });
    else if (kind.startsWith('FIELD:')) add({ kind: 'FIELD', field: kind.slice(6) });
    else setAdding(kind);
  };

  return (
    <div className="fb-settings" style={{ gap: 6 }}>
      {value.length > 0 && (
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          {value.map((r, i) => (
            <span key={i} className="fb-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {label(r)}
              <button type="button" aria-label={`Remove ${label(r)}`} onClick={() => onChange(value.filter((_, j) => j !== i))} style={{ display: 'inline-flex' }}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <ChoiceSelect<AddKind> ariaLabel="Add recipient" placeholder="Add recipient..." value={adding || undefined} options={choices} onChange={pick} />
      {adding === 'USER' && <PersonSelect people={people} value="" onChange={(userId) => userId && add({ kind: 'USER', userId })} />}
      {adding === 'EMAIL' && (
        <div className="flex items-center gap-2">
          <Input aria-label="Email address" type="email" value={email} placeholder="name@company.com" onChange={(e) => setEmail(e.target.value)} />
          <Button type="button" variant="outline" size="sm" disabled={!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)} onClick={() => add({ kind: 'EMAIL', email: email.trim() })}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
