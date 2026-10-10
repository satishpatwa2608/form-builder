import type { FormDefinition } from '@fb/engine';
import type { Schema } from 'mongoose';
import type { SecretBox } from '../common/crypto';

/**
 * Answers to questions marked "Sensitive" are kept encrypted in the database (AES-256-GCM, a fresh IV each), so
 * a copy of the database, a backup or someone reading the collection does not give them away. The rest of the
 * product sees them as they were given: they are sealed as a response is saved and opened as it is read, here,
 * in one place, so no reader of responses can forget to.
 *
 * What this does not do: it does not hide an answer from staff who may open the record, and a sealed answer
 * cannot be searched or filtered on (the database only holds its ciphertext).
 */
const MARK = '__sealed';
let box: SecretBox | undefined;

/** Set once as the app starts. Without it nothing is sealed (and a sealed value is left as it is). */
export function useSealingKey(key: SecretBox) {
  box = key;
}

type Answers = Record<string, unknown> | null | undefined;
const isSealed = (v: unknown): v is { [MARK]: string } => !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)[MARK] === 'string';

/** The answers with the named ones sealed. An empty answer stays empty: there is nothing in it to protect. */
export function sealAnswers(payload: Answers, names: readonly string[]): Answers {
  if (!box || !payload || !names.length) return payload;
  const out: Record<string, unknown> = { ...payload };
  for (const name of names) {
    const value = out[name];
    if (value === undefined || value === null || value === '' || isSealed(value)) continue;
    out[name] = { [MARK]: box.seal(JSON.stringify(value)) };
  }
  return out;
}

/** The answers as they were given. One that cannot be opened (a different key) reads as empty, never as ciphertext. */
export function openAnswers(payload: Answers): Answers {
  if (!payload || !Object.values(payload).some(isSealed)) return payload;
  const out: Record<string, unknown> = { ...payload };
  for (const [name, value] of Object.entries(out)) {
    if (!isSealed(value)) continue;
    try {
      out[name] = box ? JSON.parse(box.open(value[MARK])) : '';
    } catch {
      out[name] = '';
    }
  }
  return out;
}

/**
 * Which stored answers of a response are sealed: those of questions marked Sensitive, by the key they are
 * stored under. A repeating section with a sensitive question in its rows is sealed whole.
 */
export function sealedKeys(def: Pick<FormDefinition, 'fields' | 'submission'>, payload: Record<string, unknown>): string[] {
  const byId = new Map(def.fields.map((f) => [f.id, f]));
  const top = (f: FormDefinition['fields'][number]) => {
    let at = f;
    // Up to the question's outermost holder that is itself an answer (a repeating section), if any.
    for (let p = f.parentId ? byId.get(f.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) if (p.type === 'REPEAT') at = p;
    return at;
  };
  const names = new Set(def.fields.filter((f) => f.sensitive).map((f) => top(f).name));
  return [...names].map((name) => def.submission.mapping?.[name] ?? name).filter((key) => key in payload);
}

type Row = { payload?: Answers; sealedFields?: string[] } | null | undefined;
const openRow = (row: Row) => {
  if (row && row.payload) row.payload = openAnswers(row.payload);
};
const openAll = (found: unknown) => {
  if (Array.isArray(found)) found.forEach((r) => openRow(r as Row));
  else openRow(found as Row);
};

/** Seals on the way in and opens on the way out, for every way this product reads or writes a response. */
export function sealedAnswersPlugin(schema: Schema) {
  schema.pre('save', function () {
    const doc = this as unknown as { payload?: Answers; sealedFields?: string[]; markModified: (path: string) => void };
    const sealed = sealAnswers(doc.payload, doc.sealedFields ?? []);
    if (sealed !== doc.payload) {
      doc.payload = sealed;
      doc.markModified('payload');
    }
  });
  // The caller goes on using what it saved: give it back as it was given.
  schema.post('save', function () {
    openRow(this as unknown as Row);
  });
  schema.post(['find', 'findOne', 'findOneAndUpdate'], function (found: unknown) {
    openAll(found);
  });
  schema.post('aggregate', function (found: unknown) {
    openAll(found);
  });
}
