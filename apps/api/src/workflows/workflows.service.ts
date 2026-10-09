import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { sharedWorkflowForm, validateFormDefinition, workflowFormFields, type Automation, type FormField, type SharedWorkflow, type SharedWorkflowField, type WorkflowConfig } from '@fb/engine';
import type { Model } from 'mongoose';
import { actorOf, AuditService } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth-context';
import { newId } from '../common/crypto';
import { Form, type FormDocument } from '../forms/form.schema';
import { checkDefinitionSecurity } from '../forms/payload-guard';
import { SharedWorkflowRow, type SharedWorkflowDocument } from './workflow.schema';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Types a top-level answer can have, as far as a workflow's rules and messages care. */
const FIELD_TYPES = new Set(['TEXT', 'TEXTAREA', 'NUMBER', 'STEPPER', 'EMAIL', 'PHONE', 'DATE', 'DATETIME', 'CHECKBOX', 'SWITCH', 'RADIO', 'DROPDOWN', 'MULTI_SELECT', 'CHECKBOX_GROUP']);
const MAX_WORKFLOWS = 200;

export interface WorkflowUse {
  formId: string;
  code: string;
  name: string;
  version: number;
  status: string;
}

class WorkflowProblems extends BadRequestException {
  constructor(issues: { field: string; message: string }[]) {
    super({ message: 'The workflow has problems', errors: issues });
  }
}

/**
 * The organisation's workflow library. Everyone who can see forms can read
 * it (a designer needs to pick from it); only admins change it, as with the
 * style library. A workflow is checked with the same rules as a form's own.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly audit: AuditService,
    @InjectModel(SharedWorkflowRow.name) private readonly rows: Model<SharedWorkflowDocument>,
    @InjectModel(Form.name) private readonly forms: Model<FormDocument>,
  ) {}

  private static view(row: SharedWorkflowRow): SharedWorkflow & { updatedAt: Date } {
    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      workflow: row.workflow as unknown as WorkflowConfig,
      automations: row.automations as Automation[],
      fields: row.fields as SharedWorkflowField[],
      updatedAt: row.updatedAt,
    };
  }

  /** Every form whose newest version uses this workflow. */
  private async uses(orgId: string, ids: string[]): Promise<Map<string, WorkflowUse[]>> {
    const rows = await this.forms
      .find({ orgId, isDeleted: false, 'definition.workflowRef.id': { $in: ids } })
      .sort({ code: 1, version: -1 })
      .select('id code name version status definition.workflowRef.id')
      .lean();
    const newest = await this.forms.aggregate<{ _id: string; version: number }>([{ $match: { orgId, isDeleted: false } }, { $group: { _id: '$code', version: { $max: '$version' } } }]);
    const latest = new Map(newest.map((n) => [n._id, n.version]));
    const out = new Map<string, WorkflowUse[]>();
    for (const r of rows) {
      // A draft or the live version; older versions carry their own copy and no longer depend on the library.
      if (r.version !== latest.get(r.code) && r.status !== 'PUBLISHED') continue;
      const id = (r.definition as { workflowRef?: { id?: string } }).workflowRef?.id ?? '';
      out.set(id, [...(out.get(id) ?? []), { formId: r.id, code: r.code, name: r.name, version: r.version, status: r.status }]);
    }
    return out;
  }

  async list(auth: AuthContext) {
    const rows = await this.rows.find({ orgId: auth.orgId }).sort({ name: 1 }).lean();
    const uses = await this.uses(auth.orgId, rows.map((r) => r.id));
    return rows.map((r) => ({ ...WorkflowsService.view(r), usedBy: uses.get(r.id) ?? [] }));
  }

  /** For publishing a form: the workflow as it is now, or null when it has been removed. */
  async find(orgId: string, id: string): Promise<SharedWorkflow | null> {
    const row = await this.rows.findOne({ orgId, id }).lean();
    return row ? WorkflowsService.view(row) : null;
  }

  /**
   * Checks a workflow as if it sat on a form that has exactly the fields it
   * says it needs, so every rule that applies to a form's own workflow applies
   * here, and every answer it reads is one it has declared.
   */
  private check(body: unknown): { name: string; description: string; workflow: WorkflowConfig; automations: Automation[]; fields: SharedWorkflowField[] } {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, 100) : '';
    if (!name) throw new WorkflowProblems([{ field: 'name', message: 'Give the workflow a name' }]);
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 300) : '';

    const seen = new Set<string>();
    const fields: SharedWorkflowField[] = [];
    for (const raw of Array.isArray(input.fields) ? input.fields.slice(0, 50) : []) {
      const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const fieldName = typeof f.name === 'string' ? f.name : '';
      if (!NAME.test(fieldName) || fieldName.length > 60) throw new WorkflowProblems([{ field: 'fields', message: `"${fieldName}" is not a usable field name: letters, digits or _, not starting with a digit` }]);
      if (seen.has(fieldName)) throw new WorkflowProblems([{ field: 'fields', message: `"${fieldName}" is listed twice` }]);
      seen.add(fieldName);
      const type = typeof f.type === 'string' && FIELD_TYPES.has(f.type) ? (f.type as FormField['type']) : 'TEXT';
      const options = (Array.isArray(f.options) ? f.options : [])
        .filter((o): o is { label: string; value: string } => !!o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string' && typeof (o as { value?: unknown }).value === 'string')
        .slice(0, 100)
        .map((o) => ({ label: o.label.slice(0, 100), value: o.value.slice(0, 100) }));
      fields.push({ name: fieldName, label: (typeof f.label === 'string' && f.label.trim() ? f.label.trim() : fieldName).slice(0, 100), type, ...(options.length ? { options } : {}) });
    }

    // A stand-in form with those fields: enough for the form validator to judge the workflow.
    const result = validateFormDefinition(sharedWorkflowForm({ name, fields, workflow: input.workflow, automations: input.automations }), 'publish');
    if ('issues' in result) {
      const own = result.issues.filter((i) => /^(workflow|automations)\b/.test(i.path));
      throw new WorkflowProblems((own.length ? own : result.issues).map((i) => ({ field: i.path, message: i.message })));
    }
    const security = checkDefinitionSecurity(result.data);
    if (security.length) throw new WorkflowProblems(security);
    if (!result.data.workflow) throw new WorkflowProblems([{ field: 'workflow', message: 'There is no workflow to save' }]);
    const undeclared = workflowFormFields(result.data.workflow, result.data.automations ?? []).filter((n) => !seen.has(n));
    if (undeclared.length) throw new WorkflowProblems(undeclared.map((n) => ({ field: 'fields', message: `The workflow uses "${n}", which is not in the list of answers it needs` })));
    return { name, description, workflow: result.data.workflow, automations: result.data.automations ?? [], fields };
  }

  async create(auth: AuthContext, body: unknown) {
    if ((await this.rows.countDocuments({ orgId: auth.orgId })) >= MAX_WORKFLOWS) throw new ConflictException(`The library holds at most ${MAX_WORKFLOWS} workflows`);
    const data = this.check(body);
    const id = newId();
    await this.rows.create({ id, orgId: auth.orgId, ...data, updatedBy: auth.userId });
    await this.audit.record(actorOf(auth), { action: 'workflow.created', targetType: 'workflow', targetId: id, after: { name: data.name } });
    return this.one(auth, id);
  }

  async update(auth: AuthContext, id: string, body: unknown) {
    const row = await this.rows.findOne({ orgId: auth.orgId, id });
    if (!row) throw new NotFoundException('Workflow not found');
    const data = this.check(body);
    row.set({ ...data, updatedBy: auth.userId });
    row.markModified('workflow');
    row.markModified('automations');
    row.markModified('fields');
    await row.save();
    await this.audit.record(actorOf(auth), { action: 'workflow.saved', targetType: 'workflow', targetId: id, after: { name: data.name } });
    return this.one(auth, id);
  }

  /** Not while a form still uses it: that form could never be published again. */
  async remove(auth: AuthContext, id: string) {
    const row = await this.rows.findOne({ orgId: auth.orgId, id }).lean();
    if (!row) throw new NotFoundException('Workflow not found');
    const used = (await this.uses(auth.orgId, [id])).get(id) ?? [];
    if (used.length) throw new ConflictException({ message: `"${row.name}" is used by ${used.map((u) => u.name).join(', ')}. Give ${used.length === 1 ? 'that form' : 'those forms'} another workflow first.`, usedBy: used });
    await this.rows.deleteOne({ orgId: auth.orgId, id });
    await this.audit.record(actorOf(auth), { action: 'workflow.deleted', targetType: 'workflow', targetId: id, after: { name: row.name } });
    return this.list(auth);
  }

  private async one(auth: AuthContext, id: string) {
    const found = (await this.list(auth)).find((w) => w.id === id);
    if (!found) throw new NotFoundException('Workflow not found');
    return found;
  }
}
