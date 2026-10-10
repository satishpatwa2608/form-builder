import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { ConnectorError } from '../registry';
import type { ConnectorContext, ConnectorPlugin, Entity, EntityField } from '../types';
import { elapsed, filtersFrom, isFileValue, now, safeFetch, type Primitive } from './shared';

/**
 * SOAP web services, described by a WSDL. Each operation the service offers is something a form can call: to
 * look something up (its inputs are the filters, its answer the rows) or to send something (its inputs are the
 * values). The usual modern style is spoken (document/literal, SOAP 1.1 and 1.2); the old "rpc/encoded" style is
 * reported as not supported instead of being guessed at.
 */

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v);
const list = <T = Node>(v: unknown): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? (v as T[]) : [v as T]);
/** `tns:Customer` -> `Customer`. */
const local = (name: unknown) => String(name ?? '').split(':').pop()!;
/** Children of a node by their name without its prefix, whatever prefix the document's author chose. */
const kids = (node: unknown, name: string): Node[] => (isNode(node) ? Object.entries(node).filter(([k]) => !k.startsWith('@') && local(k) === name).flatMap(([, v]) => list<Node>(v).filter(isNode)) : []);
/**
 * The five characters XML writes specially, and characters given by number, turned back into themselves. Done by
 * hand, with the parser's own handling off: a document may define entities of its own, and those are never expanded.
 */
const unescape = (text: string) =>
  text.replace(/&(?:(lt|gt|amp|quot|apos)|#(\d{1,7})|#x([0-9a-fA-F]{1,6}));/g, (whole, named: string | undefined, decimal: string | undefined, hex: string | undefined) => {
    if (named) return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[named]!;
    const code = decimal ? Number(decimal) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
  });
const attr = (node: unknown, name: string): string | undefined => (isNode(node) && typeof node[`@${name}`] === 'string' ? unescape(node[`@${name}`] as string) : undefined);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const OPERATION = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/;

const SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const XSD_TYPES: Record<string, EntityField['type']> = {
  string: 'string', normalizedString: 'string', token: 'string', anyURI: 'string', ID: 'string', base64Binary: 'string',
  int: 'number', integer: 'number', long: 'number', short: 'number', byte: 'number', decimal: 'number', float: 'number', double: 'number', nonNegativeInteger: 'number', positiveInteger: 'number', unsignedInt: 'number', unsignedLong: 'number',
  boolean: 'boolean',
  date: 'date', dateTime: 'date',
};

export interface SoapOperation {
  name: string;
  /** Where it is called, and how the call names itself. */
  endpoint: string;
  action: string;
  version: '1.1' | '1.2';
  /** The element the request is, in which namespace, and whether its children carry that namespace too. */
  request: { element: string; namespace: string; qualified: boolean; fields: EntityField[] };
  /** What the answer's rows hold, as far as the description says. */
  returns: EntityField[];
}

const parser = () => new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', processEntities: false, parseTagValue: false, trimValues: true });

/** Reads a service's description (and the schemas it was given along with it) into the operations it offers. */
export function parseWsdl(wsdl: string, more: string[] = []): SoapOperation[] {
  const docs = [wsdl, ...more].map((x) => parser().parse(x) as Node);
  const definitions = docs.flatMap((d) => kids(d, 'definitions'));
  const root = definitions[0];
  if (!root) throw new ConnectorError('UNSUPPORTED', 'That address did not give a WSDL (the description of a SOAP service).');
  // Every schema: inside the description's own <types>, or a file of its own.
  const schemas = [...definitions.flatMap((d) => kids(d, 'types').flatMap((t) => kids(t, 'schema'))), ...docs.flatMap((d) => kids(d, 'schema'))];
  const elements = new Map<string, { node: Node; schema: Node }>();
  const types = new Map<string, Node>();
  for (const schema of schemas) {
    for (const e of kids(schema, 'element')) if (attr(e, 'name')) elements.set(attr(e, 'name')!, { node: e, schema });
    for (const t of kids(schema, 'complexType')) if (attr(t, 'name')) types.set(attr(t, 'name')!, t);
  }
  /** The parts of an element: those of its own complex type, or of the named type it refers to. */
  const parts = (element: Node | undefined): Node[] => {
    if (!element) return [];
    const type = kids(element, 'complexType')[0] ?? types.get(local(attr(element, 'type')));
    const sequence = type ? [...kids(type, 'sequence'), ...kids(type, 'all')] : [];
    // A type that extends another has its parts one level further in.
    const extended = type ? kids(type, 'complexContent').flatMap((c) => kids(c, 'extension')).flatMap((x) => [...kids(types.get(local(attr(x, 'base'))), 'sequence'), ...kids(x, 'sequence')]) : [];
    return [...sequence, ...extended].flatMap((s) => kids(s, 'element'));
  };
  const simple = (part: Node) => !kids(part, 'complexType').length && !types.has(local(attr(part, 'type')));
  const fieldsOf = (element: Node | undefined): EntityField[] =>
    parts(element)
      .filter((p) => simple(p) && IDENT.test(attr(p, 'name') ?? ''))
      .map((p) => ({ name: attr(p, 'name')!, type: XSD_TYPES[local(attr(p, 'type'))] ?? ('string' as const), ...(attr(p, 'minOccurs') === '0' || attr(p, 'nillable') === 'true' ? { nullable: true } : { nullable: false }) }));
  /** The fields of the rows an answer carries: down through the wrappers (a result holding a list holding the rows). */
  const rowFields = (element: Node | undefined, depth = 0): EntityField[] => {
    const own = fieldsOf(element);
    const inner = parts(element).filter((p) => !simple(p));
    if (inner.length !== 1 || depth > 4) return own;
    const deeper = rowFields(inner[0], depth + 1);
    return deeper.length ? deeper : own;
  };

  const prefixes = Object.fromEntries(Object.entries(root).filter(([k, v]) => k.startsWith('@xmlns:') && typeof v === 'string').map(([k, v]) => [k.slice(7), v as string]));
  const messages = new Map(definitions.flatMap((d) => kids(d, 'message')).map((m) => [attr(m, 'name') ?? '', m]));
  const portTypes = new Map(definitions.flatMap((d) => kids(d, 'portType')).map((p) => [attr(p, 'name') ?? '', p]));
  const bindings = new Map(definitions.flatMap((d) => kids(d, 'binding')).map((b) => [attr(b, 'name') ?? '', b]));
  const out: SoapOperation[] = [];
  const seen = new Set<string>();
  // Each way in to the service: prefer SOAP 1.1, which every service that offers both speaks.
  const ports = definitions.flatMap((d) => kids(d, 'service').flatMap((s) => kids(s, 'port')));
  const versionOf = (port: Node): '1.1' | '1.2' | undefined => {
    const key = Object.keys(port).find((k) => !k.startsWith('@') && local(k) === 'address');
    const uri = key?.includes(':') ? prefixes[key.split(':')[0]!] : undefined;
    return uri === SOAP12 ? '1.2' : uri === SOAP11 || (key && !uri) ? '1.1' : undefined;
  };
  for (const port of [...ports].sort((a, b) => Number(versionOf(a) === '1.2') - Number(versionOf(b) === '1.2'))) {
    const version = versionOf(port);
    const endpoint = attr(kids(port, 'address')[0], 'location');
    const binding = bindings.get(local(attr(port, 'binding')));
    if (!version || !endpoint || !binding) continue;
    const style = attr(kids(binding, 'binding')[0], 'style') ?? 'document';
    const portType = portTypes.get(local(attr(binding, 'type')));
    for (const bound of kids(binding, 'operation')) {
      const name = attr(bound, 'name') ?? '';
      if (!OPERATION.test(name) || seen.has(name)) continue;
      const described = kids(portType, 'operation').find((o) => attr(o, 'name') === name);
      const use = attr(kids(kids(bound, 'input')[0], 'body')[0], 'use') ?? 'literal';
      if ((attr(kids(bound, 'operation')[0], 'style') ?? style) !== 'document' || use !== 'literal') continue;
      const part = (direction: 'input' | 'output') => kids(messages.get(local(attr(kids(described, direction)[0], 'message'))), 'part')[0];
      const request = elements.get(local(attr(part('input'), 'element')));
      if (!request) continue;
      seen.add(name);
      out.push({
        name,
        endpoint,
        action: attr(kids(bound, 'operation')[0], 'soapAction') ?? '',
        version,
        request: { element: attr(request.node, 'name')!, namespace: attr(request.schema, 'targetNamespace') ?? attr(root, 'targetNamespace') ?? '', qualified: attr(request.schema, 'elementFormDefault') === 'qualified', fields: fieldsOf(request.node) },
        returns: rowFields(elements.get(local(attr(part('output'), 'element')))?.node),
      });
    }
  }
  if (!out.length) {
    const old = definitions.flatMap((d) => kids(d, 'binding')).some((b) => attr(kids(b, 'binding')[0], 'style') === 'rpc' || JSON.stringify(b).includes('"@use":"encoded"'));
    throw new ConnectorError('UNSUPPORTED', old ? 'This service speaks the old "rpc/encoded" style of SOAP, which is not supported. Ask for its document/literal endpoint.' : 'No operations could be read from that WSDL.');
  }
  return out;
}

/** The addresses of the schema and description files a WSDL says it is completed by. */
export function wsdlImports(wsdl: string, from: string): string[] {
  const found = [...wsdl.matchAll(/<(?:[\w.-]+:)?(?:import|include)\b[^>]*?(?:schemaLocation|location)\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
  return [...new Set(found.flatMap((href) => {
    try {
      return [new URL(href.replace(/&amp;/g, '&'), from).toString()];
    } catch {
      return [];
    }
  }))];
}

const escape = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The message for one call: the operation's inputs in the order its description gives them, each escaped. */
export function soapEnvelope(op: SoapOperation, values: Record<string, unknown>, wsse?: { username: string; password: string }): string {
  const envelope = op.version === '1.2' ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
  const tag = (name: string) => (op.request.qualified ? `m:${name}` : name);
  const body = op.request.fields
    .filter((f) => values[f.name] !== undefined && values[f.name] !== null && values[f.name] !== '')
    .map((f) => `<${tag(f.name)}>${escape(isFileValue(values[f.name]) ? (values[f.name] as { $file: string }).$file : values[f.name])}</${tag(f.name)}>`)
    .join('');
  const header = wsse
    ? `<s:Header><o:Security xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" s:mustUnderstand="1"><o:UsernameToken><o:Username>${escape(wsse.username)}</o:Username><o:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escape(wsse.password)}</o:Password></o:UsernameToken></o:Security></s:Header>`
    : '';
  return `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="${envelope}">${header}<s:Body><m:${op.request.element} xmlns:m="${escape(op.request.namespace)}">${body}</m:${op.request.element}></s:Body></s:Envelope>`;
}

/** The rows in an answer: the list inside its wrappers, or the answer itself as one row. A fault is an error. */
export function soapRows(xml: string): Record<string, unknown>[] {
  const doc = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, processEntities: false, parseTagValue: true, numberParseOptions: { leadingZeros: false, hex: false, eNotation: false }, trimValues: true }).parse(xml) as Node;
  const body = (doc.Envelope as Node | undefined)?.Body;
  if (!isNode(body)) throw new ConnectorError('FAILED', 'The service did not answer with a SOAP message');
  if (body.Fault !== undefined) {
    const fault = body.Fault as Node;
    const said = fault.faultstring ?? (isNode(fault.Reason) ? fault.Reason.Text : undefined);
    const reason = typeof said === 'string' ? unescape(said) : said;
    throw new ConnectorError('FAILED', `The service refused the call${typeof reason === 'string' || typeof reason === 'number' ? `: ${String(reason).slice(0, 200)}` : ''}`);
  }
  const rows = (v: unknown, depth = 0): Record<string, unknown>[] => {
    if (Array.isArray(v)) return v.filter(isNode);
    if (!isNode(v)) return v === undefined || v === null || v === '' ? [] : [{ value: v }];
    const keys = Object.keys(v);
    const many = keys.find((k) => Array.isArray(v[k]) && (v[k] as unknown[]).every(isNode));
    if (many) return v[many] as Record<string, unknown>[];
    if (keys.length === 1 && isNode(v[keys[0]!]) && depth < 6) return rows(v[keys[0]!], depth + 1);
    // An answer that holds nothing (an empty list, an empty wrapper) is no rows, not one blank row.
    return keys.some((k) => v[k] !== '' && v[k] !== undefined && v[k] !== null) ? [v] : [];
  };
  return rows(Object.values(body)[0]).map((row) => plain(row) as Record<string, unknown>);
}

/** Text as it was meant, all the way down. */
function plain(v: unknown): unknown {
  if (typeof v === 'string') return unescape(v);
  if (Array.isArray(v)) return v.map(plain);
  return isNode(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
}

const settingsSchema = z.object({
  wsdlUrl: z.string().url().max(1000),
  /** Where calls go, when it is not where the WSDL says (a WSDL copied from a test system often names that one). */
  endpoint: z.string().url().max(1000).optional().or(z.literal('')),
  /** How the service knows us: not at all, by a user name and password on each request, or by a WS-Security user name token. */
  auth: z.enum(['none', 'basic', 'wsse']).optional(),
});

const described = new Map<string, { at: number; operations: SoapOperation[] }>();

async function operationsOf(ctx: ConnectorContext): Promise<SoapOperation[]> {
  const s = settingsSchema.parse(ctx.connector.settings);
  const held = described.get(`${ctx.connector.id}:${s.wsdlUrl}`);
  if (held && Date.now() - held.at < 10 * 60_000) return held.operations;
  const headers = basicAuth(ctx);
  const fetched = await safeFetch(ctx, s.wsdlUrl, { headers });
  if (fetched.status >= 400) throw new ConnectorError('FAILED', `The WSDL address answered ${fetched.status}`);
  // The files it is completed by, and theirs: a few, not a crawl.
  const more: string[] = [];
  const asked = new Set([s.wsdlUrl]);
  let queue = wsdlImports(fetched.text, s.wsdlUrl);
  while (queue.length && more.length < 8) {
    const next = queue.shift()!;
    if (asked.has(next)) continue;
    asked.add(next);
    const part = await safeFetch(ctx, next, { headers });
    if (part.status >= 400) continue;
    more.push(part.text);
    queue = [...queue, ...wsdlImports(part.text, next)];
  }
  const operations = parseWsdl(fetched.text, more).map((op) => ({ ...op, endpoint: s.endpoint || op.endpoint }));
  described.set(`${ctx.connector.id}:${s.wsdlUrl}`, { at: Date.now(), operations });
  return operations;
}

function basicAuth(ctx: ConnectorContext): Record<string, string> {
  return ctx.connector.settings.auth === 'basic' && ctx.secrets.username ? { Authorization: `Basic ${Buffer.from(`${ctx.secrets.username}:${ctx.secrets.password ?? ''}`).toString('base64')}` } : {};
}

async function call(ctx: ConnectorContext, op: SoapOperation, values: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const wsse = ctx.connector.settings.auth === 'wsse' && ctx.secrets.username ? { username: ctx.secrets.username, password: ctx.secrets.password ?? '' } : undefined;
  const headers: Record<string, string> =
    op.version === '1.2' ? { 'Content-Type': `application/soap+xml; charset=utf-8${op.action ? `; action="${op.action}"` : ''}` } : { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${op.action}"` };
  const r = await safeFetch(ctx, op.endpoint, { method: 'POST', headers: { ...headers, ...basicAuth(ctx) }, body: soapEnvelope(op, values, wsse) });
  // A fault comes with status 500 and a message worth reading; anything else without a SOAP body is a plain failure.
  if (r.status >= 400 && !/Envelope/.test(r.text)) throw new ConnectorError('FAILED', `The service answered ${r.status}`);
  return soapRows(r.text);
}

export const soapPlugin: ConnectorPlugin = {
  type: 'soap',
  label: 'SOAP web service',
  settingsSchema,
  secretsSchema: z.object({ username: z.string().max(200).optional(), password: z.string().max(500).optional() }),
  operations: ['list', 'get', 'lookup', 'insert', 'update'],

  async test(ctx) {
    const start = now();
    const operations = await operationsOf(ctx);
    return { ok: true, message: `Read the service's description: ${operations.length} ${operations.length === 1 ? 'operation' : 'operations'}`, latencyMs: elapsed(start) };
  },

  /** Each operation, with what it takes and what its answer's rows hold. */
  async discover(ctx): Promise<Entity[]> {
    return (await operationsOf(ctx)).slice(0, 300).map((op) => {
      const names = new Set(op.request.fields.map((f) => f.name));
      return { key: op.name, label: op.name, fields: [...op.request.fields, ...op.returns.filter((f) => !names.has(f.name)).map((f) => ({ ...f, nullable: true }))] };
    });
  },

  async run(ctx, req) {
    const start = now();
    const op = (await operationsOf(ctx)).find((o) => o.name === req.entity.key);
    if (!op) throw new ConnectorError('UNSUPPORTED', 'The service no longer offers that operation');
    const keyField = req.entity.keyField ?? op.request.fields[0]?.name ?? 'id';
    // Only what is exposed is sent, and only plain values (or a file, as base64).
    const sendable = (params: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(params).filter(([k, v]) => req.entity.fields.includes(k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v) || isFileValue(v))));
    switch (req.kind) {
      case 'list':
        return { rows: (await call(ctx, op, Object.fromEntries(filtersFrom(req.entity, req.params) as [string, Primitive][]))).slice(0, req.limits.maxRows), durationMs: elapsed(start) };
      case 'get':
      case 'lookup': {
        const key = req.params[keyField];
        if (key === undefined) throw new ConnectorError('UNSUPPORTED', `${keyField} is required`);
        const [row] = await call(ctx, op, { [keyField]: key });
        return { rows: row ? [req.kind === 'lookup' ? { exists: true } : row] : [], durationMs: elapsed(start) };
      }
      case 'insert':
      case 'update': {
        const values = sendable(req.params);
        if (!Object.keys(values).length) throw new ConnectorError('UNSUPPORTED', 'Nothing to send: no values for the exposed fields');
        const [row] = await call(ctx, op, values);
        return { rows: row ? [row] : [], affected: 1, durationMs: elapsed(start) };
      }
      default:
        throw new ConnectorError('UNSUPPORTED', `SOAP connectors can't ${req.kind}`);
    }
  },
};
