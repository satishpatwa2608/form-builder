import { ConnectorRegistry } from '../registry';
import { cloudWatchPlugin, s3Plugin } from './aws';
import { mongodbPlugin } from './mongodb';
import { restPlugin } from './rest';
import { mssqlPlugin, mysqlPlugin, postgresPlugin } from './sql';
import { odataPlugin } from './odata';
import { supabasePlugin } from './supabase';

export { buildSql } from './sql';
export { parseResources } from './rest';
export { odataLiteral, parseMetadata } from './odata';
export { assertPublicHost, isPrivateAddress, mongoHosts, safeFetch } from './shared';
export { setAwsFactories, setStsFactory } from './aws';
export { closeMongoConnections } from './mongodb';
export { closeSqlConnections } from './sql';

export const ALL_PLUGINS = [mongodbPlugin, postgresPlugin, mysqlPlugin, mssqlPlugin, supabasePlugin, restPlugin, odataPlugin, s3Plugin, cloudWatchPlugin];

/** A registry with every connector type of the first release. */
export function defaultRegistry(): ConnectorRegistry {
  const reg = new ConnectorRegistry();
  for (const p of ALL_PLUGINS) reg.register(p);
  return reg;
}
