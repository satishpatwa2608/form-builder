import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { FormDefinition, RecordAccess } from '@fb/engine';
import type { Model } from 'mongoose';
import { Form, type FormDocument } from '../../forms/form.schema';

/**
 * The read side of form definitions the ported work code needs (the write
 * side lives in forms/FormsService). Published versions are immutable, so
 * they're cached briefly.
 */
@Injectable()
export class FormDefinitionService {
  private readonly versionCache = new Map<string, FormDefinition>();
  private readonly latestCache = new Map<string, { at: number; latest: Map<string, FormDefinition> }>();

  constructor(@InjectModel(Form.name) private readonly forms: Model<FormDocument>) {}

  static toDefinition(row: Form): FormDefinition {
    return { ...(row.definition as unknown as FormDefinition), id: row.id, orgId: row.orgId, code: row.code, version: row.version, status: row.status };
  }

  /** Latest PUBLISHED version of a code - what public links render and submissions go against. */
  async findPublished(orgId: string, code: string): Promise<FormDefinition | null> {
    const row = await this.forms.findOne({ orgId, code, status: 'PUBLISHED', isDeleted: false }).sort({ version: -1 }).lean();
    return row ? FormDefinitionService.toDefinition(row) : null;
  }

  /** The exact version a record was submitted against (records follow its workflow). */
  async findVersion(orgId: string, id: string): Promise<FormDefinition | null> {
    const key = `${orgId}:${id}`;
    const hit = this.versionCache.get(key);
    if (hit) return hit;
    const row = await this.forms.findOne({ id, orgId }).lean();
    if (!row) return null;
    const def = FormDefinitionService.toDefinition(row);
    if (row.status !== 'DRAFT') {
      if (this.versionCache.size > 500) this.versionCache.clear();
      this.versionCache.set(key, def);
    }
    return def;
  }

  /** The latest published (or last archived) version of every code: the current policy applies to old records too. */
  async latestByCode(orgId: string): Promise<Map<string, FormDefinition>> {
    const hit = this.latestCache.get(orgId);
    if (hit && Date.now() - hit.at < 30_000) return hit.latest;
    const rows = await this.forms.find({ orgId, isDeleted: false, status: { $in: ['PUBLISHED', 'ARCHIVED'] } }).sort({ version: -1 }).lean();
    const latest = new Map<string, FormDefinition>();
    for (const r of rows) if (!latest.has(r.code)) latest.set(r.code, FormDefinitionService.toDefinition(r));
    this.latestCache.set(orgId, { at: Date.now(), latest });
    return latest;
  }

  async recordAccessByCode(orgId: string): Promise<Map<string, RecordAccess | undefined>> {
    return new Map([...(await this.latestByCode(orgId)).entries()].map(([code, def]) => [code, def.recordAccess]));
  }

  /** Publishing changes the policy: forget the cached latest versions. */
  forget(orgId: string) {
    this.latestCache.delete(orgId);
  }
}
