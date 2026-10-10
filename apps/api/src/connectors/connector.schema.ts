import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, type HydratedDocument } from 'mongoose';
import { CONNECTOR_TYPES, type ConnectorType, type OperationKind } from '@fb/connectors';

@Schema({ _id: false })
export class ExposedEntity {
  @Prop({ required: true }) key: string;
  @Prop({ required: true }) label: string;
  @Prop({ type: [String], default: [] }) fields: string[];
  @Prop({ type: String, default: '' }) keyField: string;
  /** What forms may do with it (writes also need the connector to be writable). */
  @Prop({ type: [String], default: [] }) operations: OperationKind[];
  /** Dropdowns built on it use these by default. */
  @Prop({ type: String, default: '' }) valueField: string;
  @Prop({ type: String, default: '' }) labelField: string;
  /**
   * What the source said about each exposed field when it was last looked at: its kind, whether it may be left
   * empty, the longest text it takes. A form started from the table begins with these limits.
   */
  @Prop({ type: [{ name: String, type: { type: String }, nullable: Boolean, maxLength: Number, hasDefault: Boolean, _id: false }], default: [] })
  about: { name: string; type?: string; nullable?: boolean; maxLength?: number; hasDefault?: boolean }[];
}

@Schema({ _id: false })
export class LastTest {
  @Prop({ type: Date }) at: Date;
  @Prop({ type: Boolean }) ok: boolean;
  @Prop({ type: String, default: '' }) message: string;
  @Prop({ type: Number, default: 0 }) latencyMs: number;
}

@Schema({ timestamps: true, collection: 'connectors', minimize: false })
export class Connector {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, index: true }) orgId: string;
  /** Short, stable reference used in form definitions (data source keys, step keys). */
  @Prop({ required: true }) ref: string;
  @Prop({ required: true, enum: CONNECTOR_TYPES }) type: ConnectorType;
  @Prop({ required: true }) name: string;
  /** Non-secret settings: host, database, region, base URL... */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) settings: Record<string, string | number | boolean>;
  /** Credentials sealed with the data key. Never returned by the API. */
  @Prop({ type: String, default: '' }) sealedSecrets: string;
  /** The data key, wrapped by KMS (or the local key in development). */
  @Prop({ type: String, default: '' }) wrappedKey: string;
  @Prop({ type: String, enum: ['local', 'kms'], default: 'local' }) keyProvider: 'local' | 'kms';
  @Prop({ type: Boolean, default: false }) writable: boolean;
  /** Set: calls go through this gateway agent, which holds the credentials (none are stored here). */
  @Prop({ type: String, default: '' }) gatewayId: string;
  @Prop({ type: [String], default: [] }) allowedHosts: string[];
  @Prop({ type: [ExposedEntity], default: [] }) entities: ExposedEntity[];
  @Prop({ type: LastTest, default: null }) lastTest: LastTest | null;
  @Prop({ required: true }) createdBy: string;
  @Prop({ type: Boolean, default: false }) isDeleted: boolean;
}
export type ConnectorDocument = HydratedDocument<Connector>;
export const ConnectorSchema = SchemaFactory.createForClass(Connector);
ConnectorSchema.index({ orgId: 1, ref: 1 }, { unique: true });

/** One call through a connector (values are never stored). Kept 90 days. */
@Schema({ collection: 'connector_calls', timestamps: { createdAt: 'at', updatedAt: false } })
export class ConnectorCall {
  @Prop({ required: true }) orgId: string;
  @Prop({ required: true }) connectorId: string;
  @Prop({ required: true }) entity: string;
  @Prop({ required: true }) kind: string;
  /** Who or what: a user id, `form:<code>` (public form) or `automation:<ref>`. */
  @Prop({ type: String, default: '' }) actor: string;
  @Prop({ required: true }) ok: boolean;
  @Prop({ type: Number, default: 0 }) durationMs: number;
  @Prop({ type: Number, default: 0 }) rows: number;
  @Prop({ type: String, default: '' }) error: string;
  at: Date;
}
export type ConnectorCallDocument = HydratedDocument<ConnectorCall>;
export const ConnectorCallSchema = SchemaFactory.createForClass(ConnectorCall);
ConnectorCallSchema.index({ orgId: 1, connectorId: 1, at: -1 });
ConnectorCallSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
