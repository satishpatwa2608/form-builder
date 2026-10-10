import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';

export interface ListItem {
  /** What is stored in a response. Fixed once made, so a renamed item does not orphan old answers. */
  value: string;
  label: string;
  /** For a list that depends on another: the value there that this item belongs to. */
  parent?: string;
  /** No longer offered, but kept so old answers still read properly. */
  retired?: boolean;
}

/**
 * Master data: a list of choices kept once for the organisation (branches, departments, products) and used by
 * dropdowns on any number of forms. Forms read it as it is now, so a change reaches every form at once.
 */
@Schema({ timestamps: true, collection: 'shared_lists' })
export class SharedList {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  /** How forms name it (`/lists/<key>`). Fixed once made. */
  @Prop({ required: true }) key: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: String, default: '' }) description: string;
  /** The key of the list whose choice narrows this one (cities of a state), or ''. */
  @Prop({ type: String, default: '' }) dependsOn: string;
  @Prop({ type: MongooseSchema.Types.Mixed, default: [] }) items: ListItem[];
  @Prop({ required: true }) updatedBy: string;
  updatedAt: Date;
}
export type SharedListDocument = HydratedDocument<SharedList>;
export const SharedListSchema = SchemaFactory.createForClass(SharedList);
SharedListSchema.index({ orgId: 1, key: 1 }, { unique: true });
