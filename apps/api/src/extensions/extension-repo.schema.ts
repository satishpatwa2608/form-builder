import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

/** The repository an organisation's extension is built from, and how it wants that done. One per organisation. */
@Schema({ collection: 'extension_repos', timestamps: true })
export class ExtensionRepo {
  @Prop({ required: true, unique: true }) orgId: string;
  /** Where the code is: the host and the path on it (owner/name), checked against a strict pattern. */
  @Prop({ required: true }) host: string;
  @Prop({ required: true }) path: string;
  @Prop({ required: true, default: 'main' }) branch: string;
  /** Build and deploy whenever that branch changes. */
  @Prop({ required: true, default: false }) auto: boolean;
  /** The read-only key the organisation adds to its repository. The private half is sealed below. */
  @Prop({ required: true }) publicKey: string;
  @Prop({ required: true }) sealed: string;
  @Prop({ required: true }) wrappedKey: string;
  /** The address the repository calls when it changes ends in a token; this is its hash. */
  @Prop({ required: true, unique: true }) hookHash: string;
  /** The branch changed while a build was under way: build once more when it finishes. */
  @Prop({ required: true, default: false }) again: boolean;
  @Prop({ required: true }) connectedBy: string;
}
export type ExtensionRepoDocument = HydratedDocument<ExtensionRepo>;
export const ExtensionRepoSchema = SchemaFactory.createForClass(ExtensionRepo);

/** One build of the repository: started by a person or by a commit, and what came of it. */
@Schema({ collection: 'extension_builds', timestamps: true })
export class ExtensionBuild {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  @Prop({ required: true, enum: ['MANUAL', 'COMMIT'] }) trigger: 'MANUAL' | 'COMMIT';
  @Prop({ required: true }) branch: string;
  /** Known once the build has fetched the code. */
  @Prop({ type: String, default: '' }) commit: string;
  @Prop({ type: String, default: '' }) commitMessage: string;
  @Prop({ required: true, enum: ['BUILDING', 'DEPLOYING', 'LIVE', 'FAILED'], default: 'BUILDING' }) status: 'BUILDING' | 'DEPLOYING' | 'LIVE' | 'FAILED';
  @Prop({ type: String, default: '' }) message: string;
  @Prop({ type: String, default: '' }) output: string;
  /** What the build machine shows to be let in, hashed; and whether it has collected what it needs (once). */
  @Prop({ required: true }) tokenHash: string;
  @Prop({ required: true, default: false }) collected: boolean;
  /** The build machine's own name for this run, to ask after one that never reported. */
  @Prop({ type: String, default: '' }) runId: string;
  /** The deployment it led to. */
  @Prop({ type: String, default: '' }) deployId: string;
  @Prop({ required: true }) startedBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}
export type ExtensionBuildDocument = HydratedDocument<ExtensionBuild>;
export const ExtensionBuildSchema = SchemaFactory.createForClass(ExtensionBuild);
ExtensionBuildSchema.index({ orgId: 1, createdAt: -1 });
