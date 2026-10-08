import { SearchWithSelect } from '@ui/search-with-select';
import type { Person } from '../../adapters/workflow';

const personKey = (p: Person) => p.uuid;
const personLabel = (p: Person) => (p.name ? `${p.name} (${p.email})` : p.email || p.uuid);
const personSearch = (p: Person) => [p.name, p.email];

interface PersonSelectProps {
  people: Person[];
  value: string;
  onChange: (uuid: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * One of the users who can work records. A saved id that's no longer in the
 * list (user removed, module taken away) still shows, so it can be fixed.
 */
export function PersonSelect({ people, value, onChange, placeholder, disabled }: PersonSelectProps) {
  const items = value && !people.some((p) => p.uuid === value) ? [...people, { uuid: value, name: 'Unknown user', email: value }] : people;
  return (
    <SearchWithSelect<Person>
      items={items}
      value={value}
      onChange={(key: string) => onChange(key)}
      placeholder={placeholder ?? 'Choose a person...'}
      disabled={disabled}
      getKey={personKey}
      getLabel={personLabel}
      getSearchFields={personSearch}
      emptyText="No one found - people need a Form records module to be assigned"
    />
  );
}
