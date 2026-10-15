import type { Db } from 'mongodb';
import type { SecretBox } from './crypto';

const SEALED = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Every sealed-looking string in a document, with its path ("sms.headers.0.value"). */
function* sealedIn(value: unknown, path: string[] = []): Generator<{ path: string; sealed: string }> {
  if (typeof value === 'string') {
    if (SEALED.test(value) && path.length) yield { path: path.join('.'), sealed: value };
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* sealedIn(v, [...path, String(i)]);
  } else if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) && (value as { _bsontype?: string })._bsontype === undefined) {
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('$')) yield* sealedIn(v, [...path, k]);
  }
}

export interface RotationReport {
  /** Values re-sealed with the current key, by collection. */
  resealed: Record<string, number>;
  /** Values that only a previous key opens and were changed meanwhile by someone else: run it again. */
  skipped: number;
  /** In a check: how many would be re-sealed. */
  checked: boolean;
}

/**
 * Seals again, with the current SECRET_KEY, every value in the database that only a previous key opens: whatever
 * field it is in (two-factor secrets, the organisation's service secrets, sealed answers, wrapped keys). A value
 * the current key opens, or that is not this installation's (sealed by a data key), is left alone. Each is
 * changed only if it is still what was read, so the product can keep running. `check` counts without writing.
 */
export async function rotateSecrets(db: Db, box: SecretBox, check = false): Promise<RotationReport> {
  const report: RotationReport = { resealed: {}, skipped: 0, checked: check };
  for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (name.startsWith('system.')) continue;
    const col = db.collection(name);
    for await (const doc of col.find({})) {
      for (const { path, sealed } of sealedIn(doc)) {
        const fresh = box.reseal(sealed);
        if (!fresh) continue;
        if (check) {
          report.resealed[name] = (report.resealed[name] ?? 0) + 1;
          continue;
        }
        const res = await col.updateOne({ _id: doc._id, [path]: sealed }, { $set: { [path]: fresh } });
        if (res.modifiedCount) report.resealed[name] = (report.resealed[name] ?? 0) + 1;
        else report.skipped++;
      }
    }
  }
  return report;
}
