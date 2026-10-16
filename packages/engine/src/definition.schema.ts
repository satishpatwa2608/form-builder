import { z } from 'zod';
import type { FormDefinition } from './types';
import { formShape } from './repeat';
import { isHexColor, safeImageUrl, usedStyleIds } from './style-css';
import { isTimeZone } from './form-events';
import { languageCode } from './schema/common';
import { checkEvents, checkFields, checkOpenWith, checkPaymentAndCodes, checkRules, eventSchema, fieldSchema, formStyleSchema, MAX_EVENTS, MAX_RULES, openWithSchema, ruleSchema } from './schema/form';
import { checkWorkflow, workflowSchema } from './schema/workflow';
import { automationSchema, checkAutomations } from './schema/automation';
import { documentSettingsSchema } from './schema/document';

export { MAX_RULES, MAX_EVENTS, formStyleSchema, findCycle, VERIFIABLE_TYPES, needsCode } from './schema/form';
export { workflowSchema } from './schema/workflow';
export { automationSchema } from './schema/automation';
export { documentSettingsSchema } from './schema/document';

/**
 * Validates a FormDefinition *itself* - fixtures, builder output and (later)
 * API responses - so a malformed form fails loudly at load time instead of
 * half-rendering. Typed against the interfaces in ../types, so the two cannot
 * drift apart silently.
 *
 * A definition is four parts, each validated in its own module under schema/: the form (fields, rules,
 * events), the workflow, the automations and the document. This file puts them together, adds what belongs to
 * the form as a whole (dates, CAPTCHA, theme, where it goes when sent), and runs every part's publish checks.
 */

const formDefinitionShapeObject = z.object({
  id: z.string().min(1),
  orgId: z.string(),
  /** Kept for older forms: a form's business is the top-level folder it is in. */
  businessId: z.string().optional(),
  name: z.string().min(1),
  code: z.string().regex(/^[A-Z0-9_]+$/, 'Form code must be UPPER_SNAKE_CASE'),
  description: z.string().optional(),
  version: z.number().int().positive(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']),
  access: z.enum(['PUBLIC', 'AUTHENTICATED']),
  fields: z.array(fieldSchema),
  rules: z.array(ruleSchema).max(MAX_RULES).optional(),
  events: z.array(eventSchema).max(MAX_EVENTS).optional(),
  timeZone: z.string().max(64).optional(),
  saveForLater: z.boolean().optional(),
  saveAsYouGo: z.boolean().optional(),
  openWith: openWithSchema.optional(),
  startedFrom: z.object({ table: z.string().max(200), name: z.string().max(200), leftOut: z.array(z.string().max(100)).max(500).optional() }).optional(),
  listOnPortal: z.boolean().optional(),
  languages: z.object({ default: languageCode, others: z.array(languageCode).max(20) }).optional(),
  translations: z.record(languageCode, z.record(z.string().max(200), z.string().max(5000))).optional(),
  document: documentSettingsSchema.optional(),
  submitChecks: z.array(z.string().regex(/^x-[a-z0-9]{8}-[a-z0-9-]{1,40}$/)).max(5).optional(),
  opensAt: z.string().max(40).optional(),
  closesAt: z.string().max(40).optional(),
  closedMessage: z.string().max(500).optional(),
  actions: z
    .object({
      submit: z.object({ enabled: z.boolean(), label: z.string() }).optional(),
      cancel: z
        .object({
          enabled: z.boolean(),
          label: z.string(),
          behavior: z.enum(['RESET', 'REDIRECT']),
          redirectUrl: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  submission: z.object({
    method: z.enum(['POST', 'PUT']),
    endpointId: z.string().min(1),
    mapping: z.record(z.string(), z.string()).optional(),
    success: z
      .object({
        type: z.enum(['MESSAGE', 'REDIRECT']),
        message: z.string().optional(),
        redirectUrl: z.string().optional(),
      })
      .optional(),
  }),
  captcha: z
    .object({
      enabled: z.boolean(),
      provider: z.enum(['RECAPTCHA', 'TURNSTILE', 'HCAPTCHA']),
      siteKey: z.string(),
      mode: z.enum(['CHECKBOX', 'INVISIBLE', 'V3']),
    })
    .optional(),
  theme: z
    .object({
      primaryColor: z.string().optional(),
      backgroundColor: z.string().optional(),
      fontFamily: z.enum(['default', 'serif', 'rounded', 'mono']).optional(),
      errorColor: z.string().optional(),
      corners: z.enum(['square', 'rounded', 'pill']).optional(),
      spacing: z.enum(['compact', 'comfortable', 'roomy']).optional(),
      logoUrl: z.string().optional(),
      styleId: z.string().optional(),
    })
    .optional(),
  layout: z.object({ mode: z.enum(['single', 'steps']), review: z.boolean().optional() }).optional(),
  payment: z
    .object({ enabled: z.boolean(), amountField: z.string().max(100), currency: z.string().regex(/^[A-Z]{3}$/, 'Use a currency code such as INR, USD or CAD'), description: z.string().max(120).optional() })
    .optional(),
  styles: z.array(formStyleSchema).optional(),
  workflow: workflowSchema.optional(),
  recordAccess: z
    .object({
      mode: z.literal('TEAM'),
      userIds: z.array(z.string().min(1).max(64)).max(200),
      departments: z.array(z.string().min(1).max(100)).max(50),
    })
    .optional(),
  automations: z.array(automationSchema).max(30).optional(),
  workflowRef: z
    .object({ id: z.string().min(1).max(64), map: z.record(z.string(), z.string().max(100)).optional(), refPrefix: z.string().max(10).optional() })
    .optional(),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const formDefinitionShape: z.ZodType<FormDefinition> = formDefinitionShapeObject;

/** Structure plus internal consistency. Required to publish and to render publicly. */
export const formDefinitionSchema: z.ZodType<FormDefinition> = formDefinitionShapeObject.superRefine((def, ctx) => {
  checkFields(def.fields, ctx);
  checkRules(def, ctx);
  checkEvents(def, ctx);
  checkOpenWith(def, ctx);
  for (const key of ['opensAt', 'closesAt'] as const) {
    if (def[key] !== undefined && Number.isNaN(Date.parse(def[key]!))) ctx.addIssue({ code: 'custom', path: [key], message: 'Not a date and time' });
  }
  if (def.opensAt && def.closesAt && Date.parse(def.opensAt) >= Date.parse(def.closesAt)) {
    ctx.addIssue({ code: 'custom', path: ['closesAt'], message: 'The form must close after it opens' });
  }
  if (def.timeZone !== undefined && !isTimeZone(def.timeZone)) {
    ctx.addIssue({ code: 'custom', path: ['timeZone'], message: `"${def.timeZone}" is not a time zone. Use a name such as Asia/Kolkata` });
  }
  checkWorkflow(def, ctx);
  checkAutomations(def, ctx);
  checkPaymentAndCodes(def, ctx);

  const names = new Set(def.fields.map((f) => f.name));
  for (const key of Object.keys(def.submission.mapping ?? {})) {
    if (!names.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['submission', 'mapping', key], message: `Maps unknown field "${key}"` });
    }
    else if (formShape(def.fields).repeatOf.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['submission', 'mapping', key], message: `"${key}" is inside a repeating section and is saved with its rows` });
    }
  }

  const captchaFields = def.fields.filter((f) => f.type === 'CAPTCHA');
  if (captchaFields.length > 1) {
    ctx.addIssue({ code: 'custom', path: ['fields'], message: 'A form can have only one CAPTCHA field' });
  }
  if (def.captcha?.mode === 'V3' && def.captcha.provider !== 'RECAPTCHA') {
    ctx.addIssue({ code: 'custom', path: ['captcha', 'mode'], message: 'Score-based checking is only offered by reCAPTCHA' });
  }
  if (captchaFields.length && !def.captcha?.enabled) {
    ctx.addIssue({ code: 'custom', path: ['captcha'], message: 'CAPTCHA field present but captcha is not configured' });
  }

  const { cancel } = def.actions ?? {};
  if (cancel?.enabled && cancel.behavior === 'REDIRECT' && !cancel.redirectUrl) {
    ctx.addIssue({ code: 'custom', path: ['actions', 'cancel', 'redirectUrl'], message: 'Redirect cancel needs a redirectUrl' });
  }
  const { theme } = def;
  for (const key of ['primaryColor', 'backgroundColor'] as const) {
    if (theme?.[key] && !isHexColor(theme[key])) {
      ctx.addIssue({ code: 'custom', path: ['theme', key], message: `${key} must be a hex colour like #1458e2` });
    }
  }
  if (theme?.logoUrl && !safeImageUrl(theme.logoUrl)) {
    ctx.addIssue({ code: 'custom', path: ['theme', 'logoUrl'], message: 'Logo must be an https:// or site-relative (/…) URL' });
  }
  if (def.styles) {
    const embedded = new Set(def.styles.map((st) => st.id));
    for (const id of usedStyleIds(def)) {
      if (!embedded.has(id)) ctx.addIssue({ code: 'custom', path: ['styles'], message: `Style "${id}" is used but not included` });
    }
  }
  const { success } = def.submission;
  if (success?.type === 'REDIRECT' && !success.redirectUrl) {
    ctx.addIssue({ code: 'custom', path: ['submission', 'success', 'redirectUrl'], message: 'Redirect on success needs a redirectUrl' });
  }
});

export interface DefinitionIssue {
  path: string;
  message: string;
}

/** 'publish' (default) = fully consistent; 'shape' = structurally valid, as drafts need. */
export type ValidationLevel = 'shape' | 'publish';

export function validateFormDefinition(
  input: unknown,
  level: ValidationLevel = 'publish',
): { success: true; data: FormDefinition } | { success: false; issues: DefinitionIssue[] } {
  const schema = level === 'shape' ? formDefinitionShape : formDefinitionSchema;
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

export class FormDefinitionError extends Error {
  constructor(public readonly issues: DefinitionIssue[]) {
    super(`Invalid form definition:\n${issues.map((i) => `  ${i.path || '(root)'}: ${i.message}`).join('\n')}`);
    this.name = 'FormDefinitionError';
  }
}

/** Parses or throws FormDefinitionError listing every problem. */
export function parseFormDefinition(input: unknown): FormDefinition {
  const result = validateFormDefinition(input);
  // `in` narrows under both the web's strict and the API's non-strict tsconfig.
  if ('issues' in result) throw new FormDefinitionError(result.issues);
  return result.data;
}
