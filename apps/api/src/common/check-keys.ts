import type { Db } from 'mongodb';
import type { SecretBox } from './crypto';
import { openWith, type KeyProvider } from './key-provider';

const SEALED = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The things sealed with a data key, the wrapped key stored next to them, and what KMS was told when it was wrapped. */
const WRAPPED: { collection: string; filter: Record<string, unknown>; pairs: [sealed: string, key: string][]; context: (d: Record<string, string>) => Record<string, string> }[] = [
  { collection: 'connectors', filter: { isDeleted: { $ne: true } }, pairs: [['sealedSecrets', 'wrappedKey']], context: (d) => ({ orgId: d.orgId, connectorId: d.id }) },
  { collection: 'extensions', filter: {}, pairs: [['sealedSecret', 'wrappedKey']], context: (d) => ({ orgId: d.orgId, extensionId: d.id }) },
  { collection: 'extension_repos', filter: {}, pairs: [['sealed', 'wrappedKey']], context: (d) => ({ orgId: d.orgId, purpose: 'extension-repo' }) },
  { collection: 'org_seals', filter: {}, pairs: [['auto', 'autoKey'], ['own', 'ownKey']], context: (d) => ({ orgId: d.orgId, purpose: 'pdf-seal' }) },
];

export interface KeyCheck {
  /** Values sealed with this installation's SECRET_KEY: how many, and how many it opened. */
  installation: { sealed: number; opened: number };
  /** Values sealed with a data key (connector credentials, PDF certificates, extensions): how many, how many opened. */
  dataKeys: { sealed: number; opened: number };
  /** Where something did not open ("connectors: 2"), never what it holds. */
  failed: Record<string, number>;
}

/** Every sealed-looking string in a document that is not a data-key-sealed field. */
function* sealedIn(value: unknown, skip: Set<string>, path: string[] = []): Generator<string> {
  if (typeof value === 'string') {
    if (SEALED.test(value) && path.length && !skip.has(path.join('.'))) yield value;
  } else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* sealedIn(v, skip, [...path, String(i)]);
  } else if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value) && (value as { _bsontype?: string })._bsontype === undefined) {
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('$')) yield* sealedIn(v, skip, [...path, k]);
  }
}

/**
 * For the restore drill, with the installation's real keys: does each sealed value in the database open? Reads
 * only; nothing opened is kept or printed. A value sealed with a data key opens through the key provider (KMS in
 * production), so this also proves the KMS key still unwraps what was stored.
 */
export async function checkKeys(db: Db, box: SecretBox, keys: KeyProvider): Promise<KeyCheck> {
  const report: KeyCheck = { installation: { sealed: 0, opened: 0 }, dataKeys: { sealed: 0, opened: 0 }, failed: {} };
  const fail = (where: string) => (report.failed[where] = (report.failed[where] ?? 0) + 1);
  const names = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const name of names) {
    if (name.startsWith('system.')) continue;
    const skip = new Set(WRAPPED.find((w) => w.collection === name)?.pairs.flat() ?? []);
    for await (const doc of db.collection(name).find({})) {
      for (const sealed of sealedIn(doc, skip)) {
        report.installation.sealed++;
        try {
          box.open(sealed);
          report.installation.opened++;
        } catch {
          fail(name);
        }
      }
    }
  }
  for (const w of WRAPPED) {
    if (!names.has(w.collection)) continue;
    for await (const doc of db.collection(w.collection).find(w.filter)) {
      for (const [sealedField, keyField] of w.pairs) {
        const sealed = doc[sealedField] as string | undefined;
        const wrapped = doc[keyField] as string | undefined;
        if (!sealed || !wrapped) continue;
        report.dataKeys.sealed++;
        try {
          openWith(await keys.unwrap(wrapped, w.context(doc as unknown as Record<string, string>)), sealed);
          report.dataKeys.opened++;
        } catch {
          fail(`${w.collection}.${sealedField}`);
        }
      }
    }
  }
  return report;
}
