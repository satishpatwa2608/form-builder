import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { fragmentProblems, validateFormDefinition, type FormField, type Fragment } from '@fb/engine';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { newId } from '../common/crypto';
import { Form, type FormDocument } from '../forms/form.schema';
import { checkDefinitionSecurity } from '../forms/payload-guard';
import { FragmentRow, type FragmentDocument } from './fragment.schema';

const MAX_FRAGMENTS = 200;
const MAX_FIELDS = 100;

export interface FragmentUseRow {
  formId: string;
  code: string;
  name: string;
  version: number;
  status: string;
}

class FragmentProblems extends BadRequestException {
  constructor(issues: { field: string; message: string }[]) {
    super({ message: 'The fragment has problems', errors: issues });
  }
}

/**
 * The organisation's fragment library. Everyone who can see forms can read it
 * (a designer places fragments on forms); only admins change it, as with
 * styles and shared workflows. A fragment's fields are checked exactly as a
 * form's are.
 */
@Injectable()
export class FragmentsService {
  constructor(
    private readonly audit: AuditService,
    @InjectModel(FragmentRow.name) private readonly rows: Model<FragmentDocument>,
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
  ) {}

  private static view(row: FragmentRow): Fragment & { updatedAt: Date } {
    return { id: row.id, name: row.name, description: row.description || undefined, fields: row.fields as FormField[], updatedAt: row.updatedAt };
  }

  /** Every form whose draft or live version has a section copied from one of these fragments. */
  private async uses(orgId: string, ids: string[]): Promise<Map<string, FragmentUseRow[]>> {
    const rows = await this.forms
      .find({ orgId, isDeleted: false, 'definition.fields.props.fragment.id': { $in: ids } })
      .sort({ code: 1, version: -1 })
      .select('id code name version status definition.fields.props')
      .lean();
    const newest = await this.forms.aggregate<{ _id: string; version: number }>([{ $match: { orgId, isDeleted: false } }, { $group: { _id: '$code', version: { $max: '$version' } } }]);
    const latest = new Map(newest.map((n) => [n._id, n.version]));
    const out = new Map<string, FragmentUseRow[]>();
    for (const r of rows) {
      // Older versions keep their own copy and no longer depend on the library.
      if (r.version !== latest.get(r.code) && r.status !== 'PUBLISHED') continue;
      const used = new Set(((r.definition as { fields?: { props?: { fragment?: { id?: string } } }[] }).fields ?? []).map((f) => f.props?.fragment?.id).filter((id): id is string => !!id && ids.includes(id)));
      for (const id of used) out.set(id, [...(out.get(id) ?? []), { formId: r.id, code: r.code, name: r.name, version: r.version, status: r.status }]);
    }
    return out;
  }

  async list(auth: AuthContext) {
    const rows = await this.rows.find({ orgId: auth.orgId }).sort({ name: 1 }).lean();
    const uses = await this.uses(auth.orgId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...FragmentsService.view(r), usedBy: uses.get(r.id) ?? [] }));
  }

  /** For publishing a form: the library as it is now. */
  async all(orgId: string): Promise<Fragment[]> {
    return (await this.rows.find({ orgId }).lean()).map(FragmentsService.view);
  }

  async exists(orgId: string, id: string): Promise<boolean> {
    return !!(await this.rows.exists({ orgId, id }));
  }

  /** Checks a fragment's fields as if they were a whole form, then for what only a fragment must not have. */
  private check(body: unknown): { name: string; description: string; fields: FormField[] } {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : '';
    if (!name) throw new FragmentProblems([{ field: 'name', message: 'Give the fragment a name' }]);
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 300) : '';
    const raw = Array.isArray(input.fields) ? input.fields : [];
    if (raw.length > MAX_FIELDS) throw new FragmentProblems([{ field: 'fields', message: `A fragment holds at most ${MAX_FIELDS} fields` }]);
    const result = validateFormDefinition(
      { id: 'library', orgId: 'library', businessId: '', name, code: 'LIBRARY', version: 1, status: 'DRAFT', access: 'PUBLIC', submission: { method: 'POST', endpointId: 'default-submit' }, fields: raw, createdBy: 'library', updatedBy: 'library' },
      'publish',
    );
    if ('issues' in result) {
      // Where the fragment's own check can say the same thing more usefully ("depends on a field that is not
      // part of the fragment"), let it; what was sent may be any shape, so it is asked carefully.
      let own: string[] = [];
      try {
        own = fragmentProblems(raw as FormField[]);
      } catch {
        own = [];
      }
      const rest = result.issues.filter((i) => !(own.length && /unknown field/.test(i.message)));
      throw new FragmentProblems([...own.map((message) => ({ field: 'fields', message })), ...rest.map((i) => ({ field: i.path, message: i.message }))]);
    }
    const security = checkDefinitionSecurity(result.data);
    if (security.length) throw new FragmentProblems(security);
    const own = fragmentProblems(result.data.fields);
    if (own.length) throw new FragmentProblems(own.map((message) => ({ field: 'fields', message })));
    return { name, description, fields: result.data.fields };
  }

  async create(auth: AuthContext, body: unknown) {
    if ((await this.rows.countDocuments({ orgId: auth.orgId })) >= MAX_FRAGMENTS) throw new ConflictException(`The library holds at most ${MAX_FRAGMENTS} fragments`);
    const data = this.check(body);
    const id = newId();
    await this.rows.create({ id, orgId: auth.orgId, ...data, updatedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'fragment.created', targetType: 'fragment', targetId: id, after: { name: data.name } });
    return this.one(auth, id);
  }

  async update(auth: AuthContext, id: string, body: unknown) {
    const row = await this.rows.findOne({ orgId: auth.orgId, id });
    if (!row) throw new NotFoundException('Fragment not found');
    const data = this.check(body);
    row.set({ ...data, updatedBy: auth.userId });
    row.markModified('fields');
    await row.save();
    await this.audit.record(actorOf(auth), { action: 'fragment.saved', targetType: 'fragment', targetId: id, after: { name: data.name } });
    return this.one(auth, id);
  }

  /** Not while a form still uses it: its section there would be left pointing at nothing. */
  async remove(auth: AuthContext, id: string) {
    const row = await this.rows.findOne({ orgId: auth.orgId, id }).lean();
    if (!row) throw new NotFoundException('Fragment not found');
    const used = (await this.uses(auth.orgId, [id])).get(id) ?? [];
    if (used.length) throw new ConflictException({ message: `"${row.name}" is used by ${used.map((u) => u.name).join(', ')}. Detach it there first.`, usedBy: used });
    await this.rows.deleteOne({ orgId: auth.orgId, id });
    await this.audit.record(actorOf(auth), { action: 'fragment.deleted', targetType: 'fragment', targetId: id, after: { name: row.name } });
    return this.list(auth);
  }

  private async one(auth: AuthContext, id: string) {
    const found = (await this.list(auth)).find((f) => f.id === id);
    if (!found) throw new NotFoundException('Fragment not found');
    return found;
  }
}
