import { appendFileSync } from 'node:fs';
import mongoose, { type Schema } from 'mongoose';
import { counter } from './metrics';

/**
 * One guard for the line between organisations. Every collection that holds an organisation's data has an `orgId`
 * field; a read, change or removal there must say which organisation it is for. A query that does not is refused,
 * so a new piece of code that forgets cannot read across that line, whatever the route or job it runs in.
 *
 * Some work rightly spans organisations: the queue's sweeps, a token looked up by its hash before anyone is known,
 * an operator's command. Such a query says so, with its reason, as the query's comment:
 * `{ comment: 'across-orgs: <why>' }` (or `.comment('across-orgs: <why>')`). The comment also reaches the
 * database's own logs, so every such query can be found and read.
 */
export const ACROSS_ORGS = 'across-orgs:';

/**
 * Collections that serve every organisation at once by their nature, each with its reason. Kept short and here, in
 * one place, so that adding one is a decision someone reads.
 */
export const ACROSS_ORGS_COLLECTIONS: Readonly<Record<string, string>> = {
  jobs: 'the queue: each job carries its organisation in what it is asked to do',
  sessions: 'a session is found by its unguessable id or refresh token, before anyone is known',
  sso_states: 'a sign-in in progress is found by its unguessable state, before anyone is known',
  portal_passes: 'a portal pass is found by its unguessable token, before anyone is known',
  form_rate_limits: 'counted per caller, before an organisation is known',
  gateway_calls: 'a call is handed between server processes by its unguessable id',
};

/** How the guard behaves: refuse (tests, and production once all is clean), only report, or nothing. */
export type OrgScopeMode = 'refuse' | 'report' | 'off';
let mode: OrgScopeMode = (['refuse', 'report', 'off'] as const).find((m) => m === process.env.ORG_SCOPE_MODE) ?? (process.env.NODE_ENV === 'test' ? 'refuse' : 'report');
export const setOrgScopeMode = (next: OrgScopeMode) => {
  mode = next;
};

export class OrgScopeError extends Error {
  constructor(collection: string, op: string) {
    super(`A ${op} on ${collection} did not say which organisation it is for. Add orgId to its filter, or mark it { comment: '${ACROSS_ORGS} <why>' }.`);
    this.name = 'OrgScopeError';
  }
}

/** Whether a filter names an organisation: at its top level, or in every branch of an $and. */
function scoped(filter: unknown): boolean {
  if (!filter || typeof filter !== 'object') return false;
  const f = filter as Record<string, unknown>;
  if (f.orgId !== undefined && f.orgId !== null) return true;
  return Array.isArray(f.$and) && f.$and.some(scoped);
}

const marked = (comment: unknown) => typeof comment === 'string' && comment.startsWith(ACROSS_ORGS);

/**
 * Where each query was written: it runs later, away from the code that made it, so its own stack no longer says.
 * Kept on the query so a refusal (or a report) can point at the line to change. A test's own look at what was
 * stored is not the product's code, and is let through.
 */
const model = mongoose.Model as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const op of ['find', 'findOne', 'countDocuments', 'distinct', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'exists', 'findById']) {
  const original = model[op]!;
  model[op] = function (this: unknown, ...args: unknown[]) {
    const query = original.apply(this, args) as { _made?: { stack?: string } };
    // The stack is taken here but only turned into text if the query is found wanting: on every query that cost
    // a sixth of the API's throughput.
    if (mode !== 'off' && query && typeof query === 'object') {
      const made: { stack?: string } = {};
      Error.captureStackTrace(made);
      query._made = made;
    }
    return query;
  };
}

/** Places already reported, so a busy query is reported once, not on every call. */
const reported = new Set<string>();
/** In production the guard reports rather than refuses: a monitor sees it on /metrics. */
const unscoped = counter('fb_unscoped_queries_total', 'Queries on an organisation\'s data that named no organisation (reported, not refused), by collection');

/** The line of our own code a query was made on, from the stack taken when it was made. */
const lineOf = (made: { stack?: string } | undefined) =>
  (made?.stack ?? '').split('\n').find((l) => (l.includes('/src/') || l.includes('/test/')) && !l.includes('org-scope') && !l.includes('node_modules')) ?? '';

function check(collection: string, op: string, filter: unknown, comment: unknown, made?: { stack?: string }) {
  if (mode === 'off' || collection in ACROSS_ORGS_COLLECTIONS || scoped(filter) || marked(comment)) return;
  const madeAt = lineOf(made);
  if (madeAt.includes('/test/')) return;
  const problem = new OrgScopeError(collection, op);
  const where = madeAt.trim().replace(/^at /, '') || '?';
  if (process.env.ORG_SCOPE_REPORT) appendFileSync(process.env.ORG_SCOPE_REPORT, `${collection}\t${op}\t${where}\n`);
  if (mode === 'refuse') throw new OrgScopeError(collection, `${op} (${where})`);
  unscoped.inc({ collection });
  if (!reported.has(where)) {
    reported.add(where);
    console.warn(JSON.stringify({ level: 'warn', msg: problem.message, collection, op, where }));
  }
}

const QUERY_OPS = ['find', 'findOne', 'countDocuments', 'distinct', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace'] as const;

/** Added to every schema; it acts only on those with an `orgId` field. */
export function orgScopePlugin(schema: Schema) {
  if (!schema.path('orgId')) return;
  for (const op of QUERY_OPS) {
    schema.pre(op, function () {
      // `this` is the query.
      const q = this as unknown as { getFilter(): unknown; getOptions(): { comment?: unknown }; model: { collection: { collectionName: string } } };
      check(q.model.collection.collectionName, op, q.getFilter(), q.getOptions().comment, (this as unknown as { _made?: { stack?: string } })._made);
    });
  }
  schema.pre('aggregate', function () {
    const a = this as unknown as { pipeline(): Record<string, unknown>[]; options: { comment?: unknown }; _model?: { collection: { collectionName: string } } };
    const first = a.pipeline()[0];
    check(a._model?.collection.collectionName ?? 'a collection', 'aggregate', first && '$match' in first ? first.$match : undefined, a.options?.comment);
  });
}
