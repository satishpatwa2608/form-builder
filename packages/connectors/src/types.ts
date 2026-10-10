import type { z } from 'zod';

/** Connector types in the first release (docs/plan.md, section 5.2). */
export const CONNECTOR_TYPES = ['mongodb', 'postgres', 'mysql', 'mssql', 'oracle', 'db2', 'supabase', 'rest', 'soap', 'odata', 'salesforce', 'google-sheets', 'excel', 'microsoft-files', 'azure-blob', 'aws-s3', 'aws-cloudwatch'] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export type OperationKind = 'list' | 'get' | 'lookup' | 'insert' | 'update' | 'upload' | 'log';
export const WRITE_OPERATIONS: readonly OperationKind[] = ['insert', 'update', 'upload', 'log'];

/** A configured connection as stored for an org. Secrets are NOT here - only a reference to the encrypted blob. */
export interface ConnectorRecord {
  id: string;
  orgId: string;
  type: ConnectorType;
  name: string;
  /** Non-secret settings: host, port, database, region, base URL... */
  settings: Record<string, string | number | boolean>;
  /** Pointer to the KMS-encrypted credentials (never the credentials themselves). */
  secretRef: string;
  /** Read-only unless a connector manager switches writes on. */
  writable: boolean;
  /** Optional host allow-list for REST (SSRF defence on top of the private-range block). */
  allowedHosts?: string[];
}

export interface EntityField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array' | 'unknown';
  nullable?: boolean;
  /** The longest text the source takes, when it says. */
  maxLength?: number;
  /** The source fills it in itself when nothing is given (a default, a counter), so nobody has to. */
  hasDefault?: boolean;
  /** The lowest and highest number the source takes, when it says (a rule on the column, or the room its type has). */
  min?: number;
  max?: number;
  /** The shortest text the source takes, when it says. */
  minLength?: number;
  /** What the text must look like, as a regular expression, when the source says. */
  pattern?: string;
}

/** Something a connector exposes: a collection, table, view, REST resource or S3 prefix. */
export interface Entity {
  key: string;
  label: string;
  fields: EntityField[];
}

export interface OperationLimits {
  timeoutMs: number;
  maxRows: number;
}

/** The entity an operation runs on, as the customer exposed it (plugins only touch these fields). */
export interface EntityRef {
  key: string;
  /** Fields that may be read, filtered on or written. Identifiers outside this list are refused. */
  fields: string[];
  /** Field that identifies a row for get/update (e.g. id, _id, email). */
  keyField?: string;
}

export interface OperationRequest {
  entity: EntityRef;
  kind: OperationKind;
  /** Values always bound as parameters by the plugin - never concatenated into a query. */
  params: Record<string, unknown>;
  limits: OperationLimits;
}

export interface OperationResult {
  rows: Record<string, unknown>[];
  /** Rows affected by a write. */
  affected?: number;
  durationMs: number;
}

export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

/**
 * What a plugin gets for one call. `secrets` are decrypted just for this call
 * and must never be logged, returned or put into an error message.
 */
export interface ConnectorContext {
  connector: ConnectorRecord;
  secrets: Record<string, string>;
  signal: AbortSignal;
  /** Development/test only: let REST calls reach private networks (never in production). */
  allowPrivateNetwork?: boolean;
}

/** One connector type. Implementations live in src/plugins/<type>.ts. */
export interface ConnectorPlugin {
  type: ConnectorType;
  label: string;
  /** Validates `settings` when a connector is saved. */
  settingsSchema: z.ZodType;
  /** Validates the credentials when they are entered (before encryption). */
  secretsSchema: z.ZodType;
  /** Operations this type supports at all. */
  operations: readonly OperationKind[];
  test(ctx: ConnectorContext): Promise<TestResult>;
  discover(ctx: ConnectorContext): Promise<Entity[]>;
  run(ctx: ConnectorContext, request: OperationRequest): Promise<OperationResult>;
}
