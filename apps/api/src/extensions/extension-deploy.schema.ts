import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/**
 * One request by a customer to run (or take away) a version of their extension. The API only writes it down:
 * the server's deploy service, the one thing allowed to start containers, picks it up and reports back here.
 */
@Schema({ collection: 'extension_deploys', timestamps: true })
export class ExtensionDeploy {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  @Prop({ required: true, enum: ['DEPLOY', 'REMOVE'] }) kind: 'DEPLOY' | 'REMOVE';
  /** The version asked for: a tag in the organisation's own image space ('' for a removal). */
  @Prop({ type: String, default: '' }) tag: string;
  /** The image in full, written by the API from its own settings: the deploy service runs this and nothing else. */
  @Prop({ type: String, default: '' }) image: string;
  @Prop({ required: true, enum: ['PENDING', 'RUNNING', 'LIVE', 'FAILED', 'REMOVED'], default: 'PENDING' }) status: 'PENDING' | 'RUNNING' | 'LIVE' | 'FAILED' | 'REMOVED';
  /** What happened, in a sentence, and the end of the extension's own output when it would not start. */
  @Prop({ type: String, default: '' }) message: string;
  @Prop({ type: String, default: '' }) output: string;
  @Prop({ required: true }) requestedBy: string;
  @Prop({ type: Date, default: null }) finishedAt: Date | null;
  createdAt?: Date;
}
export type ExtensionDeployDocument = HydratedDocument<ExtensionDeploy>;
export const ExtensionDeploySchema = SchemaFactory.createForClass(ExtensionDeploy);
ExtensionDeploySchema.index({ status: 1, createdAt: 1 });
