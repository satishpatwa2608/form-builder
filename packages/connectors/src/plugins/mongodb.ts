import { MongoClient, ObjectId, type Document, type Filter } from 'mongodb';
import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity, OperationRequest } from '../types';
import { ConnectionPool } from './pool';
import { assertIdentifier, assertPublicHost, elapsed, fieldsOf, filtersFrom, mongoHosts, now, rowFrom } from './shared';

const pool = new ConnectionPool<MongoClient>((c) => c.close());

async function client(ctx: ConnectorContext): Promise<MongoClient> {
  const uri = ctx.secrets.uri!;
  for (const host of mongoHosts(uri)) await assertPublicHost(ctx, host);
  return pool.get(ConnectionPool.key(ctx.connector.id, uri), async () => {
    const c = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 5 });
    await c.connect();
    return c;
  });
}

const db = async (ctx: ConnectorContext) => (await client(ctx)).db(String(ctx.connector.settings.database));

/** Collection names allow dots and dashes (unlike SQL identifiers); system collections are never reachable. */
function collectionName(name: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(name) || name.startsWith('system.')) throw new ConnectorError('UNSUPPORTED', 'Invalid collection');
  return name;
}

/** `_id` filters/keys given as 24-hex strings become ObjectIds. */
const idValue = (field: string, v: unknown) => (field === '_id' && typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v) ? new ObjectId(v) : v);
const plain = (doc: Document) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) out[k] = v instanceof ObjectId ? v.toHexString() : v;
  return out;
};

export const mongodbPlugin: ConnectorPlugin = {
  type: 'mongodb',
  label: 'MongoDB',
  settingsSchema: z.object({ database: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) }),
  secretsSchema: z.object({ uri: z.string().regex(/^mongodb(\+srv)?:\/\//, 'A mongodb:// or mongodb+srv:// connection string') }),
  operations: ['list', 'get', 'lookup', 'insert', 'update'],

  async test(ctx) {
    const start = now();
    await (await db(ctx)).command({ ping: 1 });
    return { ok: true, message: 'Connected', latencyMs: elapsed(start) };
  },

  async discover(ctx): Promise<Entity[]> {
    const d = await db(ctx);
    const cols = (await d.listCollections({}, { nameOnly: true }).toArray()).filter((c) => !c.name.startsWith('system.')).slice(0, 200);
    const out: Entity[] = [];
    for (const c of cols) {
      const sample = await d.collection(c.name).find({}, { limit: 20 }).toArray();
      out.push({ key: c.name, label: c.name, fields: fieldsOf(sample.map(plain)) });
    }
    return out;
  },

  async run(ctx, req: OperationRequest) {
    const start = now();
    const col = (await db(ctx)).collection(collectionName(req.entity.key));
    // MongoDB returns _id unless told not to: only exposed fields come back.
    const projection = { ...(req.entity.fields.includes('_id') ? {} : { _id: 0 }), ...Object.fromEntries(req.entity.fields.map((f) => [f, 1])) };
    const filter = (): Filter<Document> => Object.fromEntries(filtersFrom(req.entity, req.params).map(([k, v]) => [k, idValue(k, v)]));
    const keyField = req.entity.keyField ?? '_id';
    switch (req.kind) {
      case 'list': {
        const rows = await col.find(filter(), { projection, limit: req.limits.maxRows, maxTimeMS: req.limits.timeoutMs }).toArray();
        return { rows: rows.map(plain), durationMs: elapsed(start) };
      }
      case 'get':
      case 'lookup': {
        const key = req.params[keyField];
        if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
        const doc = await col.findOne({ [assertIdentifier(keyField, [...req.entity.fields, '_id'])]: idValue(keyField, key) } as Filter<Document>, { projection, maxTimeMS: req.limits.timeoutMs });
        return { rows: doc ? [req.kind === 'lookup' ? { exists: true } : plain(doc)] : [], durationMs: elapsed(start) };
      }
      case 'insert': {
        const res = await col.insertOne(rowFrom(req.entity, req.params, 'bytes') as Document);
        return { rows: [{ id: res.insertedId.toString() }], affected: 1, durationMs: elapsed(start) };
      }
      case 'update': {
        const { [keyField]: key, ...rest } = req.params;
        if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
        const res = await col.updateOne({ [assertIdentifier(keyField, [...req.entity.fields, '_id'])]: idValue(keyField, key) } as Filter<Document>, { $set: rowFrom(req.entity, rest, 'bytes') });
        return { rows: [], affected: res.modifiedCount, durationMs: elapsed(start) };
      }
      default:
        throw new ConnectorError('UNSUPPORTED', `MongoDB can't ${req.kind}`);
    }
  },
};

export const closeMongoConnections = () => pool.closeAll();
