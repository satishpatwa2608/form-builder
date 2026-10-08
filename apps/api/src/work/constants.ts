/** Module codes (features with app: "Form"). Access is module-based, never userType. */
export const FORM_MODULES = {
  viewer: 'FormPlatformViewerModule',
  designer: 'FormPlatformDesignerModule',
  publisher: 'FormPlatformPublisherModule',
  admin: 'FormPlatformAdminModule',
  /** Works the records inbox (status, assignment, comments) without designing forms. */
  records: 'FormPlatformRecordsModule',
} as const;

export const ANY_FORM_MODULE = Object.values(FORM_MODULES);
export const DESIGN_MODULES = [FORM_MODULES.designer, FORM_MODULES.admin];
export const PUBLISH_MODULES = [FORM_MODULES.publisher, FORM_MODULES.admin];
export const ADMIN_MODULES = [FORM_MODULES.admin];
/** Submissions hold personal data - viewers (read-only form access) can't see them. */
export const SUBMISSION_READ_MODULES = [FORM_MODULES.designer, FORM_MODULES.publisher, FORM_MODULES.admin];
/** The records inbox: see, move, assign and comment on the org's records. Also who can be assigned. */
export const RECORD_MODULES = [...SUBMISSION_READ_MODULES, FORM_MODULES.records];

/** Hard limits on anything the public can send. */
export const LIMITS = {
  /** JSON size of a submission's values. */
  valuesBytes: 256 * 1024,
  /** JSON size of a form definition. */
  definitionBytes: 512 * 1024,
  maxFields: 300,
  textLength: 20_000,
  arrayItems: 100,
  urlParams: 20,
  urlParamLength: 500,
  /** Regex `pattern` in field validation. */
  patternLength: 200,
  dataSourceParamLength: 200,
  dataSourceRows: 5_000,
  maxUploadMB: 25,
} as const;

/** Rate limits for the public endpoints, per client IP + form code. */
export const THROTTLE = {
  read: { limit: 120, ttl: 60_000 },
  submit: { limit: 10, ttl: 60_000 },
  upload: { limit: 30, ttl: 60_000 },
} as const;

/** Source channels a submission may claim. Anything else is stored as WEB. */
export const CHANNELS = ['WEB', 'APP', 'EMBED', 'QR', 'EMAIL', 'SMS', 'KIOSK'] as const;

/** Emitted after every stored submission - workflows / automations listen here. */
export const FORM_SUBMITTED_EVENT = 'form.submitted';

/** Emitted when a record changes status (by a person or an automation). */
export const FORM_RECORD_STATUS_EVENT = 'form.record.status';

/** Every timeline change worth publishing (webhook subscriptions listen here). */
export const WORK_EVENT = 'work.event';

/** Emitted when work fields change (the FIELD_UPDATED trigger). */
export const FORM_RECORD_FIELDS_EVENT = 'form.record.fields';

export const WORKFLOW = {
  /** SET_STATUS -> STATUS_CHANGED -> SET_STATUS ... stops after this many hops. */
  maxAutomationDepth: 3,
  sweepEveryMs: 60_000,
  sweepBatch: 100,
  webhookTimeoutMs: 5_000,
  commentLength: 2_000,
} as const;

export const MOCK_CAPTCHA_PREFIX = 'mock-captcha-';
