import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * Form Builder extension SDK.
 *
 * An extension is a small service that holds one organisation's custom code.
 * It declares what it offers - workflow steps, dropdown lists, checks run
 * before a submission is accepted - and Form Builder calls it when a form
 * uses one of them. What it declares appears in the builder's pickers for
 * that organisation only.
 *
 *   const ext = createExtension({ name: 'Acme' });
 *   ext.step({ key: 'credit-check', label: 'Check credit', outputs: ['score'] }, async (ctx) => {
 *     return { summary: 'Score 710', data: { score: 710 } };
 *   });
 *   ext.listen();
 *
 * Every request is signed with the extension's secret (FB_EXTENSION_SECRET);
 * anything unsigned, altered or older than five minutes is refused.
 */

/** The version of the contract between Form Builder and an extension. */
export const CONTRACT = 1;
export const SIGNATURE_HEADER = 'x-fb-signature';
/** How long a signed request stays acceptable. */
export const TOLERANCE_SECONDS = 300;
/** The largest request or reply, in bytes. */
export const MAX_BODY = 1_000_000;

const KEY = /^[a-z0-9-]{1,40}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export interface SignedParts {
  method: string;
  /** The path as sent, e.g. /fb/steps/credit-check. */
  path: string;
  body: string;
}

const mac = (secret: string, seconds: number, { method, path, body }: SignedParts) =>
  createHmac('sha256', secret).update(`${seconds}.${method.toUpperCase()}.${path}.${body}`).digest('hex');

/** The signature header for a request: `t=<seconds>,v1=<hmac>`. */
export function sign(secret: string, parts: SignedParts, now: number = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  return `t=${seconds},v1=${mac(secret, seconds, parts)}`;
}

/** Whether a request really came from Form Builder, unaltered and recently. */
export function verify(secret: string, header: string | undefined, parts: SignedParts, now: number = Date.now()): boolean {
  const m = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header ?? '');
  if (!secret || !m) return false;
  const seconds = Number(m[1]);
  if (Math.abs(Math.floor(now / 1000) - seconds) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(mac(secret, seconds, parts), 'hex');
  const given = Buffer.from(m[2]!, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export type Values = Record<string, unknown>;

export interface FormRef {
  code: string;
  version: number;
  name: string;
}

// ── Workflow steps ─────────────────────────────────────────────────────────

export interface StepInfo {
  /** Stored in the workflows that use it: lower-case letters, digits and "-". Never rename one in use. */
  key: string;
  /** What a designer sees in the step picker. */
  label: string;
  description?: string;
  /** Fields of the `data` it returns, offered to later steps as {{$steps.<step>.<field>}} and in conditions. */
  outputs?: string[];
}

export interface StepContext {
  orgId: string;
  /** What started the flow: SUBMITTED, STATUS_CHANGED, SLA_BREACHED, SLA_APPROACHING or FIELD_UPDATED. */
  trigger: string;
  form: FormRef;
  record: { id: string; ref: string; status: string; priority: string; assigneeId: string; submittedAt: string };
  /** The answers, by field name. */
  values: Values;
  /** What the team filled in on the work item, by work field name. */
  work: Values;
  /** What earlier steps of this flow returned, by step key. */
  steps: Record<string, unknown>;
  /** This step's key in the flow: its `data` lands at steps[stepKey] for the steps below. */
  stepKey: string;
  /**
   * The same each time this step of this run is tried (a try can be repeated after an interruption), different
   * for every other: pass it on as an Idempotency-Key, or store it, so the work is done once.
   */
  runKey?: string;
}

/** A line for the record's timeline, optionally with data for later steps. Throw to fail the step. */
export type StepResult = string | void | { summary?: string; data?: Record<string, unknown> };

// ── Dropdown lists ─────────────────────────────────────────────────────────

export interface ListInfo {
  key: string;
  /** What a designer sees when choosing where a dropdown's options come from. */
  label: string;
  description?: string;
  /** Names of the parameters it accepts, e.g. the answer of another field a dependent dropdown filters by. */
  params?: string[];
}

export interface ListContext {
  orgId: string;
  /** Parameters the form passed; one that is empty or not yet answered is left out. */
  params: Record<string, string | number | boolean>;
}

/** One option. Other properties are allowed and can be used to fill other fields. */
export interface ListRow {
  value: string | number;
  label: string;
  [extra: string]: unknown;
}

// ── Checks before a submission is accepted ─────────────────────────────────

export interface CheckInfo {
  key: string;
  /** What a designer sees in the form's settings. */
  label: string;
  description?: string;
}

export interface CheckContext {
  orgId: string;
  form: FormRef;
  /** The answers as the server will store them (calculated fields already computed). */
  values: Values;
}

/**
 * Nothing (or an empty object) accepts the submission. `errors` refuses it
 * with a message under each named field; `message` refuses it with one
 * message for the whole form.
 */
export type CheckResult = void | { errors?: Record<string, string>; message?: string };

// ── Fields drawn by your own code ──────────────────────────────────────────

export interface FieldInfo {
  key: string;
  /** What a designer sees when choosing which custom field this is. */
  label: string;
  description?: string;
  /** How tall the field is before it has measured itself, in pixels (default 120). */
  height?: number;
}

/** The largest page a field may be, in bytes. It must carry its own script and styles. */
export const MAX_FIELD_PAGE = 200_000;

/**
 * A complete page for a custom field, from the markup, styles and script you
 * give. It runs in a locked frame on the form: it cannot read the rest of the
 * page, cannot load anything from the network and cannot reach anyone's
 * session. It talks to the form through `fb`:
 *
 *   fb.onInit(({ value, readOnly, label, required }) => { ... })   // once, when the form is ready
 *   fb.setValue('text')                                             // the field's answer, as text (up to 10,000 characters)
 *   fb.onReadOnly((readOnly) => { ... })                            // a rule switched the field off or on
 *
 * The frame grows and shrinks with its content by itself.
 */
export function fieldPage(parts: { body: string; script?: string; style?: string }): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;background:transparent}${parts.style ?? ''}</style>
</head><body>${parts.body}
<script>
(function () {
  var send = function (m) { m.fb = 1; parent.postMessage(m, '*'); };
  var onInit = [], onReadOnly = [], state = null;
  window.fb = {
    onInit: function (cb) { if (state) cb(state); else onInit.push(cb); },
    onReadOnly: function (cb) { onReadOnly.push(cb); },
    setValue: function (value) { send({ type: 'change', value: String(value == null ? '' : value) }); }
  };
  addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || e.data.fb !== 1) return;
    if (e.data.type === 'init') { state = e.data; onInit.splice(0).forEach(function (cb) { cb(state); }); }
    if (e.data.type === 'readOnly') onReadOnly.forEach(function (cb) { cb(!!e.data.readOnly); });
  });
  var report = function () { send({ type: 'height', height: Math.ceil(document.documentElement.scrollHeight) }); };
  if (window.ResizeObserver) new ResizeObserver(report).observe(document.body);
  addEventListener('load', report);
  send({ type: 'ready' });
})();
</script>
${parts.script ? `<script>${parts.script}</script>` : ''}
</body></html>`;
}

// ── The extension ──────────────────────────────────────────────────────────

export interface Manifest {
  contract: number;
  name: string;
  steps: StepInfo[];
  lists: ListInfo[];
  checks: CheckInfo[];
  fields: FieldInfo[];
}

export interface ExtensionOptions {
  /** Shown to the organisation's admins next to what the extension offers. */
  name: string;
  /** The secret Form Builder issued for this extension. Default: FB_EXTENSION_SECRET. */
  secret?: string;
  /** Refuse requests made for any other organisation. Default: FB_ORG_ID, when set. */
  orgId?: string;
}

export interface ExtensionRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface ExtensionResponse {
  status: number;
  body: unknown;
}

type Handler<C, R> = (ctx: C) => R | Promise<R>;

const describe = <T extends { key: string; label: string }>(kind: string, info: T, taken: Map<string, unknown>) => {
  if (!KEY.test(info.key ?? '')) throw new Error(`${kind} key "${info.key}" must be 1-40 lower-case letters, digits or "-"`);
  if (!info.label?.trim()) throw new Error(`${kind} "${info.key}" needs a label`);
  if (taken.has(info.key)) throw new Error(`${kind} "${info.key}" is declared twice`);
};

const object = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export class Extension {
  private readonly steps = new Map<string, { info: StepInfo; run: Handler<StepContext, StepResult> }>();
  private readonly lists = new Map<string, { info: ListInfo; run: Handler<ListContext, ListRow[]> }>();
  private readonly checks = new Map<string, { info: CheckInfo; run: Handler<CheckContext, CheckResult> }>();
  private readonly fields = new Map<string, { info: FieldInfo; page: string }>();

  constructor(private readonly options: ExtensionOptions) {
    if (!options.name?.trim()) throw new Error('Give the extension a name');
  }

  /** A step designers can add to a workflow's automations. */
  step(info: StepInfo, run: Handler<StepContext, StepResult>): this {
    describe('Step', info, this.steps);
    for (const o of info.outputs ?? []) if (!NAME.test(o)) throw new Error(`Step "${info.key}": output "${o}" must be a plain name (letters, digits, _)`);
    this.steps.set(info.key, { info, run });
    return this;
  }

  /** A list designers can choose as the source of a dropdown's options. */
  list(info: ListInfo, run: Handler<ListContext, ListRow[]>): this {
    describe('List', info, this.lists);
    for (const p of info.params ?? []) if (!NAME.test(p)) throw new Error(`List "${info.key}": parameter "${p}" must be a plain name (letters, digits, _)`);
    this.lists.set(info.key, { info, run });
    return this;
  }

  /** A check designers can switch on for a form: it runs before a submission is accepted. Keep it fast. */
  check(info: CheckInfo, run: Handler<CheckContext, CheckResult>): this {
    describe('Check', info, this.checks);
    this.checks.set(info.key, { info, run });
    return this;
  }

  /**
   * A field your own code draws on the form: `page` is a complete HTML page
   * (use `fieldPage`). Designers add it from the palette under "Your
   * extension". Form Builder keeps a copy of the page when it reads what you
   * offer, so the form does not depend on this service being up.
   */
  field(info: FieldInfo, page: string): this {
    describe('Field', info, this.fields);
    if (info.height !== undefined && !(Number.isInteger(info.height) && info.height >= 40 && info.height <= 800)) throw new Error(`Field "${info.key}": height is a whole number of pixels from 40 to 800`);
    if (typeof page !== 'string' || !page.trim()) throw new Error(`Field "${info.key}" needs its page`);
    if (Buffer.byteLength(page) > MAX_FIELD_PAGE) throw new Error(`Field "${info.key}": the page is larger than ${MAX_FIELD_PAGE / 1000} KB`);
    this.fields.set(info.key, { info, page });
    return this;
  }

  manifest(): Manifest {
    const infos = <T>(m: Map<string, { info: T }>) => [...m.values()].map((x) => x.info);
    return { contract: CONTRACT, name: this.options.name.trim(), steps: infos(this.steps), lists: infos(this.lists), checks: infos(this.checks), fields: infos(this.fields) };
  }

  private get secret(): string {
    const secret = this.options.secret ?? process.env.FB_EXTENSION_SECRET ?? '';
    if (!secret) throw new Error('Set FB_EXTENSION_SECRET to the secret Form Builder issued for this extension');
    return secret;
  }

  /**
   * Answers one request. `listen` uses it; call it yourself to serve the
   * extension from another framework or to test it.
   */
  async handle(request: ExtensionRequest): Promise<ExtensionResponse> {
    const method = request.method.toUpperCase();
    const path = request.path.split('?')[0]!;
    // For the container's health check only: says nothing about what is inside.
    if (method === 'GET' && path === '/fb/health') return { status: 200, body: { ok: true } };

    const header = request.headers[SIGNATURE_HEADER];
    if (!verify(this.secret, Array.isArray(header) ? header[0] : header, { method, path, body: request.body })) {
      return { status: 401, body: { error: 'This request was not signed by Form Builder' } };
    }
    if (method === 'GET' && path === '/fb/manifest') return { status: 200, body: this.manifest() };

    const page = /^\/fb\/fields\/([a-z0-9-]{1,40})$/.exec(path);
    if (method === 'GET' && page) {
      const field = this.fields.get(page[1]!);
      return field ? { status: 200, body: { html: field.page } } : { status: 404, body: { error: `No field "${page[1]}"` } };
    }

    const m = /^\/fb\/(steps|lists|checks)\/([a-z0-9-]{1,40})$/.exec(path);
    if (method !== 'POST' || !m) return { status: 404, body: { error: 'Not found' } };
    let input: Record<string, unknown>;
    try {
      input = object(JSON.parse(request.body || '{}'));
    } catch {
      return { status: 400, body: { error: 'The request is not JSON' } };
    }
    const only = this.options.orgId ?? process.env.FB_ORG_ID;
    if (only && input.orgId !== only) return { status: 403, body: { error: 'This extension belongs to another organisation' } };

    try {
      const [, kind, key] = m;
      if (kind === 'steps') {
        const step = this.steps.get(key!);
        if (!step) return { status: 404, body: { error: `No step "${key}"` } };
        const result = await step.run(input as unknown as StepContext);
        return { status: 200, body: typeof result === 'string' ? { summary: result } : { summary: result?.summary, data: result?.data } };
      }
      if (kind === 'lists') {
        const list = this.lists.get(key!);
        if (!list) return { status: 404, body: { error: `No list "${key}"` } };
        const rows = await list.run({ orgId: String(input.orgId ?? ''), params: object(input.params) as ListContext['params'] });
        if (!Array.isArray(rows)) throw new Error(`List "${key}" must return an array of rows`);
        return { status: 200, body: { rows } };
      }
      const check = this.checks.get(key!);
      if (!check) return { status: 404, body: { error: `No check "${key}"` } };
      const result = (await check.run(input as unknown as CheckContext)) ?? {};
      return { status: 200, body: { errors: result.errors ?? {}, message: result.message ?? '' } };
    } catch (e) {
      // The message is yours: it is shown on the record's timeline (steps) or logged (lists, checks).
      return { status: 500, body: { error: e instanceof Error && e.message ? e.message.slice(0, 500) : 'The extension failed' } };
    }
  }

  /** Serves the extension over HTTP. The port defaults to PORT, then 8080. */
  listen(port: number = Number(process.env.PORT) || 8080, host?: string): Promise<Server> {
    void this.secret; // fail at start-up, not on the first request
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          res.writeHead(413, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Request too large' }));
          req.destroy();
        } else chunks.push(chunk);
      });
      req.on('end', () => {
        void this.handle({ method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
          .catch(() => ({ status: 500, body: { error: 'The extension failed' } }))
          .then(({ status, body }) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)));
      });
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server));
    });
  }
}

export const createExtension = (options: ExtensionOptions) => new Extension(options);
