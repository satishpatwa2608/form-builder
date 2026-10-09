import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** Monthly totals per org, for plan quotas. */
@Schema({ collection: 'usage_months' })
export class UsageMonth {
  @Prop({ required: true }) orgId: string;
  /** YYYY-MM (UTC). */
  @Prop({ required: true }) month: string;
  @Prop({ type: Number, default: 0 }) submissions: number;
}
export type UsageMonthDocument = HydratedDocument<UsageMonth>;
export const UsageMonthSchema = SchemaFactory.createForClass(UsageMonth);
UsageMonthSchema.index({ orgId: 1, month: 1 }, { unique: true });

/** Daily funnel per form: opened, started filling in, submitted. Counts only - nothing about who. */
@Schema({ collection: 'form_stats' })
export class FormStat {
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) code: string;
  /** YYYY-MM-DD (UTC). */
  @Prop({ required: true }) day: string;
  @Prop({ type: Number, default: 0 }) views: number;
  @Prop({ type: Number, default: 0 }) starts: number;
  @Prop({ type: Number, default: 0 }) submissions: number;
  /**
   * How long the form took to appear for real visitors that day: how many reported, the total (for an
   * average), and how many fell in each band (for "what share were quick"). Milliseconds.
   */
  @Prop({ type: Number, default: 0 }) loads: number;
  @Prop({ type: Number, default: 0 }) loadMsTotal: number;
  @Prop({ type: Number, default: 0 }) loadUnder1s: number;
  @Prop({ type: Number, default: 0 }) loadUnder2s: number;
  @Prop({ type: Number, default: 0 }) loadUnder4s: number;
}
export type FormStatDocument = HydratedDocument<FormStat>;
export const FormStatSchema = SchemaFactory.createForClass(FormStat);
FormStatSchema.index({ orgId: 1, code: 1, day: 1 }, { unique: true });

/**
 * Per field, per day: how many visits answered it, saw a mistake on it, or
 * left the form with it as the last thing touched. Counts only.
 */
@Schema({ collection: 'form_field_stats' })
export class FormFieldStat {
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) code: string;
  /** YYYY-MM-DD (UTC). */
  @Prop({ required: true }) day: string;
  @Prop({ required: true }) field: string;
  @Prop({ type: Number, default: 0 }) answered: number;
  @Prop({ type: Number, default: 0 }) mistakes: number;
  @Prop({ type: Number, default: 0 }) leftAt: number;
}
export type FormFieldStatDocument = HydratedDocument<FormFieldStat>;
export const FormFieldStatSchema = SchemaFactory.createForClass(FormFieldStat);
FormFieldStatSchema.index({ orgId: 1, code: 1, day: 1, field: 1 }, { unique: true });
