import { ModuleRef } from '@nestjs/core';
import { Injectable, Logger, OnApplicationBootstrap, SetMetadata } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { ACTION_KEY, ConnectorsService } from '../../connectors/connectors.service';
import { EXT_STEP_KEY, ExtensionsService } from '../../extensions/extensions.service';
import type { AutomationTrigger, FormDefinition, FormValues } from '@fb/engine';
import type { FormSubmission } from '../schemas/form-submission.schema';

/**
 * What a custom workflow method receives - like an AEM work item: the
 * payload (answers + record) and the data earlier steps produced. Everything
 * here comes from the server, never the browser.
 */
export interface FormHandlerContext {
  orgId: string;
  trigger: AutomationTrigger;
  definition: FormDefinition;
  record: FormSubmission & { createdAt?: Date };
  /** Answers by field name (the payload). */
  values: FormValues;
  /** Outputs of the steps that already ran in this flow, by step key (read-only). */
  steps: Readonly<Record<string, unknown>>;
  /** This step's key - its output lands at steps[key] for the steps below. */
  stepKey: string;
  /**
   * The same every time this step of this run is tried (after a crash, say), and different for every other step
   * and run: send it as an Idempotency-Key, or store it, so the other system does the work once.
   */
  runKey?: string;
  /** For a step that writes to another system: which answer fills which of its fields, where the designer chose. */
  map?: Record<string, string>;
}

/**
 * Return a timeline summary, or `{ summary, data }` - `data` becomes this
 * step's output ({{$steps.<key>.<field>}} for later steps). Throw to fail the step.
 */
export type FormHandlerResult = string | void | { summary?: string; data?: Record<string, unknown> };
export type FormHandler = (ctx: FormHandlerContext) => Promise<FormHandlerResult>;

export interface FormWorkflowInfo {
  /** Stored on the form: lower-case letters, digits and "-". Never rename a key forms already use. */
  key: string;
  /** What designers see in the builder's dropdown. */
  label: string;
  description?: string;
  /** Output fields it returns in `data`, so the builder can offer {{$steps.<key>.<field>}} and conditions on them. */
  outputs?: string[];
  /** For a step that writes to another system: the fields it fills, so the builder can show what goes where. */
  inputs?: string[];
}

const FORM_WORKFLOW = 'form-platform:workflow';

/**
 * Marks a provider method as a custom form workflow. It shows up in the
 * form builder's "Run custom API" dropdown and runs when a form's automation
 * calls it. The method's module just has to be part of the app - no other wiring:
 *
 *   @FormWorkflow({ key: 'complaint-create-capa', label: 'Create CAPA', description: '...' })
 *   async createCapa(ctx: FormHandlerContext) { ... return 'CAPA 42 created'; }
 */
export const FormWorkflow = (info: FormWorkflowInfo) => SetMetadata(FORM_WORKFLOW, info);

const KEY = /^[a-z0-9-]{1,60}$/;

/** Every @FormWorkflow method in the app, found once at startup. */
@Injectable()
export class FormHandlerRegistry implements OnApplicationBootstrap {
  private readonly logger = new Logger(FormHandlerRegistry.name);
  private readonly handlers = new Map<string, FormWorkflowInfo & { run: FormHandler }>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly connectors: ConnectorsService,
    private readonly extensions: ExtensionsService,
    // Looked up when a step runs: the document service is built after this one.
    private readonly moduleRef: ModuleRef,
  ) {}

  onApplicationBootstrap() {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== 'object') continue;
      const proto = Object.getPrototypeOf(instance);
      for (const name of this.scanner.getAllMethodNames(proto)) {
        const info = Reflect.getMetadata(FORM_WORKFLOW, proto[name]) as FormWorkflowInfo | undefined;
        if (info) this.register(info, (ctx) => proto[name].call(instance, ctx));
      }
    }
    this.logger.log(`${this.handlers.size} custom form workflow(s): ${[...this.handlers.keys()].join(', ') || 'none'}`);
  }

  register(info: FormWorkflowInfo, run: FormHandler) {
    if (!KEY.test(info.key)) throw new Error(`Form workflow key "${info.key}" must be lower-case letters, digits and -`);
    if (this.handlers.has(info.key)) throw new Error(`Form workflow key "${info.key}" is registered twice`);
    this.handlers.set(info.key, { ...info, run });
  }

  get(key: string): FormHandler | undefined {
    // Connector write steps are configuration, resolved per org when they run.
    if (ACTION_KEY.test(key)) return (ctx) =>
        this.connectors.runAction(ctx.orgId, key, { ...ctx.values, ...((ctx.record.work as Record<string, unknown>) ?? {}) }, ctx.definition.code, ctx.map, {
          // Where a response is saved as a file: under its form and its reference, with the PDF made only if it is wanted.
          name: `${ctx.definition.code}/${ctx.record.ref || ctx.record.uuid}`,
          attachments: async (room) => {
            // What the respondent uploaded, read back from our own store. (Loaded when needed, like the document service.)
            const { FormUploadService } = await import('./form-upload.service');
            return this.moduleRef.get(FormUploadService, { strict: false }).copiesOf(ctx.orgId, (ctx.record.files ?? []).map((f) => f.uploadId), room);
          },
          one: async (uploadId, room) => {
            // Only a file that came with this response: a step cannot be pointed at somebody else's upload.
            if (!(ctx.record.files ?? []).some((f) => f.uploadId === uploadId)) return null;
            const { FormUploadService } = await import('./form-upload.service');
            return (await this.moduleRef.get(FormUploadService, { strict: false }).copiesOf(ctx.orgId, [uploadId], room)).files[0] ?? null;
          },
          pdf: async () => {
            // Loaded when first needed: the document service's own file leads back to this one.
            const { DocumentsService } = await import('../../documents/documents.service');
            return (await this.moduleRef.get(DocumentsService, { strict: false }).forRecord(ctx.orgId, ctx.record.uuid)).pdf;
          },
        });
    const own = this.handlers.get(key)?.run;
    // The organisation's own code, in its extension: found per org when the step runs.
    if (!own && EXT_STEP_KEY.test(key)) {
      return ({ orgId, trigger, definition, record, values, steps, stepKey, runKey }) =>
        this.extensions.runStep(orgId, key, {
          trigger,
          form: { code: definition.code, version: definition.version, name: definition.name },
          record: { id: record.uuid, ref: record.ref, status: record.status, priority: record.priority, assigneeId: record.assigneeId, submittedAt: record.createdAt },
          values,
          work: record.work ?? {},
          steps,
          stepKey,
          runKey,
        });
    }
    return own;
  }

  /** Code handlers, this org's connector write steps and what its extensions offer (for the builder's step picker). */
  async listFor(orgId: string): Promise<FormWorkflowInfo[]> {
    return [...this.list(), ...(await this.connectors.actions(orgId)), ...(await this.extensions.steps(orgId))].sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Is this step key runnable for the org (a code handler, or an existing connector write)? */
  async exists(orgId: string, key: string): Promise<boolean> {
    return this.handlers.has(key) || (ACTION_KEY.test(key) && (await this.connectors.actionExists(orgId, key))) || (EXT_STEP_KEY.test(key) && (await this.extensions.stepExists(orgId, key)));
  }

  list(): FormWorkflowInfo[] {
    return [...this.handlers.values()]
      .map(({ key, label, description, outputs }) => ({ key, label, description, ...(outputs?.length ? { outputs } : {}) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
}
