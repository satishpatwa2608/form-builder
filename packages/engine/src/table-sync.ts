import { fieldsFromEntity } from './import-form';
import type { FormDefinition, FormField } from './types';

/**
 * A form that was started from a table (a sheet, a workbook's table, a
 * database table, a Salesforce object) remembers which one. When the table
 * later gains columns, the builder can say so and add the matching fields,
 * so the form and the table do not drift apart unnoticed.
 */
export interface TableChanges {
  /** Fields for the columns the form does not ask for yet, ready to add. */
  added: FormField[];
  /** Their column names, for telling the person. */
  columns: string[];
}

/** What the table has that the form does not, leaving out columns the designer chose to leave out. */
export function tableChanges(def: Pick<FormDefinition, 'fields' | 'startedFrom'>, tableFields: string[]): TableChanges {
  const have = new Set(def.fields.map((f) => f.name));
  const leftOut = new Set(def.startedFrom?.leftOut ?? []);
  const missing = tableFields.filter((name) => !have.has(name) && !leftOut.has(name));
  if (!missing.length) return { added: [], columns: [] };
  const ids = new Set(def.fields.map((f) => f.id));
  const added = fieldsFromEntity({ fields: missing }).fields.map((f) => {
    // An id of its own, whatever the form already holds.
    let id = f.id;
    for (let n = 2; ids.has(id); n++) id = `${f.id}_${n}`;
    ids.add(id);
    return { ...f, id };
  });
  // A column the import itself passes over (a row's own id) is not offered either.
  return { added, columns: added.map((f) => f.name) };
}

/** The form with those fields added at the end. */
export function withTableFields<T extends Pick<FormDefinition, 'fields'>>(def: T, changes: TableChanges): T {
  return changes.added.length ? { ...def, fields: [...def.fields, ...changes.added] } : def;
}
