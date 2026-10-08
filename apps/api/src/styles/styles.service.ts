import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { formStyleSchema, type FormStyle } from '@fb/engine';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { Style, type StyleDocument } from './style.schema';

const KEY = /^[A-Za-z0-9_-]{1,60}$/;

@Injectable()
export class StylesService {
  constructor(
    private readonly audit: AuditService,
    @InjectModel(Style.name) private readonly styles: Model<StyleDocument>,
  ) {}

  private static toStyle(row: Style): FormStyle {
    return { id: row.key, name: row.name, description: row.description || undefined, props: row.props as FormStyle['props'] };
  }

  async list(auth: AuthContext): Promise<FormStyle[]> {
    return (await this.styles.find({ orgId: auth.orgId }).sort({ name: 1 }).lean()).map(StylesService.toStyle);
  }

  /** The engine's schema validates the values; the CSS generator whitelists them again at render. */
  async upsert(auth: AuthContext, key: string, body: unknown) {
    const parsed = formStyleSchema.safeParse({ ...(body && typeof body === 'object' ? body : {}), id: key });
    if (!KEY.test(key) || !parsed.success) throw new BadRequestException('Invalid style');
    const style = parsed.data;
    await this.styles.updateOne(
      { orgId: auth.orgId, key },
      { $set: { name: style.name.trim().slice(0, 100), description: (style.description ?? '').slice(0, 300), props: style.props }, $setOnInsert: { orgId: auth.orgId, key } },
      { upsert: true },
    );
    await this.audit.record(actorOf(auth), { action: 'style.saved', targetType: 'style', targetId: key, after: { name: style.name } });
    return this.list(auth);
  }

  async remove(auth: AuthContext, key: string) {
    const res = await this.styles.deleteOne({ orgId: auth.orgId, key });
    if (!res.deletedCount) throw new NotFoundException('Style not found');
    await this.audit.record(actorOf(auth), { action: 'style.deleted', targetType: 'style', targetId: key });
    return this.list(auth);
  }

  /** For publishing: the current styles with these keys (a missing one is reported by the caller). */
  async byKeys(orgId: string, keys: string[]): Promise<FormStyle[]> {
    if (!keys.length) return [];
    return (await this.styles.find({ orgId, key: { $in: keys } }).lean()).map(StylesService.toStyle);
  }
}
