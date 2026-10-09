import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { InjectModel } from '@nestjs/mongoose';
import { GATEWAY_WS_PATH, type ConnectorRecord, type GatewayRequest, type GatewayResponse, type OperationRequest } from '@fb/connectors';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Model } from 'mongoose';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAllowed } from '../access/roles';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { hashToken, newId, randomToken } from '../common/crypto';
import { PlansService } from '../plans/plans.service';
import { Gateway, GatewayCall, type GatewayCallDocument, type GatewayDocument } from './gateway.schema';

const REGISTRATION_TTL_MS = 24 * 3600_000;
const CALL_TIMEOUT_MS = 30_000;
/** How often a process looks for calls passed to it, and a caller for its answer. */
const RELAY_POLL_MS = 100;
/** An agent is pinged every 30 seconds; one not heard from for this long is taken to be gone. */
const STALE_MS = 75_000;

interface Live {
  ws: WebSocket;
  orgId: string;
  pending: Map<string, { resolve: (r: GatewayResponse) => void; timer: NodeJS.Timeout }>;
}

/**
 * Gateway agents and the live connections to them. Agents connect out to
 * us (WebSocket upgrade on GATEWAY_WS_PATH) with their secret; connector
 * calls for gateway connectors are sent down that connection.
 */
@Injectable()
export class GatewaysService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Gateways');
  private readonly live = new Map<string, Live>();
  private wss?: WebSocketServer;
  /** This process, among the several that may be running. */
  private readonly instanceId = newId();
  private relay?: NodeJS.Timeout;
  private relaying = false;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly audit: AuditService,
    private readonly plans: PlansService,
    @InjectModel(Gateway.name) private readonly gateways: Model<GatewayDocument>,
    @InjectModel(GatewayCall.name) private readonly calls: Model<GatewayCallDocument>,
  ) {}

  onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!req.url?.startsWith(GATEWAY_WS_PATH)) return;
      void this.accept(req, socket, head);
    });
    // Calls made on other processes for gateways connected here are picked up from the database.
    this.relay = setInterval(() => void this.runRelayed().catch((e: Error) => this.logger.warn(`relay failed: ${e.message}`)), RELAY_POLL_MS);
    this.relay.unref?.();
  }

  async onModuleDestroy() {
    if (this.relay) clearInterval(this.relay);
    // So that other processes stop passing calls here at once, not when the last heartbeat grows old.
    await this.gateways.updateMany({ instanceId: this.instanceId }, { $set: { instanceId: '' } }).catch(() => undefined);
    for (const g of this.live.values()) g.ws.close(1001, 'Server shutting down');
    this.wss?.close();
  }

  private async accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const header = req.headers.authorization ?? '';
    const secret = header.startsWith('Bearer ') ? header.slice(7) : '';
    const gw = secret ? await this.gateways.findOne({ secretHash: hashToken(secret), revokedAt: null }).lean() : null;
    if (!gw) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      this.live.get(gw.id)?.ws.close(4000, 'Replaced by a new connection');
      const entry: Live = { ws, orgId: gw.orgId, pending: new Map() };
      this.live.set(gw.id, entry);
      // (A query does nothing until it is run: hence exec.)
      void this.gateways.updateOne({ id: gw.id }, { $set: { lastSeenAt: new Date(), instanceId: this.instanceId, version: String(req.headers['x-gateway-version'] ?? '').slice(0, 40) } }).exec().catch(() => undefined);
      this.logger.log(`gateway ${gw.id} connected (org ${gw.orgId})`);
      ws.on('message', (data) => {
        let msg: GatewayResponse;
        try {
          msg = JSON.parse(String(data)) as GatewayResponse;
        } catch {
          return;
        }
        const p = entry.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        entry.pending.delete(msg.id);
        p.resolve(msg);
      });
      ws.on('pong', () => void this.gateways.updateOne({ id: gw.id }, { $set: { lastSeenAt: new Date() } }).exec().catch(() => undefined));
      const ping = setInterval(() => ws.ping(), 30_000);
      ws.on('close', () => {
        clearInterval(ping);
        if (this.live.get(gw.id)?.ws === ws) {
          this.live.delete(gw.id);
          // Only if it is still ours: the agent may already have connected to another process.
          void this.gateways.updateOne({ id: gw.id, instanceId: this.instanceId }, { $set: { instanceId: '' } }).catch(() => undefined);
        }
        for (const p of entry.pending.values()) {
          clearTimeout(p.timer);
          p.resolve({ id: '', ok: false, error: 'The gateway disconnected', code: 'FAILED' });
        }
      });
    });
  }

  /**
   * Send one request to a gateway and wait for its answer. If the agent is
   * connected to another API process (or this is the worker, which holds no
   * connections), the request is handed to that process through the database.
   */
  async call(orgId: string, gatewayId: string, op: GatewayRequest['op'], connector: ConnectorRecord & { ref: string }, request?: OperationRequest): Promise<GatewayResponse> {
    if (this.live.get(gatewayId)?.orgId === orgId) return this.callLocal(orgId, gatewayId, { op, connector, request });
    if (!(await this.connectedElsewhere(orgId, gatewayId))) throw new ServiceUnavailableException("The connector's gateway is not connected");
    const id = newId();
    await this.calls.create({ id, orgId, gatewayId, request: { op, connector, request } });
    const until = Date.now() + CALL_TIMEOUT_MS + 2_000;
    try {
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, RELAY_POLL_MS));
        const done = await this.calls.findOne({ id, status: 'DONE' }).select('response').lean();
        if (done) return done.response as unknown as GatewayResponse;
      }
      return { id, ok: false, error: 'The gateway did not answer in time', code: 'TIMEOUT' };
    } finally {
      // What was asked and answered is not kept.
      void this.calls.deleteOne({ id }).catch(() => undefined);
    }
  }

  /** Down the connection this process holds. */
  private async callLocal(orgId: string, gatewayId: string, body: Pick<GatewayRequest, 'op' | 'connector' | 'request'>): Promise<GatewayResponse> {
    const g = this.live.get(gatewayId);
    if (!g || g.orgId !== orgId) return { id: '', ok: false, error: "The connector's gateway is not connected", code: 'FAILED' };
    // Revoked on another API instance: that one closed its socket, this one learns it here.
    if (!(await this.gateways.exists({ id: gatewayId, orgId, revokedAt: null }))) {
      g.ws.close(4001, 'Revoked');
      this.live.delete(gatewayId);
      throw new ServiceUnavailableException("The connector's gateway is not connected");
    }
    const id = newId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        g.pending.delete(id);
        resolve({ id, ok: false, error: 'The gateway did not answer in time', code: 'TIMEOUT' });
      }, CALL_TIMEOUT_MS);
      g.pending.set(id, { resolve, timer });
      g.ws.send(JSON.stringify({ id, ...body } satisfies GatewayRequest));
    });
  }

  /** Runs calls other processes left for gateways connected here. Each call is taken by exactly one process. */
  private async runRelayed() {
    if (this.relaying || !this.live.size) return;
    this.relaying = true;
    try {
      for (;;) {
        const job = await this.calls.findOneAndUpdate({ gatewayId: { $in: [...this.live.keys()] }, status: 'PENDING' }, { $set: { status: 'RUNNING' } }).lean();
        if (!job) return;
        // Not awaited one by one: a slow database behind one gateway must not hold up another.
        void this.callLocal(job.orgId, job.gatewayId, job.request as unknown as Pick<GatewayRequest, 'op' | 'connector' | 'request'>)
          .catch((e: Error): GatewayResponse => ({ id: '', ok: false, error: e.message, code: 'FAILED' }))
          .then((response) => this.calls.updateOne({ id: job.id }, { $set: { status: 'DONE', response } }))
          .catch((e: Error) => this.logger.warn(`could not answer relayed call ${job.id}: ${e.message}`));
      }
    } finally {
      this.relaying = false;
    }
  }

  /** Held by another process that has been heard from lately. */
  private async connectedElsewhere(orgId: string, gatewayId: string): Promise<boolean> {
    return !!(await this.gateways.exists({ id: gatewayId, orgId, revokedAt: null, instanceId: { $nin: ['', this.instanceId] }, lastSeenAt: { $gt: new Date(Date.now() - STALE_MS) } }));
  }

  /** Connected to this process or to another one. */
  async isConnected(orgId: string, gatewayId: string): Promise<boolean> {
    return this.live.get(gatewayId)?.orgId === orgId || this.connectedElsewhere(orgId, gatewayId);
  }

  // ---------------------------------------------------------------- management

  private assertManager(auth: AuthContext) {
    if (!isAllowed(auth.role, [], 'connector.manage')) throw new ForbiddenException("You don't have permission to do that");
  }

  async list(auth: AuthContext) {
    this.assertManager(auth);
    const rows = await this.gateways.find({ orgId: auth.orgId, revokedAt: null }).sort({ name: 1 }).lean();
    return Promise.all(rows.map(async (g) => ({ id: g.id, name: g.name, registered: !!g.registeredAt, connected: await this.isConnected(auth.orgId, g.id), lastSeenAt: g.lastSeenAt, version: g.version })));
  }

  /** A new gateway and its one-time registration token (shown once). */
  async create(auth: AuthContext, name: string) {
    this.assertManager(auth);
    await this.plans.assertCanAdd(auth.orgId, 'gateways');
    const token = `fbreg_${randomToken()}`;
    const id = newId();
    await this.gateways.create({ id, orgId: auth.orgId, name, registrationHash: hashToken(token), registrationExpiresAt: new Date(Date.now() + REGISTRATION_TTL_MS), createdBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'gateway.created', targetType: 'gateway', targetId: id, after: { name } });
    return { id, name, registrationToken: token, expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS) };
  }

  /** The agent trades its one-time token for a long-lived secret (returned once; only its hash is kept). */
  async register(token: string) {
    const gw = await this.gateways.findOne({ registrationHash: hashToken(token), registrationExpiresAt: { $gt: new Date() }, revokedAt: null });
    if (!gw) throw new BadRequestException('This registration token is not valid any more');
    const secret = `fbgw_${randomToken()}${randomToken()}`;
    gw.set({ secretHash: hashToken(secret), registrationHash: '', registrationExpiresAt: null, registeredAt: new Date() });
    await gw.save();
    await this.audit.record({ orgId: gw.orgId, actorId: `gateway:${gw.id}` }, { action: 'gateway.registered', targetType: 'gateway', targetId: gw.id });
    return { gatewayId: gw.id, secret };
  }

  async revoke(auth: AuthContext, id: string) {
    this.assertManager(auth);
    const res = await this.gateways.updateOne({ orgId: auth.orgId, id, revokedAt: null }, { $set: { revokedAt: new Date(), secretHash: '', instanceId: '' } });
    if (!res.matchedCount) throw new NotFoundException('Gateway not found');
    this.live.get(id)?.ws.close(4001, 'Revoked');
    this.live.delete(id);
    await this.audit.record(actorOf(auth), { action: 'gateway.revoked', targetType: 'gateway', targetId: id });
    return { revoked: true };
  }

  async assertUsable(orgId: string, id: string) {
    if (!(await this.gateways.exists({ orgId, id, revokedAt: null }))) throw new BadRequestException('Unknown gateway');
  }
}
