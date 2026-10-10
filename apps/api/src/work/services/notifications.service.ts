import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { APP_CONFIG, type AppConfig } from '../../config';
import { newId } from '../../common/crypto';
import { MAILER, type Mailer } from '../../common/mailer';
import type { AuthContext } from '../../auth/auth-context';
import { Notification, type NotificationDocument } from '../schemas/notification.schema';
import { PeopleService } from './people.service';

/** In-app notifications, each also emailed (replaces Sangam's shared notification module). */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly people: PeopleService,
    @InjectModel(Notification.name) private readonly notifications: Model<NotificationDocument>,
  ) {}

  /** Fire and forget: a notification failing never fails the action that caused it. */
  notify(orgId: string, userIds: string[], message: string, recordId = '', ref = '', formName = '', answerKeys: Record<string, string> = {}) {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return;
    void (async () => {
      const text = message.slice(0, 500);
      await this.notifications.insertMany(ids.map((userId) => ({ id: newId(), orgId, userId, message: text, recordId, ref, formName })));
      const contacts = await this.people.contacts(orgId, ids);
      const link = recordId ? `${this.config.APP_URL}/work?record=${encodeURIComponent(recordId)}` : this.config.APP_URL;
      for (const p of contacts.values()) {
        // An approver who may answer from the email gets their own private link, in the email only.
        const key = answerKeys[p.uuid];
        const answer = key ? `\n\nTo approve or reject without signing in (this link is yours alone, works once, for 7 days):\n${this.config.APP_URL}/answer?key=${key}` : '';
        await this.mailer.send({ to: p.email, subject: formName ? `${formName}: ${ref || 'update'}` : 'Form Builder', text: `${text}\n\n${link}${answer}` }).catch(() => undefined);
      }
    })().catch((e) => this.logger.warn(`notify failed: ${(e as Error).message}`));
  }

  async list(auth: AuthContext) {
    const rows = await this.notifications.find({ orgId: auth.orgId, userId: auth.userId }).sort({ createdAt: -1 }).limit(50).select('-_id -__v').lean();
    return { notifications: rows, unread: await this.notifications.countDocuments({ orgId: auth.orgId, userId: auth.userId, readAt: null }) };
  }

  async markRead(auth: AuthContext, id?: string) {
    await this.notifications.updateMany({ orgId: auth.orgId, userId: auth.userId, readAt: null, ...(id ? { id } : {}) }, { $set: { readAt: new Date() } });
    return this.list(auth);
  }
}
