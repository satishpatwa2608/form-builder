import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@ui/button';
import { Input } from '@ui/input';
import type { FormDefinition, RecordAccess } from '../../types';
import type { Person } from '../../adapters/workflow';
import { SelectSetting, Setting } from '../components/settings';
import { PersonSelect } from './PersonSelect';

interface RecordAccessEditorProps {
  form: FormDefinition;
  /** Everyone who can work records (not narrowed to the team - this is where the team is chosen). */
  people: Person[];
  onChange: (recordAccess: RecordAccess | undefined) => void;
}

function Chips({ items, label, onRemove }: { items: string[]; label: (item: string) => string; onRemove: (item: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
      {items.map((item) => (
        <span key={item} className="fb-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {label(item)}
          <button type="button" aria-label={`Remove ${label(item)}`} onClick={() => onRemove(item)} style={{ display: 'inline-flex' }}>
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * Who sees and works this form's records in the Inbox. Default: everyone
 * with a Form records module. A team narrows it to people and departments;
 * Form admins, the assignee and pending approvers always keep access.
 */
export function RecordAccessEditor({ form, people, onChange }: RecordAccessEditorProps) {
  const access = form.recordAccess;
  const [department, setDepartment] = useState('');
  const knownDepartments = [...new Set(people.map((p) => p.department).filter((d): d is string => !!d))].sort();
  const set = (changes: Partial<RecordAccess>) => onChange({ mode: 'TEAM', userIds: [], departments: [], ...access, ...changes });
  const addDepartment = (d: string) => {
    const value = d.trim();
    if (value && access && !access.departments.includes(value)) set({ departments: [...access.departments, value] });
    setDepartment('');
  };

  return (
    <div className="fb-settings" style={{ gap: 10 }}>
      <div className="fb-panel__title">Who works these records</div>
      <SelectSetting<'ALL' | 'TEAM'>
        label="Records of this form are for"
        value={access ? 'TEAM' : 'ALL'}
        options={[
          { label: 'Everyone with a Form records module', value: 'ALL' },
          { label: 'A team (chosen people and departments)', value: 'TEAM' },
        ]}
        hint="Form admins, the person a record is assigned to, and anyone asked to approve it can always open it."
        onChange={(v) => onChange(v === 'TEAM' ? { mode: 'TEAM', userIds: [], departments: [] } : undefined)}
      />
      {access && (
        <>
          <Setting label="People">
            {() => (
              <div className="fb-settings" style={{ gap: 6 }}>
                <Chips
                  items={access.userIds}
                  label={(id) => people.find((p) => p.uuid === id)?.name ?? 'Unknown user'}
                  onRemove={(id) => set({ userIds: access.userIds.filter((x) => x !== id) })}
                />
                <PersonSelect
                  people={people.filter((p) => !access.userIds.includes(p.uuid))}
                  value=""
                  placeholder="Add a person..."
                  onChange={(id) => id && set({ userIds: [...access.userIds, id] })}
                />
              </div>
            )}
          </Setting>
          <Setting label="Departments" hint="Everyone whose department matches, as set on their user profile.">
            {(id) => (
              <div className="fb-settings" style={{ gap: 6 }}>
                <Chips items={access.departments} label={(d) => d} onRemove={(d) => set({ departments: access.departments.filter((x) => x !== d) })} />
                <div className="flex items-center gap-2">
                  <Input
                    id={id}
                    list="fb-departments"
                    value={department}
                    placeholder="e.g. Quality"
                    onChange={(e) => setDepartment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addDepartment(department);
                      }
                    }}
                  />
                  <datalist id="fb-departments">
                    {knownDepartments.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                  <Button type="button" variant="outline" size="sm" disabled={!department.trim()} onClick={() => addDepartment(department)}>
                    Add
                  </Button>
                </div>
              </div>
            )}
          </Setting>
        </>
      )}
    </div>
  );
}
