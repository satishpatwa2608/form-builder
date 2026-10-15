import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { CreateRepositoryCommand, DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand, PutLifecyclePolicyCommand } from '@aws-sdk/client-ecr';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import { hashToken, newId, randomToken } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config';
import { orgLog } from '../logs/org-log';
import { PlansService } from '../plans/plans.service';
import { ExtensionDeployKey, type ExtensionDeployKeyDocument } from './extension-deploy-key.schema';
import { ExtensionDeploy, type ExtensionDeployDocument } from './extension-deploy.schema';

/** Who is asking: a signed-in administrator, or the organisation's pipeline showing its deploy key. */
export interface DeployCaller {
  orgId: string;
  userId: string;
  ip: string;
  userAgent: string;
}
const KEY_PREFIX = 'fbd_';

/** The image store, as much of it as this service uses. Swapped for a stand-in in tests. */
export interface ImageStore {
  /** Makes the organisation's own space if it is not there yet. */
  ensureSpace(repository: string): Promise<void>;
  /** A password that can push to that one space and nowhere else, for an hour. */
  pushPassword(repository: string): Promise<{ password: string; expiresAt: Date }>;
  images(repository: string): Promise<{ tag: string; pushedAt: Date | null; sizeMb: number }[]>;
}
export const IMAGE_STORE = Symbol('IMAGE_STORE');

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An organisation's space in the image store. Its id is the whole of the name, so one can never be mistaken for another. */
export const spaceOf = (orgId: string) => `fb-ext/${orgId}`;

/** Amazon ECR, with the server's own role. The push password comes from a second role narrowed to one space. */
export class EcrImageStore implements ImageStore {
  private readonly ecr: ECRClient;
  private readonly sts: STSClient;
  constructor(
    private readonly region: string,
    private readonly account: string,
    private readonly pushRoleArn: string,
  ) {
    this.ecr = new ECRClient({ region });
    this.sts = new STSClient({ region });
  }

  async ensureSpace(repository: string) {
    try {
      await this.ecr.send(new CreateRepositoryCommand({ repositoryName: repository, imageScanningConfiguration: { scanOnPush: true }, tags: [{ Key: 'Project', Value: 'form-builder-pilot' }] }));
    } catch (e) {
      if ((e as { name?: string }).name === 'RepositoryAlreadyExistsException') return;
      throw e;
    }
    // The last ten versions are kept; older ones go, so a space does not grow without end.
    const rule = { rulePriority: 1, description: 'Keep the last ten versions', selection: { tagStatus: 'any', countType: 'imageCountMoreThan', countNumber: 10 }, action: { type: 'expire' } };
    await this.ecr.send(new PutLifecyclePolicyCommand({ repositoryName: repository, lifecyclePolicyText: JSON.stringify({ rules: [rule] }) })).catch(() => undefined);
  }

  async pushPassword(repository: string) {
    const arn = `arn:aws:ecr:${this.region}:${this.account}:repository/${repository}`;
    // The role may push to any customer's space; this session of it may push to this one only.
    const assumed = await this.sts.send(
      new AssumeRoleCommand({
        RoleArn: this.pushRoleArn,
        RoleSessionName: `push-${repository.slice(-36)}`.slice(0, 64),
        DurationSeconds: 3600,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
            { Effect: 'Allow', Action: ['ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'], Resource: arn },
          ],
        }),
      }),
    );
    const c = assumed.Credentials!;
    const scoped = new ECRClient({ region: this.region, credentials: { accessKeyId: c.AccessKeyId!, secretAccessKey: c.SecretAccessKey!, sessionToken: c.SessionToken! } });
    const token = (await scoped.send(new GetAuthorizationTokenCommand({}))).authorizationData?.[0]?.authorizationToken;
    if (!token) throw new Error('no authorization token');
    // "AWS:<password>", base64. The password stops working when the session does.
    return { password: Buffer.from(token, 'base64').toString('utf8').replace(/^AWS:/, ''), expiresAt: c.Expiration ?? new Date(Date.now() + 3600_000) };
  }

  async images(repository: string) {
    const out = await this.ecr.send(new DescribeImagesCommand({ repositoryName: repository, maxResults: 100 })).catch((e: { name?: string }) => {
      if (e.name === 'RepositoryNotFoundException') return { imageDetails: [] };
      throw e;
    });
    return (out.imageDetails ?? []).flatMap((d) => (d.imageTags ?? []).map((tag) => ({ tag, pushedAt: d.imagePushedAt ?? null, sizeMb: Math.round(((d.imageSizeInBytes ?? 0) / 1_048_576) * 10) / 10 })));
  }
}

/**
 * A customer deploying their own extension, by themselves: they push an image to their own space in our
 * image store and ask for it to run. This service hands out the push password, lists what they have pushed,
 * and writes the request down. It starts nothing: only the server's deploy service can start a container.
 */
@Injectable()
export class ExtensionDeployService {
  private readonly logger = new Logger(ExtensionDeployService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(IMAGE_STORE) private readonly store: ImageStore | null,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    @InjectModel(ExtensionDeploy.name) private readonly deploys: Model<ExtensionDeployDocument>,
    @InjectModel(ExtensionDeployKey.name) private readonly keys: Model<ExtensionDeployKeyDocument>,
  ) {}

  private readonly finished: ((deployId: string) => Promise<void>)[] = [];
  /** Told when a deployment finishes, however it went (the builds that lead to deployments listen). */
  onFinished(listener: (deployId: string) => Promise<void>) {
    this.finished.push(listener);
  }

  isAvailable() {
    return !!this.store && !!this.registry;
  }

  async assertIncluded(orgId: string) {
    await this.allowed(orgId);
  }

  /** A push sign-in for an organisation's own space, for a build of its own repository (never shown to a person). */
  async pushLoginFor(orgId: string) {
    const store = this.available();
    const repository = spaceOf(orgId);
    await store.ensureSpace(repository);
    const { password } = await store.pushPassword(repository);
    return { registry: this.registry, image: `${this.registry}/${repository}`, password, platform: this.config.EXT_PLATFORM };
  }

  private get registry() {
    return this.config.EXT_REGISTRY;
  }

  private available(): ImageStore {
    if (!this.store || !this.registry) throw new ServiceUnavailableException('Deploying your own code is not switched on for this installation. Ask whoever provides Form Builder to you.');
    return this.store;
  }

  private async allowed(orgId: string) {
    if (((await this.plans.limitsOf(orgId)).extensions ?? 1) < 1) throw new BadRequestException('Your plan does not include extensions.');
  }

  /** Where the page stands: whether this can be done here, what was asked for lately, and how it went. */
  async status(auth: DeployCaller) {
    const rows = await this.deploys.find({ orgId: auth.orgId }).sort({ createdAt: -1 }).limit(10).lean();
    const included = ((await this.plans.limitsOf(auth.orgId)).extensions ?? 1) >= 1;
    const key = await this.keys.findOne({ orgId: auth.orgId }).lean();
    return {
      available: !!this.store && !!this.registry,
      included,
      // The machine the code will run on: an image built for another kind will not start.
      platform: this.config.EXT_PLATFORM,
      // For a pipeline: where it calls, and whether the organisation has given it a key.
      api: this.config.API_URL,
      key: key ? { hint: key.hint, createdAt: key.createdAt ?? null, lastUsedAt: key.lastUsedAt } : null,
      deploys: rows.map((r) => ({ id: r.id, kind: r.kind, tag: r.tag, status: r.status, message: r.message, output: r.output, at: r.createdAt ?? null, finishedAt: r.finishedAt })),
    };
  }

  /** A password to push with, good for an hour and for this organisation's space alone. Shown once. */
  async pushLogin(auth: DeployCaller) {
    const store = this.available();
    await this.allowed(auth.orgId);
    const repository = spaceOf(auth.orgId);
    try {
      await store.ensureSpace(repository);
      const { password, expiresAt } = await store.pushPassword(repository);
      await this.audit.record(actorOf(auth), { action: 'extension.push_login', targetType: 'organization', targetId: auth.orgId });
      return { registry: this.registry, image: `${this.registry}/${repository}`, username: 'AWS', password, expiresAt, platform: this.config.EXT_PLATFORM };
    } catch (e) {
      this.logger.error(`push login failed for ${auth.orgId}: ${(e as Error).name}`);
      throw new ServiceUnavailableException('The image store could not be reached. Try again in a moment.');
    }
  }

  /** What the organisation has pushed, newest first. */
  async images(auth: DeployCaller) {
    const store = this.available();
    const found = await store.images(spaceOf(auth.orgId)).catch(() => {
      throw new ServiceUnavailableException('The image store could not be reached. Try again in a moment.');
    });
    return found.filter((i) => TAG.test(i.tag)).sort((a, b) => (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0));
  }

  private async busy(orgId: string) {
    if (await this.deploys.exists({ orgId, status: { $in: ['PENDING', 'RUNNING'] } })) throw new ConflictException('A deployment is already under way. Wait for it to finish.');
  }

  /** Asks for a pushed version to run. It replaces the one running; if it will not start, that one stays. */
  async request(auth: DeployCaller, tag: string) {
    this.available();
    await this.allowed(auth.orgId);
    if (!TAG.test(tag) || !UUID.test(auth.orgId)) throw new BadRequestException('Choose one of the versions you have pushed');
    if (!(await this.images(auth)).some((i) => i.tag === tag)) throw new NotFoundException(`There is no version "${tag}" in your image space. Push it first.`);
    await this.busy(auth.orgId);
    const id = newId();
    // The image is written out in full here, from this server's settings and the signed-in organisation: never from the request.
    await this.deploys.create({ id, orgId: auth.orgId, kind: 'DEPLOY', tag, image: `${this.registry}/${spaceOf(auth.orgId)}:${tag}`, status: 'PENDING', requestedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'extension.deploy_requested', targetType: 'extension', targetId: id, after: { tag } });
    orgLog.info(auth.orgId, 'extensions', `Deployment asked for: version ${tag}`, { deploy: id });
    return this.status(auth);
  }

  /** Asks for the extension to be taken away. Forms that use it must be changed before they can be published again. */
  async remove(auth: DeployCaller) {
    this.available();
    await this.busy(auth.orgId);
    const id = newId();
    await this.deploys.create({ id, orgId: auth.orgId, kind: 'REMOVE', status: 'PENDING', requestedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'extension.remove_requested', targetType: 'extension', targetId: id });
    orgLog.info(auth.orgId, 'extensions', 'Removal of the extension asked for', { deploy: id });
    return this.status(auth);
  }

  // ── The organisation's pipeline ──────────────────────────────────────────

  /**
   * A new deploy key, shown this once. It replaces the one before, which stops working at that moment: there
   * is one pipeline's worth of trust per organisation, and making a new key is how the old one is taken back.
   */
  async createKey(auth: DeployCaller) {
    this.available();
    await this.allowed(auth.orgId);
    const key = `${KEY_PREFIX}${randomToken()}`;
    await this.keys.deleteMany({ orgId: auth.orgId });
    await this.keys.create({ orgId: auth.orgId, hash: hashToken(key), hint: key.slice(-4), createdBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'extension.deploy_key_created', targetType: 'organization', targetId: auth.orgId });
    orgLog.info(auth.orgId, 'extensions', 'A deploy key was made for the pipeline');
    return { ...(await this.status(auth)), newKey: key };
  }

  async revokeKey(auth: DeployCaller) {
    const gone = await this.keys.deleteMany({ orgId: auth.orgId });
    if (gone.deletedCount) {
      await this.audit.record(actorOf(auth), { action: 'extension.deploy_key_revoked', targetType: 'organization', targetId: auth.orgId });
      orgLog.info(auth.orgId, 'extensions', 'The deploy key was taken back');
    }
    return this.status(auth);
  }

  /** The organisation a deploy key speaks for. Anything else is told nothing but "no". */
  async callerFor(key: string, ip: string, userAgent: string): Promise<DeployCaller> {
    const row = key.startsWith(KEY_PREFIX) ? await this.keys.findOneAndUpdate({ hash: hashToken(key) }, { $set: { lastUsedAt: new Date() } }, { comment: 'across-orgs: a deploy key is found by its unguessable value' }).lean() : null;
    if (!row) throw new UnauthorizedException('This deploy key is not valid. Make a new one on the Extensions page.');
    return { orgId: row.orgId, userId: `deploy-key:${row.hint}`, ip, userAgent: userAgent.slice(0, 200) };
  }

  // ── The server's deploy service (through the `extension` command, never over the network) ────────────

  /**
   * The next request waiting, marked as being worked on. One that was being worked on when the deploy
   * service stopped is closed as failed first, so the organisation is not left waiting for ever.
   */
  async takeNext(): Promise<{ id: string; kind: 'DEPLOY' | 'REMOVE'; orgId: string; image: string } | null> {
    const stale = await this.deploys.find({ status: 'RUNNING', updatedAt: { $lt: new Date(Date.now() - 10 * 60_000) } }, null, { comment: 'across-orgs: the deploy worker serves every organisation' }).lean();
    for (const row of stale) await this.finish(row.id, 'FAILED', 'The deployment was interrupted. Nothing was changed; ask for it again.', '');
    const row = await this.deploys.findOneAndUpdate({ status: 'PENDING' }, { $set: { status: 'RUNNING' } }, { comment: 'across-orgs: the deploy worker serves every organisation', sort: { createdAt: 1 }, new: true }).lean();
    if (!row) return null;
    // Checked again here, at the last step before something is run: the image is this organisation's and no one else's.
    if (!UUID.test(row.orgId) || (row.kind === 'DEPLOY' && row.image !== `${this.registry}/${spaceOf(row.orgId)}:${row.tag}`) || (row.kind === 'DEPLOY' && !TAG.test(row.tag))) {
      await this.finish(row.id, 'FAILED', 'The request was not one this installation can run.', '');
      return null;
    }
    return { id: row.id, kind: row.kind, orgId: row.orgId, image: row.image };
  }

  /** How it went, written where the organisation sees it: on the page, in its log and in its audit trail. */
  async finish(id: string, status: 'LIVE' | 'FAILED' | 'REMOVED', message: string, output: string) {
    // The end of the extension's own output: enough to see why it did not start, and no more than a screenful.
    const tail = output.replace(/[^\x09\x0a\x20-\x7e\u00a0-\uffff]/g, '').slice(-4000);
    const row = await this.deploys.findOneAndUpdate({ id, status: 'RUNNING' }, { $set: { status, message: message.slice(0, 500), output: tail, finishedAt: new Date() } }, { new: true, comment: 'across-orgs: the deploy worker finishes the deploy it took' }).lean();
    if (!row) throw new NotFoundException('No such deployment under way');
    await this.audit.record({ orgId: row.orgId, actorId: 'system:deploy' }, { action: status === 'LIVE' ? 'extension.deployed' : status === 'REMOVED' ? 'extension.undeployed' : 'extension.deploy_failed', targetType: 'extension', targetId: id, after: { tag: row.tag } });
    if (status === 'FAILED') orgLog.error(row.orgId, 'extensions', `Deployment failed${row.tag ? ` (version ${row.tag})` : ''}: ${message}`, { deploy: id });
    else orgLog.info(row.orgId, 'extensions', status === 'LIVE' ? `Version ${row.tag} is running` : 'The extension was removed', { deploy: id });
    for (const listener of this.finished) await listener(id).catch((e: Error) => this.logger.warn(`after deployment ${id}: ${e.message}`));
  }
}
