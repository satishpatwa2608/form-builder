import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * An organisation's deploy key: what its pipeline shows in place of a signed-in administrator, to push and
 * deploy its extension and nothing else. One per organisation; only its hash is kept.
 */
@Schema({ collection: 'extension_deploy_keys', timestamps: true })
export class ExtensionDeployKey {
  @Prop({ required: true, unique: true }) orgId: string;
  @Prop({ required: true, unique: true }) hash: string;
  /** The last four characters, to tell one key from another on screen. */
  @Prop({ required: true }) hint: string;
  @Prop({ required: true }) createdBy: string;
  @Prop({ type: Date, default: null }) lastUsedAt: Date | null;
  createdAt?: Date;
}
export type ExtensionDeployKeyDocument = HydratedDocument<ExtensionDeployKey>;
export const ExtensionDeployKeySchema = SchemaFactory.createForClass(ExtensionDeployKey);
