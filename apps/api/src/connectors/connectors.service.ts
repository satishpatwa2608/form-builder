import { orgLog } from '../logs/org-log';
import { mappedValues } from '@fb/engine';
import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeMongoConnections,
  closeSqlConnections,
  ConnectorError,
  defaultRegistry,
  lastingSignIn,
  WRITE_OPERATIONS,
  type ConnectorRecord,
  type ConnectorType,
  type Entity,
  type EntityRef,
  type OperationKind,
  type OperationResult,
} from '@fb/connectors';
import type { Model } from 'mongoose';
import { Grant, type GrantDocument } from '../access/access.schemas';
import { isAllowed, type ResourceRef } from '../access/roles';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { newId } from '../common/crypto';
import { KEY_PROVIDER, openWith, sealWith, type KeyProvider } from '../common/key-provider';
import { APP_CONFIG, type AppConfig } from '../config';
import { PlansService } from '../plans/plans.service';
import { GatewaysService } from '../gateways/gateways.service';
import { Connector, ConnectorCall, type ConnectorCallDocument, type ConnectorDocument, type ExposedEntity } from './connector.schema';

/** What the API returns about a connector - never the credentials. */
export interface ConnectorView {
  id: string;
  ref: string;
  type: ConnectorType;
  name: string;
  settings: Record<string, string | number | boolean>;
  credentialsSet: boolean;
  /** Set when the connector runs through a gateway agent. */
  gatewayId: string;
  gatewayConnected: boolean;
  writable: boolean;
  allowedHosts: string[];
  entities: ExposedEntity[];
  lastTest: Connector['lastTest'];
  permissions: { use: boolean; manage: boolean };
}

/** A dropdown/prefill source the builder can bind to. */
export interface ConnectorSource {
  key: string;
  name: string;
  connectorId: string;
  params: string[];
  valueField?: string;
  labelField?: string;
  /** Lists of related rows that come along with a row of this one, with the fields of each of their rows. */
  related?: { name: string; fields: string[] }[];
}

/** A write the builder can add as an automation step ("Run a custom API"). */
export interface ConnectorAction {
  key: string;
  label: string;
  description: string;
  outputs: string[];
  /** The fields it fills, for the builder to show which answer goes into each. */
  inputs?: string[];
}

const LIMITS = { timeoutMs: 15_000, maxRows: 1000 };
/** Related rows are fetched for a look-up's few rows, and each list of them is kept short. */
const RELATED_FOR_AT_MOST = 5;
const RELATED_LIMITS = { timeoutMs: 10_000, maxRows: 100 };
/** Copying files takes longer than a query. */
const UPLOAD_LIMITS = { timeoutMs: 30_000, maxRows: 1000 };
/** How much of what a respondent uploaded is copied with one response. A gateway's messages are far smaller. */
const MAX_COPY_BYTES = 25 * 1024 * 1024;
const MAX_COPY_BYTES_GATEWAY = 5 * 1024 * 1024;

/** What a response is, as files, for a connector that keeps files. Made only when such a step runs. */
export interface ResponseFiles {
  name: string;
  pdf: () => Promise<Buffer | null>;
  /** The respondent's uploads that fit in `room` bytes together, and how many did not. */
  attachments: (room: number) => Promise<{ files: { name: string; type: string; content: Buffer }[]; leftOut: number }>;
}
const REF = /^[a-z0-9]{8}$/;
/** Data source keys in form definitions: /connectors/<ref>/<entity>. */
export const SOURCE_KEY = /^\/connectors\/([a-z0-9]{8})\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,119})$/;
/** Automation step keys: c-<ref>-<hash of entity+operation> (fits the engine's 60-char key rule). */
export const ACTION_KEY = /^c-([a-z0-9]{8})-([a-f0-9]{8})$/;
const actionHash = (entity: string, op: string) => createHash('sha256').update(`${entity}\u0000${op}`).digest('hex').slice(0, 8);

@Injectable()
export class ConnectorsService implements OnModuleDestroy {
  private readonly registry = defaultRegistry();

  /** Pooled customer-database connections close with the app. */
  async onModuleDestroy() {
    await Promise.all([closeMongoConnections(), closeSqlConnections()]);
  }

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(KEY_PROVIDER) private readonly keys: KeyProvider,
    private readonly audit: AuditService,
    @InjectModel(Connector.name) private readonly connectors: Model<ConnectorDocument>,
    @InjectModel(ConnectorCall.name) private readonly calls: Model<ConnectorCallDocument>,
    @InjectModel(Grant.name) private readonly grants: Model<GrantDocument>,
    private readonly gateways: GatewaysService,
    private readonly plans: PlansService,
  ) {}

  types() {
    return this.registry.types().map((t) => ({ type: t, label: this.registry.get(t).label, operations: this.registry.get(t).operations }));
  }

  // ---------------------------------------------------------------- permissions

  private async perms(auth: AuthContext, c: Pick<Connector, 'id'>) {
    const grants = await this.grants.find({ orgId: auth.orgId, userId: auth.userId, 'scope.type': 'connector' }).lean();
    const ref: ResourceRef = { type: 'connector', id: c.id };
    return { use: isAllowed(auth.role, grants, 'connector.use', ref), manage: isAllowed(auth.role, grants, 'connector.manage', ref) };
  }

  private async mustGet(auth: AuthContext, id: string, need: 'use' | 'manage') {
    const c = await this.connectors.findOne({ id, orgId: auth.orgId, isDeleted: false });
    if (!c) throw new NotFoundException('Connector not found');
    const p = await this.perms(auth, c);
    if (!p.use && !p.manage) throw new NotFoundException('Connector not found');
    if (!p[need]) throw new ForbiddenException("You don't have permission to do that");
    return c;
  }

  private async view(auth: AuthContext, c: Connector): Promise<ConnectorView> {
    return {
      id: c.id,
      ref: c.ref,
      type: c.type,
      name: c.name,
      settings: c.settings,
      credentialsSet: !!c.sealedSecrets || !!c.gatewayId,
      gatewayId: c.gatewayId,
      gatewayConnected: !!c.gatewayId && (await this.gateways.isConnected(c.orgId, c.gatewayId)),
      writable: c.writable,
      allowedHosts: c.allowedHosts,
      entities: c.entities,
      lastTest: c.lastTest,
      permissions: await this.perms(auth, c),
    };
  }

  // ---------------------------------------------------------------- credentials

  private context(c: Pick<Connector, 'orgId' | 'id'>) {
    return { orgId: c.orgId, connectorId: c.id };
  }

  private async seal(c: Pick<Connector, 'orgId' | 'id'>, secrets: Record<string, string>) {
    const { plain, wrapped } = await this.keys.newDataKey(this.context(c));
    return { sealedSecrets: sealWith(plain, secrets), wrappedKey: wrapped, keyProvider: this.keys.name };
  }

  /** Credentials exist in memory only for the duration of a call. */
  private async secretsOf(c: Connector): Promise<Record<string, string>> {
    if (!c.sealedSecrets) return {};
    return openWith<Record<string, string>>(await this.keys.unwrap(c.wrappedKey, this.context(c)), c.sealedSecrets);
  }

  private record(c: Connector): ConnectorRecord {
    return { id: c.id, orgId: c.orgId, type: c.type, name: c.name, settings: c.settings, secretRef: c.wrappedKey ? 'sealed' : '', writable: c.writable, allowedHosts: c.allowedHosts };
  }

  // ---------------------------------------------------------------- management

  async list(auth: AuthContext): Promise<ConnectorView[]> {
    const rows = await this.connectors.find({ orgId: auth.orgId, isDeleted: false }).sort({ name: 1 });
    const views = await Promise.all(rows.map((c) => this.view(auth, c)));
    return views.filter((v) => v.permissions.use || v.permissions.manage);
  }

  async get(auth: AuthContext, id: string) {
    return this.view(auth, await this.mustGet(auth, id, 'use'));
  }

  private validate(type: ConnectorType, settings: unknown, secrets?: unknown) {
    const plugin = this.registry.get(type);
    const s = plugin.settingsSchema.safeParse(settings ?? {});
    if (!s.success) throw new BadRequestException({ message: 'Some settings are not valid', errors: s.error.issues.map((i) => ({ field: `settings.${i.path.join('.')}`, message: i.message })) });
    const flat = Object.fromEntries(Object.entries(s.data as Record<string, unknown>).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))) as Record<string, string | number | boolean>;
    if (secrets === undefined) return { settings: flat };
    const k = plugin.secretsSchema.safeParse(secrets ?? {});
    if (!k.success) throw new BadRequestException({ message: 'Some credentials are not valid', errors: k.error.issues.map((i) => ({ field: `secrets.${i.path.join('.')}`, message: i.message })) });
    return { settings: flat, secrets: k.data as Record<string, string> };
  }

  async create(auth: AuthContext, body: { type: ConnectorType; name: string; settings: unknown; secrets: unknown; writable?: boolean; allowedHosts?: string[]; gatewayId?: string }) {
    if (!isAllowed(auth.role, [], 'connector.manage')) throw new ForbiddenException("You don't have permission to do that");
    if (!this.registry.types().includes(body.type)) throw new BadRequestException('Unknown connector type');
    if (body.gatewayId) await this.gateways.assertUsable(auth.orgId, body.gatewayId);
    await this.plans.assertCanAdd(auth.orgId, 'connectors');
    // Through a gateway, the credentials stay on the agent: none are accepted here.
    const { settings, secrets } = body.gatewayId ? this.validate(body.type, body.settings) : this.validate(body.type, body.settings, body.secrets);
    const id = newId();
    const ref = randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, '0').slice(0, 8);
    await this.connectors.create({
      id,
      orgId: auth.orgId,
      ref,
      type: body.type,
      name: body.name,
      settings,
      ...(await this.seal({ orgId: auth.orgId, id }, secrets ?? {})),
      writable: !!body.writable,
      gatewayId: body.gatewayId ?? '',
      allowedHosts: (body.allowedHosts ?? []).map((h) => h.toLowerCase()),
      createdBy: auth.userId,
    });
    await this.audit.record(actorOf(auth), { action: 'connector.created', targetType: 'connector', targetId: id, after: { type: body.type, name: body.name, writable: !!body.writable } });
    return this.get(auth, id);
  }

  async update(auth: AuthContext, id: string, body: { name?: string; settings?: unknown; writable?: boolean; allowedHosts?: string[] }) {
    const c = await this.mustGet(auth, id, 'manage');
    const before = { name: c.name, writable: c.writable, settings: c.settings };
    if (body.settings !== undefined) c.set({ settings: this.validate(c.type, body.settings).settings });
    if (body.name !== undefined) c.set({ name: body.name });
    if (body.writable !== undefined) c.set({ writable: body.writable });
    if (body.allowedHosts !== undefined) c.set({ allowedHosts: body.allowedHosts.map((h) => h.toLowerCase()) });
    c.markModified('settings');
    await c.save();
    await this.audit.record(actorOf(auth), { action: 'connector.updated', targetType: 'connector', targetId: id, before, after: { name: c.name, writable: c.writable, settings: c.settings } });
    return this.view(auth, c);
  }

  /** New credentials, with a new data key. The old ones are gone. */
  async rotateSecrets(auth: AuthContext, id: string, secrets: unknown) {
    const c = await this.mustGet(auth, id, 'manage');
    if (c.gatewayId) throw new BadRequestException("This connector's credentials live on its gateway agent - change them there");
    const valid = this.validate(c.type, c.settings, secrets).secrets!;
    c.set(await this.seal(c, valid));
    c.set({ lastTest: null });
    await c.save();
    await this.audit.record(actorOf(auth), { action: 'connector.credentials_changed', targetType: 'connector', targetId: id });
    return this.view(auth, c);
  }

  async remove(auth: AuthContext, id: string) {
    const c = await this.mustGet(auth, id, 'manage');
    c.set({ isDeleted: true, sealedSecrets: '', wrappedKey: '' });
    await c.save();
    await this.audit.record(actorOf(auth), { action: 'connector.deleted', targetType: 'connector', targetId: id, before: { name: c.name } });
    return { deleted: true };
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), LIMITS.timeoutMs);
    try {
      return await fn(ac.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async test(auth: AuthContext, id: string) {
    const c = await this.mustGet(auth, id, 'manage');
    const plugin = this.registry.get(c.type);
    let result: { ok: boolean; message: string; latencyMs?: number };
    try {
      if (c.gatewayId) {
        const r = await this.gateways.call(c.orgId, c.gatewayId, 'test', { ...this.record(c), ref: c.ref });
        result = r.ok ? (r.result as typeof result) : { ok: false, message: r.error };
      } else {
        const secrets = await this.secretsOf(c);
        result = await this.withTimeout((signal) => plugin.test({ connector: this.record(c), secrets, signal, allowPrivateNetwork: this.privateAllowed() }));
      }
    } catch (e) {
      // Driver messages can echo hosts or credentials: only the error kind goes back.
      result = { ok: false, message: e instanceof ConnectorError ? e.message : `Couldn't connect (${(e as Error).name})` };
    }
    c.set({ lastTest: { at: new Date(), ok: result.ok, message: result.message.slice(0, 200), latencyMs: result.latencyMs ?? 0 } });
    await c.save();
    await this.audit.record(actorOf(auth), { action: 'connector.tested', targetType: 'connector', targetId: id, after: { ok: result.ok } });
    return result;
  }

  async discover(auth: AuthContext, id: string): Promise<Entity[]> {
    const c = await this.mustGet(auth, id, 'manage');
    try {
      if (c.gatewayId) {
        const r = await this.gateways.call(c.orgId, c.gatewayId, 'discover', { ...this.record(c), ref: c.ref });
        if (!r.ok) throw new ConnectorError('FAILED', r.error);
        return r.result as Entity[];
      }
      const secrets = await this.secretsOf(c);
      return await this.withTimeout((signal) => this.registry.get(c.type).discover({ connector: this.record(c), secrets, signal, allowPrivateNetwork: this.privateAllowed() }));
    } catch (e) {
      throw new BadRequestException(e instanceof ConnectorError ? e.message : `Couldn't read the structure (${(e as Error).name})`);
    }
  }

  /** Nothing is exposed until a connector manager chooses entities, fields and operations. */
  async setEntities(auth: AuthContext, id: string, entities: ExposedEntity[]) {
    const c = await this.mustGet(auth, id, 'manage');
    const supported = this.registry.get(c.type).operations;
    for (const e of entities) {
      const bad = e.operations.filter((op) => !supported.includes(op));
      if (bad.length) throw new BadRequestException(`${c.name} can't ${bad.join(', ')}`);
      for (const f of [e.keyField, e.valueField, e.labelField].filter(Boolean)) if (!e.fields.includes(f)) throw new BadRequestException(`"${f}" must be one of the exposed fields of ${e.key}`);
      // Related rows: from a table that is exposed for reading, matched on fields that are exposed on both sides.
      const names = new Set<string>();
      for (const r of e.related ?? []) {
        if (e.fields.includes(r.name) || names.has(r.name)) throw new BadRequestException(`"${r.name}" is already a name on ${e.label}: give the related rows another`);
        names.add(r.name);
        if (!e.fields.includes(r.equals)) throw new BadRequestException(`"${r.equals}" must be one of the exposed fields of ${e.label}`);
        const m = SOURCE_KEY.exec(r.source);
        // The table may be one being saved in this same request, or one on another of the organisation's connectors.
        const other = m && m[1] === c.ref ? entities.find((x) => x.key === m[2]) : m ? (await this.byRef(auth.orgId, m[1]!))?.entities.find((x) => x.key === m[2]) : undefined;
        if (!other || !other.operations.includes('list')) throw new BadRequestException(`The rows related to ${e.label} must come from a table that forms may list`);
        if (!other.fields.includes(r.field)) throw new BadRequestException(`"${r.field}" must be one of the exposed fields of ${other.label}`);
      }
    }
    const before = c.entities.map((e) => `${e.key}:${e.operations.join('+')}`);
    c.set({ entities });
    await c.save();
    await this.audit.record(actorOf(auth), { action: 'connector.entities_changed', targetType: 'connector', targetId: id, before: { entities: before.join(', ') }, after: { entities: entities.map((e) => `${e.key}:${e.operations.join('+')}`).join(', ') } });
    return this.view(auth, c);
  }

  async callLog(auth: AuthContext, id: string) {
    await this.mustGet(auth, id, 'manage');
    return this.calls.find({ orgId: auth.orgId, connectorId: id }).sort({ at: -1 }).limit(100).select('-_id -__v').lean();
  }

  // ---------------------------------------------------------------- use in forms

  private privateAllowed() {
    return this.config.NODE_ENV !== 'production' && process.env.CONNECTOR_ALLOW_PRIVATE_NETWORK === 'true';
  }

  /** Runs one exposed operation and logs the call (never the values). */
  private async run(c: Connector, entity: ExposedEntity, kind: OperationKind, params: Record<string, unknown>, actor: string, limits = LIMITS): Promise<OperationResult> {
    if (!entity.operations.includes(kind)) throw new ForbiddenException(`${kind} is not allowed on ${entity.label}`);
    const ref: EntityRef = { key: entity.key, fields: entity.fields, keyField: entity.keyField || undefined };
    const start = Date.now();
    try {
      let res: OperationResult;
      if (c.gatewayId) {
        // The same checks run on the agent (registry.run); these are ours first.
        if (WRITE_OPERATIONS.includes(kind) && !c.writable) throw new ConnectorError('READ_ONLY', `"${c.name}" is read-only`);
        const r = await this.gateways.call(c.orgId, c.gatewayId, 'run', { ...this.record(c), ref: c.ref }, { entity: ref, kind, params, limits });
        if (!r.ok) throw new ConnectorError(r.code === 'READ_ONLY' ? 'READ_ONLY' : 'FAILED', r.error);
        res = r.result as OperationResult;
      } else {
        const secrets = await this.secretsOf(c);
        res = await this.registry.run({ connector: this.record(c), secrets, allowPrivateNetwork: this.privateAllowed() }, { entity: ref, kind, params, limits });
      }
      await this.calls.create({ orgId: c.orgId, connectorId: c.id, entity: entity.key, kind, actor, ok: true, durationMs: res.durationMs, rows: res.rows.length || res.affected || 0 });
      orgLog.debug(c.orgId, 'connectors', `${c.name}: ${kind} ${entity.label}`, { connector: c.name, type: c.type, table: entity.key, kind, rows: res.rows.length || res.affected || 0, ms: res.durationMs, by: actor });
      return res;
    } catch (e) {
      const msg = e instanceof ConnectorError ? e.message : e instanceof HttpException ? e.message : 'failed';
      await this.calls.create({ orgId: c.orgId, connectorId: c.id, entity: entity.key, kind, actor, ok: false, durationMs: Date.now() - start, error: msg.slice(0, 200) });
      orgLog.error(c.orgId, 'connectors', `${c.name}: ${kind} ${entity.label} failed - ${msg.slice(0, 200)}`, { connector: c.name, type: c.type, table: entity.key, kind, ms: Date.now() - start, by: actor });
      if (e instanceof HttpException) throw e; // e.g. 503 when the gateway is offline
      throw e instanceof ConnectorError && e.code === 'READ_ONLY' ? new ForbiddenException(msg) : new BadRequestException(msg);
    }
  }

  private async byRef(orgId: string, ref: string) {
    if (!REF.test(ref)) return null;
    return this.connectors.findOne({ orgId, ref, isDeleted: false }).lean<Connector>();
  }

  /** Dropdown / prefill sources the caller may bind (connector.use). */
  async sources(auth: AuthContext): Promise<ConnectorSource[]> {
    const views = await this.list(auth);
    const all = new Map<string, string[]>(views.flatMap((v) => v.entities.map((e): [string, string[]] => [`/connectors/${v.ref}/${e.key}`, e.fields])));
    return views
      .filter((v) => v.permissions.use)
      .flatMap((v) =>
        v.entities
          .filter((e) => e.operations.includes('list'))
          .map((e) => ({
            key: `/connectors/${v.ref}/${e.key}`,
            name: `${v.name} · ${e.label}`,
            connectorId: v.id,
            params: e.fields,
            valueField: e.valueField || undefined,
            labelField: e.labelField || undefined,
            // The lists that come along with a row, and what each of their rows holds, so the builder can offer them.
            ...(e.related?.length ? { related: e.related.map((r) => ({ name: r.name, fields: all.get(r.source) ?? [] })) } : {}),
          })),
      );
  }

  /** Rows for a bound source. `actor` records who asked (user, public form or automation). */
  async readSource(orgId: string, key: string, params: Record<string, unknown>, actor: string): Promise<Record<string, unknown>[]> {
    const m = SOURCE_KEY.exec(key);
    const c = m ? await this.byRef(orgId, m[1]!) : null;
    const entity = c?.entities.find((e) => e.key === m![2]);
    if (!c || !entity) throw new NotFoundException(`No data source is available at ${key.slice(0, 100)}`);
    // Empty filters mean "any" (a parent dropdown not chosen yet).
    const filters = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== '' && v !== undefined));
    const rows = (await this.run(c, entity, 'list', filters, actor)).rows;
    // Related rows come along when a few rows were found (a look-up), never with a long list (a dropdown's options).
    if (!entity.related?.length || !rows.length || rows.length > RELATED_FOR_AT_MOST) return rows;
    return Promise.all(
      rows.map(async (row) => {
        const out: Record<string, unknown> = { ...row };
        for (const r of entity.related) {
          const m = SOURCE_KEY.exec(r.source);
          const from = m ? (m[1] === c.ref ? c : await this.byRef(orgId, m[1]!)) : null;
          const other = from?.entities.find((e) => e.key === m![2]);
          const value = row[r.equals];
          // Nothing to match on, or the other table is no longer exposed: an empty list, not a failed look-up.
          out[r.name] = !from || !other || !other.operations.includes('list') || value === null || value === undefined || value === '' || typeof value === 'object' ? [] : (await this.run(from, other, 'list', { [r.field]: value }, actor, RELATED_LIMITS)).rows;
        }
        return out;
      }),
    );
  }

  /** The signed-in preview in the builder: only sources the caller may use. */
  async querySource(auth: AuthContext, key: string, params: Record<string, unknown>) {
    const m = SOURCE_KEY.exec(key);
    const c = m ? await this.byRef(auth.orgId, m[1]!) : null;
    if (!c || !(await this.perms(auth, c)).use) throw new NotFoundException('Data source not found');
    return this.readSource(auth.orgId, key, params, auth.userId);
  }

  // ---------------------------------------------------------------- signing in as a person

  /** The address our API is called back at once the person has agreed. It is what the other system must be told to allow. */
  private signInReturn() {
    return `${this.config.API_URL.replace(/\/+$/, '')}/connectors/oauth/callback`;
  }

  /** A note carried through the other system and back, signed so that only one we made is accepted, and only for ten minutes. */
  private signState(c: Pick<Connector, 'id' | 'orgId'>, userId: string) {
    const body = Buffer.from(JSON.stringify({ c: c.id, o: c.orgId, u: userId, e: Date.now() + 10 * 60_000 })).toString('base64url');
    return `${body}.${createHmac('sha256', Buffer.from(this.config.SECRET_KEY, 'base64')).update(`connector-sign-in:${body}`).digest('base64url')}`;
  }

  private readState(state: unknown): { c: string; o: string; u: string } | null {
    if (typeof state !== 'string' || state.length > 2000) return null;
    const [body, mark] = state.split('.');
    if (!body || !mark) return null;
    const expected = createHmac('sha256', Buffer.from(this.config.SECRET_KEY, 'base64')).update(`connector-sign-in:${body}`).digest('base64url');
    if (expected.length !== mark.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mark))) return null;
    try {
      const read = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { c?: unknown; o?: unknown; u?: unknown; e?: unknown };
      if (typeof read.c !== 'string' || typeof read.o !== 'string' || typeof read.u !== 'string' || typeof read.e !== 'number' || read.e < Date.now()) return null;
      return { c: read.c, o: read.o, u: read.u };
    } catch {
      return null;
    }
  }

  /**
   * "Sign in" on a connector that signs in as a person: where to send them. They agree at the other system,
   * which sends them back to us with a code.
   */
  async signInStart(auth: AuthContext, id: string) {
    const c = await this.mustGet(auth, id, 'manage');
    const s = c.settings as { auth?: string; authUrl?: string; clientId?: string; scope?: string };
    if (c.gatewayId) throw new BadRequestException("This connector's credentials live on its gateway agent");
    if (s.auth !== 'oauthUser' || !s.authUrl || !s.clientId) throw new BadRequestException('This connector does not sign in as a person. Set how it signs in, the sign-in address and the client ID first.');
    let url: URL;
    try {
      url = new URL(s.authUrl);
    } catch {
      throw new BadRequestException('The sign-in address is not a web address');
    }
    if (url.protocol !== 'https:' && !this.privateAllowed()) throw new BadRequestException('The sign-in address must start with https://');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', s.clientId);
    url.searchParams.set('redirect_uri', this.signInReturn());
    if (s.scope) url.searchParams.set('scope', s.scope);
    url.searchParams.set('state', this.signState(c, auth.userId));
    return { url: url.toString(), returnAddress: this.signInReturn() };
  }

  /**
   * The person is back from the other system. The note we sent with them says which connector this is for;
   * the code is exchanged for a lasting sign-in, which is sealed with the connector's other credentials.
   * Returns where to send their browser next (always a page of ours), saying how it went.
   */
  async signInFinish(state: unknown, code: unknown, refused?: unknown): Promise<string> {
    const page = (how: 'signedIn' | 'signInFailed', text: string) => `${this.config.APP_URL.replace(/\/+$/, '')}/connectors?${how}=${encodeURIComponent(text.slice(0, 200))}`;
    const note = this.readState(state);
    if (!note) return page('signInFailed', 'That sign-in was not started here, or took too long. Start it again from the connector.');
    const c = await this.connectors.findOne({ id: note.c, orgId: note.o, isDeleted: false });
    if (!c) return page('signInFailed', 'That connector is no longer there.');
    if (typeof refused === 'string' && refused) return page('signInFailed', `${c.name}: the other system did not allow it (${refused.replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 60)}).`);
    if (typeof code !== 'string' || !code || code.length > 4000) return page('signInFailed', `${c.name}: the other system sent nothing to sign in with.`);
    try {
      const secrets = await this.secretsOf(c);
      const refreshToken = await this.withTimeout((signal) =>
        lastingSignIn({ connector: this.record(c), secrets, signal, allowPrivateNetwork: this.privateAllowed() }, c.settings as { tokenUrl?: string; clientId?: string }, code, this.signInReturn()),
      );
      c.set(await this.seal(c, { ...secrets, refreshToken }));
      c.set({ lastTest: null });
      await c.save();
      await this.audit.record({ orgId: c.orgId, actorId: note.u, ip: '', userAgent: 'returned from the other system' }, { action: 'connector.signed_in', targetType: 'connector', targetId: c.id });
      return page('signedIn', c.name);
    } catch (e) {
      return page('signInFailed', `${c.name}: ${e instanceof ConnectorError ? e.message : 'the sign-in could not be completed'}`);
    }
  }

  /**
   * "Try it" for a write: adds one row to an exposed table with the values typed, exactly as a workflow step
   * would, and says what came back. It really writes, so it is for whoever manages the connector, and only
   * where the connector allows writes and the table is exposed for adding rows.
   */
  async tryInsert(auth: AuthContext, id: string, entityKey: string, values: Record<string, unknown>) {
    const c = await this.mustGet(auth, id, 'manage');
    if (!c.writable) throw new BadRequestException(`${c.name} is read only. Allow writes first.`);
    const entity = c.entities.find((e) => e.key === entityKey);
    if (!entity || !entity.operations.includes('insert')) throw new BadRequestException('That table is not exposed for adding rows');
    const row = Object.fromEntries(Object.entries(values).filter(([k, v]) => entity.fields.includes(k) && v !== '' && v !== null && v !== undefined));
    if (!Object.keys(row).length) throw new BadRequestException('Type a value for at least one of its fields');
    try {
      const res = await this.run(c, entity, 'insert', row, `user:${auth.userId}`);
      return { added: res.affected ?? 1, row: res.rows[0] ?? null };
    } catch (e) {
      throw new BadRequestException(e instanceof ConnectorError ? e.message : `It could not be added (${(e as Error).name})`);
    }
  }

  /** Write operations offered as automation steps. */
  async actions(orgId: string): Promise<ConnectorAction[]> {
    const rows = await this.connectors.find({ orgId, isDeleted: false, writable: true }).lean<Connector[]>();
    return rows.flatMap((c) =>
      c.entities.flatMap((e) =>
        e.operations
          .filter((op) => WRITE_OPERATIONS.includes(op))
          .map((op) => ({
            key: `c-${c.ref}-${actionHash(e.key, op)}`,
            label: `${c.name}: ${op} ${e.label}`,
            description: `Sends the answers to ${e.label} (fields: ${e.fields.join(', ')})`,
            outputs: ['id'],
            // A file or a log line takes the whole response; a row takes one answer per field.
            ...(op === 'insert' || op === 'update' ? { inputs: e.fields } : {}),
          })),
      ),
    );
  }

  async actionExists(orgId: string, key: string) {
    return (await this.actions(orgId)).some((a) => a.key === key);
  }

  /** Run a write step: the form's answers (and work fields) go to the exposed fields with the same names. */
  async runAction(orgId: string, key: string, values: Record<string, unknown>, formCode: string, map?: Record<string, string>, file?: ResponseFiles) {
    const m = ACTION_KEY.exec(key);
    const c = m ? await this.byRef(orgId, m[1]!) : null;
    if (!c || !c.writable) throw new Error('This connector step is not available any more');
    for (const e of c.entities) {
      for (const op of e.operations) {
        if (WRITE_OPERATIONS.includes(op) && actionHash(e.key, op) === m![2]) {
          // Each exposed field takes the answer the designer chose for it, or the one whose name matches.
          // A place files are kept gets the response under its form and reference: the answers, the PDF, and what
          // the respondent uploaded, as far as that fits (through a gateway much less does).
          let named: Record<string, unknown> = {};
          let leftOut = 0;
          if (op === 'upload' && file) {
            const room = c.gatewayId ? MAX_COPY_BYTES_GATEWAY : MAX_COPY_BYTES;
            const attachments = await file.attachments(room).catch(() => ({ files: [], leftOut: 0 }));
            leftOut = attachments.leftOut;
            named = { name: file.name, pdf: (await file.pdf().catch(() => null))?.toString('base64'), attachments: attachments.files.map((a) => ({ name: a.name, type: a.type, content: a.content.toString('base64') })) };
          }
          const res = await this.run(c, e, op, op === 'upload' || op === 'log' ? { data: values, ...named } : mappedValues(e.fields, values, map), `automation:${formCode}`, op === 'upload' ? UPLOAD_LIMITS : undefined);
          if (op === 'upload') {
            const count = res.affected ?? 1;
            return { summary: `saved ${count} ${count === 1 ? 'file' : 'files'} in ${c.name}${leftOut ? ` (${leftOut} uploaded ${leftOut === 1 ? 'file was' : 'files were'} not copied: too large together, or no longer there)` : ''}`, data: { id: String(res.rows[0]?.id ?? res.rows[0]?.key ?? '') } };
          }
          // The new row's identifier, whatever that system calls it.
          const row = res.rows[0] ?? {};
          const id = row.id ?? row.Id ?? (e.keyField ? row[e.keyField] : undefined);
          return { summary: `${op} ${e.label} in ${c.name}`, data: { id: typeof id === 'string' || typeof id === 'number' ? String(id) : '' } };
        }
      }
    }
    throw new Error('This connector step is not available any more');
  }

  async assertExists(orgId: string, id: string) {
    if (!(await this.connectors.exists({ orgId, id, isDeleted: false }))) throw new NotFoundException('Connector not found');
  }
}
