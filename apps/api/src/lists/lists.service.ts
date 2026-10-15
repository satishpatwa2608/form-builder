import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { newId } from '../common/crypto';
import { Form, type FormDocument } from '../forms/form.schema';
import { SharedList, type ListItem, type SharedListDocument } from './list.schema';

const MAX_LISTS = 200;
const MAX_ITEMS = 5000;
const VALUE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const fault = (field: string, message: string) => new BadRequestException({ message, errors: [{ field, message }] });
export const listSourceKey = (key: string) => `/lists/${key}`;
const SOURCE = /^\/lists\/([a-z0-9][a-z0-9-]{0,59})$/;

/** "Branch offices" -> "branch-offices". */
const keyOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
/** "Pune Camp" -> "PUNE_CAMP": what a response stores for an item, made from its first label. */
const valueOf = (label: string) =>
  label
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'ITEM';

export interface ListInput {
  name?: unknown;
  description?: unknown;
  dependsOn?: unknown;
  items?: unknown;
}

@Injectable()
export class ListsService {
  constructor(
    private readonly audit: AuditService,
    @InjectModel(SharedList.name) private readonly rows: Model<SharedListDocument>,
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
  ) {}

  private static view(r: SharedList) {
    return { id: r.id, key: r.key, name: r.name, description: r.description ?? '', dependsOn: r.dependsOn ?? '', items: r.items ?? [], updatedAt: r.updatedAt };
  }

  /** Forms whose newest or live version reads each list. */
  private async uses(orgId: string, keys: string[]): Promise<Map<string, { formId: string; name: string }[]>> {
    const urls = keys.map(listSourceKey);
    const rows = await this.forms.find({ orgId, isDeleted: false, status: { $ne: 'ARCHIVED' }, 'definition.fields.dataSource.api.url': { $in: urls } }).sort({ code: 1, version: -1 }).select('id code name definition.fields.dataSource').lean();
    const out = new Map<string, { formId: string; name: string }[]>();
    const seen = new Set<string>();
    for (const r of rows) {
      for (const f of (r.definition as { fields?: { dataSource?: { api?: { url?: string } } }[] }).fields ?? []) {
        const key = SOURCE.exec(f.dataSource?.api?.url ?? '')?.[1];
        if (!key || seen.has(`${key}|${r.code}`)) continue;
        seen.add(`${key}|${r.code}`);
        out.set(key, [...(out.get(key) ?? []), { formId: r.id, name: r.name }]);
      }
    }
    return out;
  }

  async list(auth: AuthContext) {
    const rows = await this.rows.find({ orgId: auth.orgId }).sort({ name: 1 }).lean();
    const uses = await this.uses(auth.orgId, rows.map((r) => r.key));
    return rows.map((r) => ({ ...ListsService.view(r), usedBy: uses.get(r.key) ?? [] }));
  }

  /** As dropdown sources, in the shape connectors and extensions offer theirs. */
  async sources(orgId: string) {
    const rows = await this.rows.find({ orgId }).sort({ name: 1 }).select('key name dependsOn description').lean();
    const names = new Map(rows.map((r) => [r.key, r.name]));
    return rows.map((r) => ({ key: listSourceKey(r.key), name: r.name, description: r.description ?? '', params: r.dependsOn ? ['parent'] : [], valueField: 'value', labelField: 'label', list: true, dependsOnName: r.dependsOn ? (names.get(r.dependsOn) ?? '') : '' }));
  }

  private async check(orgId: string, body: ListInput, existing?: SharedList) {
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    if (!name) throw fault('name', 'Give the list a name');
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '';
    const dependsOn = typeof body.dependsOn === 'string' ? body.dependsOn : '';
    const parent = dependsOn ? await this.rows.findOne({ orgId, key: dependsOn }).lean() : null;
    if (dependsOn && (!parent || parent.key === existing?.key)) throw fault('dependsOn', 'Choose the list this one depends on');
    if (parent?.dependsOn && parent.dependsOn === existing?.key) throw fault('dependsOn', 'Two lists cannot depend on each other');
    const parentValues = new Set((parent?.items ?? []).map((i) => i.value));
    const raw = Array.isArray(body.items) ? body.items : [];
    if (!raw.length) throw fault('items', 'Add at least one item');
    if (raw.length > MAX_ITEMS) throw fault('items', `A list holds at most ${MAX_ITEMS} items`);
    const known = new Map((existing?.items ?? []).map((i) => [i.value, i]));
    const items: ListItem[] = [];
    const values = new Set<string>();
    raw.forEach((r, n) => {
      const it = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      const label = typeof it.label === 'string' ? it.label.trim().slice(0, 200) : '';
      if (!label) throw fault('items', `Item ${n + 1} has no name`);
      // A value given is kept (it is what old answers hold); a new item gets one from its name.
      let value = typeof it.value === 'string' && it.value ? it.value : valueOf(label);
      if (!VALUE.test(value)) throw fault('items', `"${label}" has a value that cannot be stored`);
      if (!known.has(value)) for (let k = 2; values.has(value); k++) value = `${valueOf(label).slice(0, 56)}_${k}`;
      if (values.has(value)) throw fault('items', `"${label}" is in the list twice`);
      values.add(value);
      const belongsTo = typeof it.parent === 'string' ? it.parent : '';
      if (dependsOn && !parentValues.has(belongsTo)) throw fault('items', `Say which item of "${parent!.name}" "${label}" belongs to`);
      items.push({ value, label, ...(dependsOn ? { parent: belongsTo } : {}), ...(it.retired === true ? { retired: true } : {}) });
    });
    return { name, description, dependsOn, items };
  }

  async create(auth: AuthContext, body: ListInput) {
    if ((await this.rows.countDocuments({ orgId: auth.orgId })) >= MAX_LISTS) throw new ConflictException(`The library holds at most ${MAX_LISTS} lists`);
    const data = await this.check(auth.orgId, body);
    let key = keyOf(data.name) || 'list';
    for (let n = 2; await this.rows.exists({ orgId: auth.orgId, key }); n++) key = `${keyOf(data.name).slice(0, 56) || 'list'}-${n}`;
    const id = newId();
    await this.rows.create({ id, orgId: auth.orgId, key, ...data, updatedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'list.created', targetType: 'list', targetId: id, after: { name: data.name, items: data.items.length } });
    return (await this.list(auth)).find((l) => l.id === id)!;
  }

  async update(auth: AuthContext, id: string, body: ListInput) {
    const row = await this.rows.findOne({ orgId: auth.orgId, id });
    if (!row) throw new NotFoundException('List not found');
    const data = await this.check(auth.orgId, body, row.toObject());
    // An item taken out may be what old answers hold: it is retired, not forgotten, so those answers still read properly.
    const kept = new Set(data.items.map((i) => i.value));
    const retired = (row.items ?? []).filter((i) => !kept.has(i.value)).map((i) => ({ ...i, retired: true }));
    row.set({ ...data, items: [...data.items, ...retired], updatedBy: auth.userId });
    row.markModified('items');
    await row.save();
    await this.audit.record(actorOf(auth), { action: 'list.saved', targetType: 'list', targetId: id, after: { name: data.name, items: data.items.length } });
    return (await this.list(auth)).find((l) => l.id === id)!;
  }

  /** Not while a form reads it, or another list depends on it. */
  async remove(auth: AuthContext, id: string) {
    const row = await this.rows.findOne({ orgId: auth.orgId, id }).lean();
    if (!row) throw new NotFoundException('List not found');
    const used = (await this.uses(auth.orgId, [row.key])).get(row.key) ?? [];
    if (used.length) throw new ConflictException(`"${row.name}" is used by ${used.map((u) => u.name).join(', ')}. Change those fields first.`);
    const child = await this.rows.findOne({ orgId: auth.orgId, dependsOn: row.key }).lean();
    if (child) throw new ConflictException(`"${child.name}" depends on this list. Change or delete that one first.`);
    await this.rows.deleteOne({ orgId: auth.orgId, id });
    await this.audit.record(actorOf(auth), { action: 'list.deleted', targetType: 'list', targetId: id, before: { name: row.name } });
  }

  /** The items a dropdown offers now: all of them, or (for a list that depends on another) those of the choice made there. */
  async items(orgId: string, sourceKey: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]> {
    const key = SOURCE.exec(sourceKey)?.[1];
    const row = key ? await this.rows.findOne({ orgId, key }).lean() : null;
    if (!row) throw new NotFoundException('No such list');
    const parent = typeof params.parent === 'string' || typeof params.parent === 'number' ? String(params.parent) : '';
    return (row.items ?? []).filter((i) => !i.retired && (!row.dependsOn || !parent || i.parent === parent)).map((i) => ({ value: i.value, label: i.label, ...(i.parent ? { parent: i.parent } : {}) }));
  }
}
