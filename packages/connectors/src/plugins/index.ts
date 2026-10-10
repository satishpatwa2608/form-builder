import { ConnectorRegistry } from '../registry';
import { cloudWatchPlugin, s3Plugin } from './aws';
import { mongodbPlugin } from './mongodb';
import { restPlugin } from './rest';
import { soapPlugin } from './soap';
import { db2Plugin, mssqlPlugin, mysqlPlugin, oraclePlugin, postgresPlugin } from './sql';
import { odataPlugin } from './odata';
import { salesforcePlugin } from './salesforce';
import { googleSheetsPlugin } from './google-sheets';
import { excelPlugin, microsoftFilesPlugin } from './microsoft';
import { azureBlobPlugin } from './azure-blob';
import { supabasePlugin } from './supabase';

export { buildSql } from './sql';
export { parseResources } from './rest';
export { parseWsdl, soapEnvelope, soapRows, wsdlImports } from './soap';
export { odataLiteral, parseMetadata } from './odata';
export { buildSoql, soqlLiteral } from './salesforce';
export { setGoogleEndpoints, spreadsheetId } from './google-sheets';
export { filesFor, safeFileName, setMicrosoftEndpoints, shareToken } from './microsoft';
export { columnName, columnNames, rowFor, rowsFrom, safeCell } from './sheets-shared';
export { assertPublicHost, isPrivateAddress, lastingSignIn, mongoHosts, safeFetch } from './shared';
export { setAwsFactories, setStsFactory } from './aws';
export { closeMongoConnections } from './mongodb';
export { closeSqlConnections } from './sql';

export const ALL_PLUGINS = [mongodbPlugin, postgresPlugin, mysqlPlugin, mssqlPlugin, oraclePlugin, db2Plugin, supabasePlugin, restPlugin, soapPlugin, odataPlugin, salesforcePlugin, googleSheetsPlugin, excelPlugin, microsoftFilesPlugin, azureBlobPlugin, s3Plugin, cloudWatchPlugin];

/** A registry with every connector type of the first release. */
export function defaultRegistry(): ConnectorRegistry {
  const reg = new ConnectorRegistry();
  for (const p of ALL_PLUGINS) reg.register(p);
  return reg;
}
