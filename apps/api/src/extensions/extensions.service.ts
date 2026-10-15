import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { CONTRACT, MAX_BODY, MAX_FIELD_PAGE, sign, SIGNATURE_HEADER, type CheckInfo, type FieldInfo, type ListInfo, type StepInfo } from '@fb/sdk';
import type { FormDefinition, FormValues } from '@fb/engine';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { newId, randomToken } from '../common/crypto';
import { KEY_PROVIDER, openWith, sealWith, type KeyProvider } from '../common/key-provider';
import { PlansService } from '../plans/plans.service';
import { ExtensionRow, type ExtensionDocument } from './extension.schema';

/** A workflow step an extension offers, as a form stores it: x-<ref>-<step>. A submission check has the same shape. */
export const EXT_STEP_KEY = /^x-([a-z0-9]{8})-([a-z0-9-]{1,40})$/;
/** A dropdown list an extension offers, as a form stores it. */
export const EXT_LIST_KEY = /^\/extensions\/([a-z0-9]{8})\/([a-z0-9-]{1,40})$/;

const KEY = /^[a-z0-9-]{1,40}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_EACH = 100;
/** A step runs in the background queue; a list and a check hold up a person at a form. */
const TIMEOUT = { manifest: 5_000, step: 15_000, list: 5_000, check: 5_000 };
const SECRET_TTL = 5 * 60_000;

/** The extension could not be reached, or what it sent back cannot be used. */
export class ExtensionFailure extends Error {
  constructor(message: string, readonly unreachable = false) {
    super(message);
  }
}

export interface ExtensionView {
  id: string;
  ref: string;
  name: string;
  status: ExtensionRow['status'];
  lastSyncedAt: Date | null;
  lastError: string;
  steps: StepInfo[];
  lists: ListInfo[];
  checks: CheckInfo[];
  fields: FieldInfo[];
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const names = (v: unknown, max: number, what: string): string[] => {
  const list = Array.isArray(v) ? v : [];
  if (list.length > max) throw new ExtensionFailure(`${what}: at most ${max} are allowed`);
  for (const n of list) if (typeof n !== 'string' || !NAME.test(n)) throw new ExtensionFailure(`${what}: "${String(n).slice(0, 40)}" must be a plain name`);
  return list as string[];
};

/** What an extension says it offers, kept only if every part is well formed: a designer will pick from it. */
function readManifest(raw: unknown): { name: string; steps: StepInfo[]; lists: ListInfo[]; checks: CheckInfo[]; fields: FieldInfo[] } {
  const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (m.contract !== CONTRACT) throw new ExtensionFailure(`It speaks contract ${String(m.contract)}; this server supports ${CONTRACT}. Update the SDK.`);
  const part = <T extends { key: string; label: string; description?: string }>(kind: string, value: unknown, more: (item: Record<string, unknown>, key: string) => Partial<T>): T[] => {
    const items = Array.isArray(value) ? value : [];
    if (items.length > MAX_EACH) throw new ExtensionFailure(`It offers more than ${MAX_EACH} ${kind}s`);
    const seen = new Set<string>();
    return items.map((raw) => {
      const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const key = typeof item.key === 'string' ? item.key : '';
      if (!KEY.test(key)) throw new ExtensionFailure(`A ${kind} has the key "${key.slice(0, 40)}"; keys are lower-case letters, digits and "-"`);
      if (seen.has(key)) throw new ExtensionFailure(`The ${kind} "${key}" is declared twice`);
      seen.add(key);
      const label = text(item.label, 100);
      if (!label) throw new ExtensionFailure(`The ${kind} "${key}" has no label`);
      const description = text(item.description, 300);
      return { key, label, ...(description ? { description } : {}), ...more(item, key) } as T;
    });
  };
  return {
    name: text(m.name, 100) || 'Extension',
    steps: part<StepInfo>('step', m.steps, (i, key) => {
      const outputs = names(i.outputs, 20, `Outputs of step "${key}"`);
      return outputs.length ? { outputs } : {};
    }),
    lists: part<ListInfo>('list', m.lists, (i, key) => {
      const params = names(i.params, 10, `Parameters of list "${key}"`);
      return params.length ? { params } : {};
    }),
    checks: part<CheckInfo>('check', m.checks, () => ({})),
    // An extension written before fields existed simply offers none.
    fields: part<FieldInfo>('field', m.fields, (i, key) => {
      if (i.height === undefined) return {};
      if (!(typeof i.height === 'number' && Number.isInteger(i.height) && i.height >= 40 && i.height <= 800)) throw new ExtensionFailure(`Height of field "${key}" must be 40 to 800`);
      return { height: i.height };
    }),
  };
}

/**
 * Extensions: an organisation's own code, running beside the product instead
 * of inside it. What an extension offers is listed for that organisation
 * alone, and every call to it is signed with a secret only it holds.
 */
@Injectable()
export class ExtensionsService {
  private readonly logger = new Logger(ExtensionsService.name);
  private readonly secrets = new Map<string, { secret: string; until: number }>();

  constructor(
    private readonly audit: AuditService,
    private readonly plans: PlansService,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    @InjectModel(ExtensionRow.name) private readonly rows: Model<ExtensionDocument>,
  ) {}

  private static view(row: ExtensionRow): ExtensionView {
    return {
      id: row.id,
      ref: row.ref,
      name: row.name || 'Extension',
      status: row.status,
      lastSyncedAt: row.lastSyncedAt,
      lastError: row.lastError,
      steps: row.steps as StepInfo[],
      lists: row.lists as ListInfo[],
      checks: row.checks as CheckInfo[],
      fields: (row.fields ?? []) as FieldInfo[],
    };
  }

  private live(orgId: string) {
    return this.rows.find({ orgId, isDeleted: false }).sort({ createdAt: 1 }).lean<ExtensionRow[]>();
  }

  private byRef(orgId: string, ref: string) {
    return this.rows.findOne({ orgId, ref, isDeleted: false }).lean<ExtensionRow>();
  }

  private async secretOf(row: ExtensionRow): Promise<string> {
    const cached = this.secrets.get(row.id);
    if (cached && cached.until > Date.now()) return cached.secret;
    const key = await this.keys.unwrap(row.wrappedKey, { orgId: row.orgId, extensionId: row.id });
    const { secret } = openWith<{ secret: string }>(key, row.sealedSecret);
    this.secrets.set(row.id, { secret, until: Date.now() + SECRET_TTL });
    return secret;
  }

  /** One signed request to the extension. Never follows a redirect, never waits past `timeoutMs`, never reads past 1 MB. */
  private async call(row: ExtensionRow, method: 'GET' | 'POST', path: string, payload: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const body = method === 'GET' ? '' : JSON.stringify(payload ?? {});
    const secret = await this.secretOf(row);
    let res: Response;
    let raw: ArrayBuffer;
    try {
      res = await fetch(new URL(path, row.url), {
        method,
        headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: sign(secret, { method, path, body }) },
        ...(method === 'GET' ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (Number(res.headers.get('content-length') ?? 0) > MAX_BODY) throw new Error('reply too large');
      raw = await res.arrayBuffer();
    } catch (e) {
      const why = e instanceof Error && e.name === 'TimeoutError' ? `did not answer within ${timeoutMs / 1000} seconds` : 'could not be reached';
      // Recorded before the caller hears of it, so the admins' page never lags behind what just happened.
      await this.note(row, `The extension ${why}`, true);
      throw new ExtensionFailure(`The extension ${why}`, true);
    }
    if (raw.byteLength > MAX_BODY) throw new ExtensionFailure('The extension sent back more than 1 MB');
    let reply: unknown;
    try {
      reply = JSON.parse(Buffer.from(raw).toString('utf8') || '{}');
    } catch {
      reply = null;
    }
    const data = reply && typeof reply === 'object' && !Array.isArray(reply) ? (reply as Record<string, unknown>) : null;
    if (!res.ok) {
      const said = text(data?.error, 300);
      const message = res.status === 401 ? 'The extension refused our signature: its secret does not match the one issued' : said || `The extension answered ${res.status}`;
      if (res.status === 401) await this.note(row, message, true);
      throw new ExtensionFailure(message);
    }
    if (!data) throw new ExtensionFailure('The extension did not send back JSON');
    if (row.status !== 'OK') await this.note(row, '', false);
    return data;
  }

  /** Remembers whether the extension is answering, for the admins' page. Never fails the call it describes. */
  private async note(row: ExtensionRow, error: string, unreachable: boolean) {
    await this.rows
      .updateOne({ id: row.id, orgId: row.orgId }, { $set: { status: unreachable ? 'UNREACHABLE' : 'OK', lastError: error } })
      .catch((e: Error) => this.logger.warn(`could not record the state of extension ${row.ref}: ${e.message}`));
  }

  // ── Operator: installing and removing ────────────────────────────────────

  /**
   * Registers a container for an organisation and issues its secret, shown
   * once. The address is ours: it points inside our network, so only an
   * operator sets it (the `extension` command), never the organisation.
   */
  async install(orgId: string, url: string, operator: string): Promise<{ id: string; ref: string; secret: string }> {
    let origin: string;
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Error();
      origin = u.origin;
    } catch {
      throw new BadRequestException('Give the address as http(s)://host:port, with nothing after it');
    }
    // Running a customer's container is part of what a plan includes.
    await this.plans.assertCanAdd(orgId, 'extensions');
    const id = newId();
    const ref = [...randomBytes(8)].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
    const secret = randomToken();
    const { plain, wrapped } = await this.keys.newDataKey({ orgId, extensionId: id });
    await this.rows.create({ id, orgId, ref, url: origin, sealedSecret: sealWith(plain, { secret }), wrappedKey: wrapped });
    await this.audit.record({ orgId, actorId: `operator:${operator}` }, { action: 'extension.installed', targetType: 'extension', targetId: id, after: { ref, url: origin } });
    return { id, ref, secret };
  }

  async uninstall(orgId: string, ref: string, operator: string): Promise<void> {
    const row = await this.rows.findOneAndUpdate({ orgId, ref, isDeleted: false }, { $set: { isDeleted: true } });
    if (!row) throw new NotFoundException('No such extension');
    this.secrets.delete(row.id);
    await this.audit.record({ orgId, actorId: `operator:${operator}` }, { action: 'extension.removed', targetType: 'extension', targetId: row.id, before: { ref, url: row.url } });
  }

  /** Asks the extension what it offers and keeps the answer. */
  private async sync(row: ExtensionRow): Promise<ExtensionView> {
    try {
      const manifest = readManifest(await this.call(row, 'GET', '/fb/manifest', undefined, TIMEOUT.manifest));
      // The page of every field it draws is copied now: forms are served from the copy, never from the container.
      const pages: Record<string, string> = {};
      for (const field of manifest.fields) {
        const html = (await this.call(row, 'GET', `/fb/fields/${field.key}`, undefined, TIMEOUT.manifest)).html;
        if (typeof html !== 'string' || !html.trim()) throw new ExtensionFailure(`The field "${field.key}" has no page`);
        if (Buffer.byteLength(html) > MAX_FIELD_PAGE) throw new ExtensionFailure(`The page of field "${field.key}" is larger than ${MAX_FIELD_PAGE / 1000} KB`);
        pages[field.key] = html;
      }
      const set = { ...manifest, pages, status: 'OK' as const, lastSyncedAt: new Date(), lastError: '' };
      await this.rows.updateOne({ id: row.id, orgId: row.orgId }, { $set: set });
      return ExtensionsService.view({ ...row, ...set });
    } catch (e) {
      if (!(e instanceof ExtensionFailure)) throw e;
      // What it offered before stays: forms that use it keep working if this was a passing fault.
      await this.rows.updateOne({ id: row.id, orgId: row.orgId }, { $set: { lastError: e.message, ...(e.unreachable ? { status: 'UNREACHABLE' as const } : {}) } });
      throw new BadRequestException(e.message);
    }
  }

  async syncByRef(orgId: string, ref: string): Promise<ExtensionView> {
    const row = await this.byRef(orgId, ref);
    if (!row) throw new NotFoundException('No such extension');
    return this.sync(row);
  }

  // ── The organisation's admins ────────────────────────────────────────────

  async list(orgId: string): Promise<ExtensionView[]> {
    return (await this.live(orgId)).map(ExtensionsService.view);
  }

  /** After the customer deploys a new version: read again what it offers. */
  async refresh(auth: AuthContext, id: string): Promise<ExtensionView> {
    const row = await this.rows.findOne({ orgId: auth.orgId, id, isDeleted: false }).lean<ExtensionRow>();
    if (!row) throw new NotFoundException('Extension not found');
    const view = await this.sync(row);
    await this.audit.record(actorOf(auth), { action: 'extension.refreshed', targetType: 'extension', targetId: id, after: { steps: view.steps.length, lists: view.lists.length, checks: view.checks.length } });
    return view;
  }

  // ── Workflow steps ───────────────────────────────────────────────────────

  async steps(orgId: string): Promise<{ key: string; label: string; description?: string; outputs?: string[] }[]> {
    return (await this.live(orgId)).flatMap((row) =>
      (row.steps as StepInfo[]).map((s) => ({ key: `x-${row.ref}-${s.key}`, label: `${row.name || 'Extension'}: ${s.label}`, ...(s.description ? { description: s.description } : {}), ...(s.outputs?.length ? { outputs: s.outputs } : {}) })),
    );
  }

  private async offered(orgId: string, key: string, kind: 'steps' | 'checks' | 'fields') {
    const m = EXT_STEP_KEY.exec(key);
    const row = m ? await this.byRef(orgId, m[1]!) : null;
    const item = (row?.[kind] as { key: string; label: string }[] | undefined)?.find((x) => x.key === m![2]);
    return row && item ? { row, item } : null;
  }

  async stepExists(orgId: string, key: string): Promise<boolean> {
    return !!(await this.offered(orgId, key, 'steps'));
  }

  /** Runs a step. A failure is thrown with the extension's own message, for the record's timeline. */
  async runStep(orgId: string, key: string, context: Record<string, unknown>): Promise<{ summary: string; data?: Record<string, unknown> }> {
    const found = await this.offered(orgId, key, 'steps');
    if (!found) throw new Error('This step is not available any more: its extension was removed, or no longer offers it');
    const reply = await this.call(found.row, 'POST', `/fb/steps/${found.item.key}`, { ...context, orgId }, TIMEOUT.step);
    const data = reply.data && typeof reply.data === 'object' && !Array.isArray(reply.data) ? (reply.data as Record<string, unknown>) : undefined;
    return { summary: text(reply.summary, 300) || `ran ${found.item.label}`, ...(data ? { data } : {}) };
  }

  // ── Dropdown lists ───────────────────────────────────────────────────────

  async sources(orgId: string): Promise<{ key: string; name: string; params: string[]; valueField: string; labelField: string }[]> {
    return (await this.live(orgId)).flatMap((row) =>
      (row.lists as ListInfo[]).map((l) => ({ key: `/extensions/${row.ref}/${l.key}`, name: `${row.name || 'Extension'} · ${l.label}`, params: l.params ?? [], valueField: 'value', labelField: 'label' })),
    );
  }

  /** The rows behind a dropdown. Only parameters the list declared are passed on. */
  async readList(orgId: string, key: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const m = EXT_LIST_KEY.exec(key);
    const row = m ? await this.byRef(orgId, m[1]!) : null;
    const list = (row?.lists as ListInfo[] | undefined)?.find((l) => l.key === m![2]);
    if (!row || !list) throw new NotFoundException(`No data source is available at ${key.slice(0, 100)}`);
    const allowed = new Set(list.params ?? []);
    const passed = Object.fromEntries(Object.entries(params).filter(([k, v]) => allowed.has(k) && v !== '' && v !== undefined));
    const reply = await this.call(row, 'POST', `/fb/lists/${list.key}`, { orgId, params: passed }, TIMEOUT.list);
    const rows = Array.isArray(reply.rows) ? reply.rows : [];
    return rows.slice(0, 1000).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r));
  }

  // ── Fields drawn by the organisation's own code ──────────────────────────

  async fields(orgId: string): Promise<{ key: string; label: string; description?: string; height: number }[]> {
    return (await this.live(orgId)).flatMap((row) =>
      ((row.fields ?? []) as FieldInfo[]).map((f) => ({ key: `x-${row.ref}-${f.key}`, label: `${row.name || 'Extension'}: ${f.label}`, ...(f.description ? { description: f.description } : {}), height: f.height ?? 120 })),
    );
  }

  async fieldExists(orgId: string, key: string): Promise<boolean> {
    return !!(await this.offered(orgId, key, 'fields'));
  }

  /** The page of a custom field as a form names it (x-<ref>-<field>), or null. */
  async fieldPage(orgId: string, key: string): Promise<string | null> {
    const found = await this.offered(orgId, key, 'fields');
    return found?.row.pages?.[found.item.key] ?? null;
  }

  // ── Checks before a submission is accepted ───────────────────────────────

  async checks(orgId: string): Promise<{ key: string; label: string; description?: string }[]> {
    return (await this.live(orgId)).flatMap((row) =>
      (row.checks as CheckInfo[]).map((c) => ({ key: `x-${row.ref}-${c.key}`, label: `${row.name || 'Extension'}: ${c.label}`, ...(c.description ? { description: c.description } : {}) })),
    );
  }

  async checkExists(orgId: string, key: string): Promise<boolean> {
    return !!(await this.offered(orgId, key, 'checks'));
  }

  /**
   * Runs the checks a form asks for, in order, stopping at the first that
   * objects. A check that cannot be run refuses the submission rather than
   * letting it through unchecked: the person is asked to try again.
   */
  async runChecks(orgId: string, definition: FormDefinition, values: FormValues): Promise<{ errors: { field: string; message: string }[]; message: string } | null> {
    for (const key of definition.submitChecks ?? []) {
      const found = await this.offered(orgId, key, 'checks');
      let reply: Record<string, unknown>;
      try {
        if (!found) throw new ExtensionFailure('the check is no longer offered');
        reply = await this.call(found.row, 'POST', `/fb/checks/${found.item.key}`, { orgId, form: { code: definition.code, version: definition.version, name: definition.name }, values }, TIMEOUT.check);
      } catch (e) {
        if (!(e instanceof ExtensionFailure)) throw e;
        this.logger.warn(`check ${key} on ${definition.code} could not run: ${e.message}`);
        throw new ServiceUnavailableException("We couldn't check your answers just now. Nothing was sent. Please try again in a moment.");
      }
      const raw = reply.errors && typeof reply.errors === 'object' && !Array.isArray(reply.errors) ? Object.entries(reply.errors as Record<string, unknown>) : [];
      // A message goes under a field only if the form has that field ("lines.0.qty" for a row); otherwise it is said for the whole form.
      const known = new Set(definition.fields.map((f) => f.name));
      const errors: { field: string; message: string }[] = [];
      const loose: string[] = [];
      for (const [field, value] of raw.slice(0, 50)) {
        const said = text(value, 300);
        if (!said) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*(\.\d{1,4}\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(field) && known.has(field.split('.')[0]!)) errors.push({ field, message: said });
        else loose.push(said);
      }
      const message = text(reply.message, 300) || loose.join(' ').slice(0, 300);
      if (errors.length || message) return { errors, message };
    }
    return null;
  }
}
