import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

/** Least to most serious. An area set to a level records that level and everything more serious. */
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The parts of the product an organisation can listen to, each with a level
 * of its own (what AEM calls a logger). The words are what the settings show.
 */
export const LOG_AREAS = {
  submissions: 'Responses coming in',
  workflow: 'Workflow and automations',
  connectors: 'Connectors',
  mail: 'Email',
  signatures: 'Signatures',
  'sign-in': 'Sign-in and single sign-on',
  portal: 'Requests portal',
  extensions: 'Extensions (your own code)',
  gateway: 'Gateways',
  audit: 'Changes people made (audit)',
} as const;
export type LogArea = keyof typeof LOG_AREAS;
export const isLogArea = (v: unknown): v is LogArea => typeof v === 'string' && Object.prototype.hasOwnProperty.call(LOG_AREAS, v);

/**
 * One line of an organisation's log: what the product did on its behalf and
 * how it went. Never an answer from a form, a password or a key: a line says
 * which form, which response and which step, and leaves the content out.
 */
@Schema({ collection: 'org_logs', minimize: false })
export class OrgLog {
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) at: Date;
  @Prop({ required: true, enum: LOG_LEVELS }) level: LogLevel;
  /** 10, 20, 30, 40: so "this level and above" is one comparison. */
  @Prop({ required: true }) rank: number;
  @Prop({ required: true }) area: string;
  @Prop({ required: true }) message: string;
  /** A few named facts: form, reference, step, status, milliseconds. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) context: Record<string, string | number | boolean>;
  /** When the line is removed (the organisation's own choice of how long to keep them). */
  @Prop({ required: true }) expiresAt: Date;
}
export type OrgLogDocument = HydratedDocument<OrgLog>;
export const OrgLogSchema = SchemaFactory.createForClass(OrgLog);
OrgLogSchema.index({ orgId: 1, at: -1 });
OrgLogSchema.index({ orgId: 1, area: 1, at: -1 });
OrgLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
