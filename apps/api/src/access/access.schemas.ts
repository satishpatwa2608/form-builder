import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { SCOPED_ROLES, type ScopeType, type ScopedRole } from './roles';

@Schema({ timestamps: true, collection: 'folders' })
export class Folder {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  @Prop({ required: true }) name: string;
  @Prop({ type: String, default: null }) parentId: string | null;
  /** Ancestor ids from the root, then this folder's own id. */
  @Prop({ type: [String], required: true }) path: string[];
  @Prop({ required: true }) createdBy: string;
}
export type FolderDocument = HydratedDocument<Folder>;
export const FolderSchema = SchemaFactory.createForClass(Folder);
FolderSchema.index({ orgId: 1, parentId: 1, name: 1 }, { unique: true });

@Schema({ _id: false })
export class GrantScope {
  @Prop({ required: true, enum: ['folder', 'form', 'connector'] }) type: ScopeType;
  @Prop({ required: true }) id: string;
}

/** A role for one user on one folder, form or connector. */
@Schema({ timestamps: true, collection: 'grants' })
export class Grant {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) userId: string;
  @Prop({ required: true, enum: SCOPED_ROLES }) role: ScopedRole;
  @Prop({ type: GrantScope, required: true }) scope: GrantScope;
  @Prop({ required: true }) createdBy: string;
}
export type GrantDocument = HydratedDocument<Grant>;
export const GrantSchema = SchemaFactory.createForClass(Grant);
GrantSchema.index({ orgId: 1, userId: 1 });
GrantSchema.index({ orgId: 1, userId: 1, role: 1, 'scope.type': 1, 'scope.id': 1 }, { unique: true });
