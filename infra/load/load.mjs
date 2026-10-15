// The load test: what the API does under sustained use, on a machine the size of the pilot (infra/load/run.sh starts
// one in containers held to that size and runs this against it). Three things are measured:
//   1. submissions coming in steadily, each starting an automation (an email and a notification): how many a
//      second are accepted, how long each takes, and whether the queue keeps up;
//   2. the inbox and the reports over a large collection of records (seeded straight into the database);
//   3. a backlog of queued work: how fast it drains.
// Usage: node infra/load/load.mjs --api http://127.0.0.1:4300 --mongo mongodb://127.0.0.1:27300/form-builder
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { MongoClient } = require('mongodb');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const API = arg('api', 'http://127.0.0.1:4300');
const MONGO = arg('mongo', 'mongodb://127.0.0.1:27300/form-builder');
const SECONDS = Number(arg('seconds', '60'));
const CLIENTS = Number(arg('clients', '20'));
const RECORDS = Number(arg('records', '100000'));
const BACKLOG = Number(arg('backlog', '2000'));
const OUT = arg('out', '');

const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : 0);
const ms = (n) => `${Math.round(n)} ms`;
let ipSeq = 0;
/** Each request as if from a different visitor (the limit is per visitor and form). */
const visitor = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

async function call(path, { method = 'GET', body, token, ip } = {}) {
  const started = performance.now();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-forwarded-for': ip ?? visitor() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - started, body: text ? JSON.parse(text) : undefined };
}

const form = {
  name: 'Maintenance complaint',
  code: 'LOAD',
  businessId: '',
  access: 'PUBLIC',
  submission: { method: 'POST', endpointId: 'default-submit' },
  fields: [
    { id: 'n', type: 'TEXT', name: 'name', label: 'Your name', required: true },
    { id: 'e', type: 'EMAIL', name: 'email', label: 'Email', required: true },
    { id: 'p', type: 'DROPDOWN', name: 'property', label: 'Property', required: true, dataSource: { type: 'STATIC', options: ['A', 'B', 'C', 'D'].map((v) => ({ label: `Tower ${v}`, value: v })) } },
    { id: 'k', type: 'RADIO', name: 'kind', label: 'Kind', required: true, dataSource: { type: 'STATIC', options: ['LEAK', 'NOISE', 'LIFT'].map((v) => ({ label: v, value: v })) } },
    { id: 'd', type: 'TEXTAREA', name: 'details', label: 'Details' },
  ],
  workflow: {
    enabled: true,
    refPrefix: 'LD',
    statuses: [{ key: 'NEW', label: 'New', category: 'OPEN', slaHours: 24 }, { key: 'DONE', label: 'Fixed', category: 'DONE' }],
    assignment: { type: 'NONE' },
    priority: { default: 'MEDIUM', rules: [{ if: { field: 'kind', operator: 'equals', value: 'LEAK' }, priority: 'HIGH' }] },
  },
  automations: [
    {
      id: 'ack',
      name: 'Acknowledge',
      enabled: true,
      when: 'SUBMITTED',
      actions: [
        { id: 'mail', type: 'EMAIL', to: [{ kind: 'FIELD', field: 'email' }], subject: 'We have {{$record.ref}}', body: 'Thanks {{name}}' },
        { id: 'tell', type: 'NOTIFY', to: [{ kind: 'SUBMITTER' }], message: 'New {{$record.ref}}' },
      ],
    },
  ],
};

const db = (await MongoClient.connect(MONGO)).db();
const results = { when: new Date().toISOString(), settings: { seconds: SECONDS, clients: CLIENTS, records: RECORDS, backlog: BACKLOG } };

// --- an organisation, its owner and the form ---------------------------------------------------------------
const email = `load-${Date.now()}@load.test`;
const password = 'correct horse battery';
const signed = await call('/auth/signup', { method: 'POST', body: { name: 'Load Owner', email, password, orgName: 'Load Co' } });
if (signed.status !== 202) throw new Error(`sign-up answered ${signed.status}`);
await db.collection('users').updateOne({ email }, { $set: { emailVerifiedAt: new Date() } });
const login = await call('/auth/login', { method: 'POST', body: { email, password } });
const token = login.body.accessToken;
const me = (await call('/auth/me', { token })).body;
const orgId = me.org.id;
await db.collection('organizations').updateOne({ id: orgId }, { $set: { plan: 'ENTERPRISE' } });
const folder = (await call('/folders', { method: 'POST', token, body: { name: 'Load' } })).body[0].id;
const created = await call('/forms', { method: 'POST', token, body: { folderId: folder, definition: form } });
if (created.status !== 201) throw new Error(`form: ${created.status} ${JSON.stringify(created.body)}`);
const published = await call(`/forms/${created.body.definition.id}/publish`, { method: 'POST', token });
if (published.status !== 200) throw new Error(`publish: ${published.status} ${JSON.stringify(published.body)}`);
console.log(`organisation ${orgId}, form LOAD published`);

// --- 1. submissions --------------------------------------------------------------------------------------------
if (SECONDS > 0) {
  const times = [];
  const statuses = {};
  const until = Date.now() + SECONDS * 1000;
  let n = 0;
  await Promise.all(
    Array.from({ length: CLIENTS }, async () => {
      while (Date.now() < until) {
        const i = n++;
        const r = await call(`/public/forms/LOAD/submissions?org=${orgId}`, {
          method: 'POST',
          body: { values: { name: `Resident ${i}`, email: `r${i}@load.test`, property: 'ABCD'[i % 4], kind: ['LEAK', 'NOISE', 'LIFT'][i % 3], details: 'x'.repeat(200) }, idempotencyKey: randomUUID() },
        });
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        if (r.status === 201) times.push(r.ms);
      }
    }),
  );
  const accepted = times.length;
  // How long the queue takes to finish what the submissions started.
  const drainStart = Date.now();
  let left = 0;
  for (;;) {
    left = await db.collection('jobs').countDocuments({ orgId, status: { $in: ['PENDING', 'RUNNING'] } });
    if (!left || Date.now() - drainStart > 300_000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  results.submissions = {
    clients: CLIENTS,
    seconds: SECONDS,
    accepted,
    perSecond: Math.round((accepted / SECONDS) * 10) / 10,
    statuses,
    p50: Math.round(pct(times, 50)),
    p95: Math.round(pct(times, 95)),
    p99: Math.round(pct(times, 99)),
    queueDrainedSeconds: left ? null : Math.round((Date.now() - drainStart) / 100) / 10,
    jobsFailed: await db.collection('jobs').countDocuments({ orgId, status: 'FAILED' }),
  };
  console.log('submissions', JSON.stringify(results.submissions));
}

// --- 2. the inbox and reports over many records ----------------------------------------------------------------
{
  const def = await db.collection('forms').findOne({ orgId, code: 'LOAD', status: 'PUBLISHED' });
  const now = Date.now();
  const batch = 5000;
  for (let made = 0; made < RECORDS; made += batch) {
    const rows = Array.from({ length: Math.min(batch, RECORDS - made) }, (_, j) => {
      const i = made + j;
      const createdAt = new Date(now - (i % 90) * 86_400_000 - (i % 1440) * 60_000);
      const done = i % 3 === 0;
      return {
        uuid: randomUUID(),
        orgId,
        formId: def.id,
        formCode: 'LOAD',
        formVersion: def.version,
        payload: { name: `Seeded ${i}`, email: `s${i}@load.test`, property: 'ABCD'[i % 4], kind: ['LEAK', 'NOISE', 'LIFT'][i % 3], details: 'seeded' },
        status: done ? 'DONE' : 'NEW',
        ref: `LD-S${String(i).padStart(7, '0')}`,
        priority: ['LOW', 'MEDIUM', 'HIGH'][i % 3],
        assigneeId: '',
        source: 'PUBLIC_FORM',
        channel: 'WEB',
        files: [],
        work: {},
        isDeleted: false,
        dueAt: new Date(createdAt.getTime() + 86_400_000),
        resolvedAt: done ? new Date(createdAt.getTime() + ((i % 72) + 1) * 3_600_000) : null,
        statusChangedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      };
    });
    await db.collection('form_submissions').insertMany(rows, { ordered: false });
  }
  const time = async (label, path, times = 5) => {
    const took = [];
    let status = 0;
    for (let i = 0; i < times; i++) {
      const r = await call(path, { token, ip: '10.200.0.1' });
      status = r.status;
      took.push(r.ms);
    }
    return { label, status, p50: Math.round(pct(took, 50)), worst: Math.round(Math.max(...took)) };
  };
  results.inbox = {
    records: RECORDS + (results.submissions?.accepted ?? 0),
    pages: [
      await time('inbox, newest first', '/records?formCode=LOAD'),
      await time('inbox, open and overdue', '/records?formCode=LOAD&open=true&overdue=true'),
      await time('inbox, by priority', '/records?formCode=LOAD&sort=priority'),
      await time('inbox, search by reference', '/records?formCode=LOAD&q=LD-S00123'),
      await time('inbox, search in answers', '/records?formCode=LOAD&q=Seeded%2099'),
      await time('dashboard, 30 days', '/work-dashboard?formCode=LOAD&days=30', 3),
      await time('report by property, 90 days', '/work-reports?formCode=LOAD&days=90&by=field:property', 3),
    ],
  };
  console.log('inbox', JSON.stringify(results.inbox));
}

// --- 3. a backlog of queued work -------------------------------------------------------------------------------
{
  const recent = await db.collection('form_submissions').find({ orgId, ref: /^LD-0/ }).limit(BACKLOG).project({ uuid: 1 }).toArray();
  const ids = recent.length ? recent : await db.collection('form_submissions').find({ orgId }).limit(BACKLOG).project({ uuid: 1 }).toArray();
  const jobs = ids.map((r) => ({ uuid: randomUUID(), type: 'document.record', orgId, payload: { orgId, submissionId: r.uuid }, status: 'PENDING', attempts: 0, maxAttempts: 5, runAt: new Date(), createdAt: new Date(), updatedAt: new Date() }));
  if (jobs.length) await db.collection('jobs').insertMany(jobs);
  const started = Date.now();
  let left = jobs.length;
  while (left && Date.now() - started < 600_000) {
    await new Promise((r) => setTimeout(r, 2000));
    left = await db.collection('jobs').countDocuments({ uuid: { $in: jobs.map((j) => j.uuid) }, status: { $in: ['PENDING', 'RUNNING'] } });
  }
  const secs = (Date.now() - started) / 1000;
  results.backlog = { kind: 'make and keep a PDF of a response', jobs: jobs.length, drainedSeconds: left ? null : Math.round(secs), perSecond: left ? null : Math.round((jobs.length / secs) * 10) / 10, left };
  console.log('backlog', JSON.stringify(results.backlog));
}

if (OUT) writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(ms(0) && 'done');
process.exit(0);
