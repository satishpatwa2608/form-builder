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
}
export type FormStatDocument = HydratedDocument<FormStat>;
export const FormStatSchema = SchemaFactory.createForClass(FormStat);
FormStatSchema.index({ orgId: 1, code: 1, day: 1 }, { unique: true });
