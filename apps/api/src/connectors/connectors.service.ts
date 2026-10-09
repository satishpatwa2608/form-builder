import { mappedValues } from '@fb/engine';
import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeMongoConnections,
  closeSqlConnections,
  ConnectorError,
  defaultRegistry,
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
  private async run(c: Connector, entity: ExposedEntity, kind: OperationKind, params: Record<string, unknown>, actor: string): Promise<OperationResult> {
    if (!entity.operations.includes(kind)) throw new ForbiddenException(`${kind} is not allowed on ${entity.label}`);
    const ref: EntityRef = { key: entity.key, fields: entity.fields, keyField: entity.keyField || undefined };
    const start = Date.now();
    try {
      let res: OperationResult;
      if (c.gatewayId) {
        // The same checks run on the agent (registry.run); these are ours first.
        if (WRITE_OPERATIONS.includes(kind) && !c.writable) throw new ConnectorError('READ_ONLY', `"${c.name}" is read-only`);
        const r = await this.gateways.call(c.orgId, c.gatewayId, 'run', { ...this.record(c), ref: c.ref }, { entity: ref, kind, params, limits: LIMITS });
        if (!r.ok) throw new ConnectorError(r.code === 'READ_ONLY' ? 'READ_ONLY' : 'FAILED', r.error);
        res = r.result as OperationResult;
      } else {
        const secrets = await this.secretsOf(c);
        res = await this.registry.run({ connector: this.record(c), secrets, allowPrivateNetwork: this.privateAllowed() }, { entity: ref, kind, params, limits: LIMITS });
      }
      await this.calls.create({ orgId: c.orgId, connectorId: c.id, entity: entity.key, kind, actor, ok: true, durationMs: res.durationMs, rows: res.rows.length || res.affected || 0 });
      return res;
    } catch (e) {
      const msg = e instanceof ConnectorError ? e.message : e instanceof HttpException ? e.message : 'failed';
      await this.calls.create({ orgId: c.orgId, connectorId: c.id, entity: entity.key, kind, actor, ok: false, durationMs: Date.now() - start, error: msg.slice(0, 200) });
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
    return views
      .filter((v) => v.permissions.use)
      .flatMap((v) =>
        v.entities
          .filter((e) => e.operations.includes('list'))
          .map((e) => ({ key: `/connectors/${v.ref}/${e.key}`, name: `${v.name} · ${e.label}`, connectorId: v.id, params: e.fields, valueField: e.valueField || undefined, labelField: e.labelField || undefined })),
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
    return (await this.run(c, entity, 'list', filters, actor)).rows;
  }

  /** The signed-in preview in the builder: only sources the caller may use. */
  async querySource(auth: AuthContext, key: string, params: Record<string, unknown>) {
    const m = SOURCE_KEY.exec(key);
    const c = m ? await this.byRef(auth.orgId, m[1]!) : null;
    if (!c || !(await this.perms(auth, c)).use) throw new NotFoundException('Data source not found');
    return this.readSource(auth.orgId, key, params, auth.userId);
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
  async runAction(orgId: string, key: string, values: Record<string, unknown>, formCode: string, map?: Record<string, string>, file?: { name: string; pdf: () => Promise<Buffer | null> }) {
    const m = ACTION_KEY.exec(key);
    const c = m ? await this.byRef(orgId, m[1]!) : null;
    if (!c || !c.writable) throw new Error('This connector step is not available any more');
    for (const e of c.entities) {
      for (const op of e.operations) {
        if (WRITE_OPERATIONS.includes(op) && actionHash(e.key, op) === m![2]) {
          // Each exposed field takes the answer the designer chose for it, or the one whose name matches.
          // A file store other than S3 gets the response under its reference, with its PDF beside it. (S3 keeps the
          // dated names it has always used.)
          const named = op === 'upload' && file && c.type !== 'aws-s3' ? { name: file.name, pdf: (await file.pdf().catch(() => null))?.toString('base64') } : {};
          const res = await this.run(c, e, op, op === 'upload' || op === 'log' ? { data: values, ...named } : mappedValues(e.fields, values, map), `automation:${formCode}`);
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
