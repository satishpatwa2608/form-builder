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
import { Gateway, type GatewayDocument } from './gateway.schema';

const REGISTRATION_TTL_MS = 24 * 3600_000;
const CALL_TIMEOUT_MS = 30_000;

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

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly audit: AuditService,
    private readonly plans: PlansService,
    @InjectModel(Gateway.name) private readonly gateways: Model<GatewayDocument>,
  ) {}

  onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    if (!server) return;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!req.url?.startsWith(GATEWAY_WS_PATH)) return;
      void this.accept(req, socket, head);
    });
  }

  async onModuleDestroy() {
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
      void this.gateways.updateOne({ id: gw.id }, { $set: { lastSeenAt: new Date(), version: String(req.headers['x-gateway-version'] ?? '').slice(0, 40) } });
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
      ws.on('pong', () => void this.gateways.updateOne({ id: gw.id }, { $set: { lastSeenAt: new Date() } }));
      const ping = setInterval(() => ws.ping(), 30_000);
      ws.on('close', () => {
        clearInterval(ping);
        if (this.live.get(gw.id)?.ws === ws) this.live.delete(gw.id);
        for (const p of entry.pending.values()) {
          clearTimeout(p.timer);
          p.resolve({ id: '', ok: false, error: 'The gateway disconnected', code: 'FAILED' });
        }
      });
    });
  }

  /** Send one request to a gateway and wait for its answer. */
  async call(orgId: string, gatewayId: string, op: GatewayRequest['op'], connector: ConnectorRecord & { ref: string }, request?: OperationRequest): Promise<GatewayResponse> {
    const g = this.live.get(gatewayId);
    if (!g || g.orgId !== orgId) throw new ServiceUnavailableException("The connector's gateway is not connected");
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
      g.ws.send(JSON.stringify({ id, op, connector, request } satisfies GatewayRequest));
    });
  }

  isConnected(orgId: string, gatewayId: string) {
    return this.live.get(gatewayId)?.orgId === orgId;
  }

  // ---------------------------------------------------------------- management

  private assertManager(auth: AuthContext) {
    if (!isAllowed(auth.role, [], 'connector.manage')) throw new ForbiddenException("You don't have permission to do that");
  }

  async list(auth: AuthContext) {
    this.assertManager(auth);
    const rows = await this.gateways.find({ orgId: auth.orgId, revokedAt: null }).sort({ name: 1 }).lean();
    return rows.map((g) => ({ id: g.id, name: g.name, registered: !!g.registeredAt, connected: this.isConnected(auth.orgId, g.id), lastSeenAt: g.lastSeenAt, version: g.version }));
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
    const res = await this.gateways.updateOne({ orgId: auth.orgId, id, revokedAt: null }, { $set: { revokedAt: new Date(), secretHash: '' } });
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
