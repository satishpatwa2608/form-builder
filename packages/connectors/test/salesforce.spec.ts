import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSoql, defaultRegistry, soqlLiteral, type ConnectorRecord } from '../src';

const limits = { timeoutMs: 5000, maxRows: 100 };
const reg = defaultRegistry();
const signal = () => new AbortController().signal;

describe('SOQL statements', () => {
  const entity = { key: 'Lead', fields: ['Id', 'LastName', 'Email', 'Score__c'] };

  it('select only exposed fields, with exact-match conditions and a limit', () => {
    expect(buildSoql(entity, [['Email', 'a@b.test'], ['Score__c', 5]], 100)).toBe("SELECT Id, LastName, Email, Score__c FROM Lead WHERE Email = 'a@b.test' AND Score__c = 5 LIMIT 100");
    expect(buildSoql(entity, [], 99_999)).toBe('SELECT Id, LastName, Email, Score__c FROM Lead LIMIT 2000');
  });

  it('write values so that nothing typed can end them', () => {
    expect(soqlLiteral("O'Brien")).toBe("'O\\'Brien'");
    expect(soqlLiteral("x' OR Name != '")).toBe("'x\\' OR Name != \\''");
    // A backslash before a quote must not un-escape it.
    expect(soqlLiteral("\\' OR 1=1 --")).toBe("'\\\\\\' OR 1=1 --'");
    expect(soqlLiteral('line\nbreak')).toBe("'line\\nbreak'");
    expect(soqlLiteral(true)).toBe('true');
    expect(soqlLiteral(null)).toBe('null');
    expect(() => soqlLiteral(NaN)).toThrow();
  });

  it('refuse names that are not exposed or not plain names', () => {
    expect(() => buildSoql(entity, [['Phone', 'x']], 10)).toThrow('not exposed');
    expect(() => buildSoql({ key: 'Lead', fields: ['Id', 'Owner.Name'] }, [], 10)).toThrow();
    expect(() => buildSoql({ key: 'Lead; DELETE', fields: ['Id'] }, [], 10)).toThrow();
    expect(() => buildSoql({ key: 'Lead', fields: [] }, [], 10)).toThrow();
  });
});

describe('Salesforce connector (against a stand-in)', () => {
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; auth?: string; body?: string }[] = [];
  const state = { tokens: 0 };
  const ID = '00Q5g00000AbCdEFGH';

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = decodeURIComponent(req.url!.replace(/\+/g, ' '));
        seen.push({ method: req.method!, url, auth: req.headers.authorization, body });
        const json = (status: number, data?: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(data === undefined ? '' : JSON.stringify(data));
        if (url === '/services/oauth2/token') {
          state.tokens++;
          const p = new URLSearchParams(body);
          return p.get('grant_type') === 'client_credentials' && p.get('client_id') === 'key-1' && p.get('client_secret') === 's3cret' ? json(200, { access_token: 'sf-token', instance_url: base }) : json(400, { error: 'invalid_client', error_description: 'internal detail' });
        }
        if (req.headers.authorization !== 'Bearer sf-token') return json(401, [{ errorCode: 'INVALID_SESSION_ID' }]);
        const data = '/services/data/v60.0';
        if (url === `${data}/limits`) return json(200, { DailyApiRequests: { Max: 15000, Remaining: 14000 } });
        if (url === `${data}/sobjects`) {
          return json(200, {
            sobjects: [
              { name: 'Lead', label: 'Lead', custom: false, queryable: true },
              { name: 'Enquiry__c', label: 'Enquiry', custom: true, queryable: true },
              { name: 'ApexClass', label: 'Apex Class', custom: false, queryable: true },
              { name: 'Hidden__c', label: 'Hidden', custom: true, queryable: false },
            ],
          });
        }
        if (url === `${data}/sobjects/Lead/describe`) return json(200, { fields: [{ name: 'Id', type: 'id' }, { name: 'LastName', type: 'string' }, { name: 'Email', type: 'email', nillable: true }, { name: 'AnnualRevenue', type: 'currency', nillable: true }, { name: 'IsConverted', type: 'boolean' }, { name: 'Company', type: 'string', nillable: false, createable: true, length: 255 }, { name: 'Status', type: 'picklist', nillable: false, createable: true, defaultedOnCreate: true, length: 40 }, { name: 'NumberOfEmployees', type: 'int', nillable: true, digits: 8 }, { name: 'Score__c', type: 'double', nillable: true, precision: 5, scale: 2 }] });
        if (url === `${data}/sobjects/Enquiry__c/describe`) return json(200, { fields: [{ name: 'Id', type: 'id' }, { name: 'About__c', type: 'textarea', nillable: true }] });
        if (req.method === 'GET' && url.startsWith(`${data}/query?q=`)) {
          const q = url.slice(`${data}/query?q=`.length);
          if (q.includes("Email = 'nobody@x.test'")) return json(200, { records: [] });
          return json(200, { totalSize: 1, records: [{ attributes: { type: 'Lead', url: '/x' }, Id: ID, LastName: "O'Brien", Email: 'ob@x.test', Secret__c: 'not asked for' }] });
        }
        if (req.method === 'POST' && url === `${data}/sobjects/Lead`) return json(201, { id: ID, success: true, errors: [] });
        if (req.method === 'PATCH' && (url === `${data}/sobjects/Lead/${ID}` || url === `${data}/sobjects/Lead/Email/ob@x.test`)) return json(204);
        json(500, [{ message: 'internal detail', errorCode: 'UNKNOWN' }]);
      });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const record = (over: Partial<ConnectorRecord> = {}): ConnectorRecord => ({ id: 'c-sf', orgId: 'o1', type: 'salesforce', name: 'CRM', settings: { instanceUrl: base, clientId: 'key-1' }, secretRef: 'x', writable: true, ...over });
  const ctx = (secret = 's3cret', over: Partial<ConnectorRecord> = {}) => ({ connector: record(over), secrets: { clientSecret: secret }, allowPrivateNetwork: true });
  const entity = { key: 'Lead', fields: ['Id', 'LastName', 'Email'], keyField: 'Id' };

  it('signs in as an application, once, and finds the usual objects and the organisation\'s own with their fields', async () => {
    expect(await reg.get('salesforce').test({ ...ctx(), signal: signal() })).toMatchObject({ ok: true, message: 'Connected to Salesforce' });
    const found = await reg.get('salesforce').discover({ ...ctx(), signal: signal() });
    // System objects and ones that cannot be read are left out.
    expect(found.map((e) => e.key)).toEqual(['Lead', 'Enquiry__c']);
    expect(found[0]).toMatchObject({ label: 'Lead', keyField: 'Id' });
    expect(found[0]!.fields).toEqual([
      { name: 'Id', type: 'string' },
      { name: 'LastName', type: 'string' },
      { name: 'Email', type: 'string', nullable: true },
      { name: 'AnnualRevenue', type: 'number', nullable: true },
      { name: 'IsConverted', type: 'boolean' },
      // What Salesforce insists on comes along: must be given, how long, and the room a number has.
      { name: 'Company', type: 'string', nullable: false, maxLength: 255 },
      { name: 'Status', type: 'string', nullable: false, hasDefault: true, maxLength: 40 },
      { name: 'NumberOfEmployees', type: 'number', nullable: true, min: -99999999, max: 99999999 },
      { name: 'Score__c', type: 'number', nullable: true, min: -999.99, max: 999.99 },
    ]);
    expect(state.tokens).toBe(1);
  });

  it('a wrong secret is said in plain words, without the secret or Salesforce\'s own text', async () => {
    const err = await reg.get('salesforce').test({ ...ctx('wrong', { id: 'c-other' }), signal: signal() }).catch((e: Error) => e);
    expect((err as Error).message).toContain('Salesforce refused the sign-in');
    expect((err as Error).message).not.toMatch(/wrong|internal detail/);
  });

  it('reads with an exact-match query that cannot be broken out of, and passes on only exposed fields', async () => {
    const res = await reg.run(ctx(), { entity, kind: 'list', params: { LastName: "x' OR Name != '" }, limits });
    expect(res.rows).toEqual([{ Id: ID, LastName: "O'Brien", Email: 'ob@x.test' }]);
    expect(seen.at(-1)).toMatchObject({ method: 'GET', auth: 'Bearer sf-token' });
    expect(seen.at(-1)!.url).toBe("/services/data/v60.0/query?q=SELECT Id, LastName, Email FROM Lead WHERE LastName = 'x\\' OR Name != \\'' LIMIT 100");
    await expect(reg.run(ctx(), { entity, kind: 'list', params: { Secret__c: 'x' }, limits })).rejects.toThrow('not exposed');
  });

  it('fetches and looks up one record, and says "not there" rather than failing', async () => {
    expect((await reg.run(ctx(), { entity, kind: 'get', params: { Id: ID }, limits })).rows).toEqual([{ Id: ID, LastName: "O'Brien", Email: 'ob@x.test' }]);
    expect((await reg.run(ctx(), { entity: { ...entity, keyField: 'Email' }, kind: 'lookup', params: { Email: 'ob@x.test' }, limits })).rows).toEqual([{ exists: true }]);
    expect((await reg.run(ctx(), { entity: { ...entity, keyField: 'Email' }, kind: 'lookup', params: { Email: 'nobody@x.test' }, limits })).rows).toEqual([]);
  });

  it('creates a record with only exposed fields and gives back its ID; updates by ID or by an external ID field', async () => {
    const made = await reg.run(ctx(), { entity, kind: 'insert', params: { LastName: 'Rao', Email: 'rao@x.test', OwnerId: '005xx', IsConverted: true }, limits });
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: '/services/data/v60.0/sobjects/Lead' });
    expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ LastName: 'Rao', Email: 'rao@x.test' });
    expect(made).toMatchObject({ rows: [{ Id: ID }], affected: 1 });

    await reg.run(ctx(), { entity, kind: 'update', params: { Id: ID, LastName: 'Renamed' }, limits });
    expect(seen.at(-1)).toMatchObject({ method: 'PATCH', url: `/services/data/v60.0/sobjects/Lead/${ID}` });
    expect(JSON.parse(seen.at(-1)!.body!)).toEqual({ LastName: 'Renamed' });
    await reg.run(ctx(), { entity: { ...entity, keyField: 'Email' }, kind: 'update', params: { Email: 'ob@x.test', LastName: 'By email' }, limits });
    expect(seen.at(-1)!.url).toBe('/services/data/v60.0/sobjects/Lead/Email/ob@x.test');
    // Something that is not a record ID never becomes part of the address.
    await expect(reg.run(ctx(), { entity, kind: 'update', params: { Id: '../Account/001', LastName: 'x' }, limits })).rejects.toThrow('not a Salesforce record ID');
    await expect(reg.run(ctx('s3cret', { writable: false }), { entity, kind: 'insert', params: { LastName: 'No' }, limits })).rejects.toThrow();
  });

  it('a failure is reported by its status, never by what Salesforce said', async () => {
    const err = await reg.run(ctx(), { entity: { ...entity, key: 'Case' }, kind: 'insert', params: { LastName: 'x' }, limits }).catch((e: Error) => e);
    expect((err as Error).message).toBe('Salesforce answered 500');
  });

  it('outside development only Salesforce\'s own addresses are accepted, since the secret is sent there', async () => {
    const strict = (instanceUrl: string) => reg.run({ connector: record({ settings: { instanceUrl, clientId: 'key-1' } }), secrets: { clientSecret: 's3cret' } }, { entity, kind: 'list', params: {}, limits });
    for (const url of ['https://evil.example', 'https://salesforce.com.evil.example', 'https://evilsalesforce.com', `${base}`]) await expect(strict(url)).rejects.toThrow('Use your Salesforce address');
  });
});
