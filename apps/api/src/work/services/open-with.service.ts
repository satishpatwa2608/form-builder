import { createHmac, timingSafeEqual } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { rowValues, sectionRows, type FormDefinition, type FormValues } from '@fb/engine';
import { APP_CONFIG, type AppConfig } from '../../config';
import { DataSourceQueryService } from './data-source-query.service';

/** The longest a link made for a record may last. */
export const FILL_LINK_MAX_DAYS = 365;

export interface OpenedWith {
  /** The answers the record gives, by question. Nothing else of the record is here. */
  values: FormValues;
  /** Whether a record was found. */
  found: boolean;
  /** Questions that stay as the record says. */
  locked: string[];
}

const NOTHING: OpenedWith = { values: {}, found: false, locked: [] };

/**
 * A form that opens already filled from a record (the form's "Opens with a record" setting). The record is read
 * here, on the server: the browser is given the answers the designer mapped and never the record itself, and the
 * answers marked "keep as the record says" are read again when the form is sent, so they cannot be altered on the way.
 *
 * Which record it is comes from the signed-in person, or from a link made for that one record. Such a link is
 * signed with the installation's key: it cannot be guessed, changed to another record, or used on another form.
 */
@Injectable()
export class OpenWithService {
  private readonly key: Buffer;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly sources: DataSourceQueryService,
  ) {
    this.key = Buffer.from(config.SECRET_KEY, 'base64');
  }

  private mark(body: string) {
    return createHmac('sha256', this.key).update(`open-with:${body}`).digest('base64url');
  }

  /** What goes after `?fill=` in a link that opens `def` with the record whose key is `value`. */
  link(def: Pick<FormDefinition, 'orgId' | 'code'>, value: string, days: number): { token: string; expiresAt: Date } {
    const expiresAt = new Date(Date.now() + Math.min(Math.max(Math.trunc(days) || 30, 1), FILL_LINK_MAX_DAYS) * 86_400_000);
    const body = Buffer.from(JSON.stringify({ o: def.orgId, f: def.code, v: value, e: expiresAt.getTime() })).toString('base64url');
    return { token: `${body}.${this.mark(body)}`, expiresAt };
  }

  /** The record's key a link carries, when the link is one of ours, for this form, and still in date. */
  private read(token: unknown, def: Pick<FormDefinition, 'orgId' | 'code'>): string | undefined {
    if (typeof token !== 'string' || token.length > 2000) return undefined;
    const [body, mark] = token.split('.');
    if (!body || !mark) return undefined;
    const expected = this.mark(body);
    if (expected.length !== mark.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(mark))) return undefined;
    try {
      const said = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { o?: unknown; f?: unknown; v?: unknown; e?: unknown };
      if (said.o !== def.orgId || said.f !== def.code || typeof said.v !== 'string' || typeof said.e !== 'number' || said.e < Date.now()) return undefined;
      return said.v;
    } catch {
      return undefined;
    }
  }

  /** True when sending the form must look at the record again: something is locked, or the form opens only from a link. */
  static matters(def: Pick<FormDefinition, 'openWith'>): boolean {
    return !!def.openWith && (!!def.openWith.only || !!def.openWith.lock?.length);
  }

  /**
   * The answers the record gives this form. With no record to look for (no link, nobody signed in) the form
   * simply opens empty, unless it opens only from a link, which is then refused.
   */
  async answers(def: FormDefinition, by: { fill?: unknown; user?: { uuid: string; orgId: string; email?: string; employeeId?: string } }): Promise<OpenedWith> {
    const open = def.openWith;
    if (!open) return NOTHING;
    const mine = by.user?.orgId === def.orgId ? by.user : undefined;
    const value = open.by === 'LINK' ? this.read(by.fill, def) : open.by === 'USER_EMAIL' ? mine?.email : mine?.employeeId;
    if (!value) {
      if (open.only) throw new ForbiddenException('This form opens from a link made for you. The link is missing, has been changed, or is out of date: please ask for a new one.');
      return NOTHING;
    }
    const [row] = await this.sources.queryDataSource(def.orgId, open.source, { [open.param]: value }, mine, `form:${def.code}:opens`);
    if (!row) {
      if (open.only) throw new NotFoundException('The record this link was made for is no longer there.');
      return NOTHING;
    }
    const values = rowValues(def.fields, row, open.set);
    for (const rows of open.rows ?? []) {
      const filled = sectionRows(def.fields, [row], rows);
      if (filled) values[filled.name] = filled.rows as FormValues[string];
    }
    return { values, found: true, locked: (open.lock ?? []).filter((name) => name in values) };
  }
}
