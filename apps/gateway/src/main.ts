#!/usr/bin/env node
import { startAgent } from './agent';

/**
 * Environment:
 *   FB_API_URL              https://api... (required)
 *   FB_GATEWAY_TOKEN        one-time registration token (first run)
 *   FB_GATEWAY_SECRET_FILE  default ./gateway.secret
 *   FB_CREDENTIALS_FILE     default ./connectors.json
 *   FB_GATEWAY_ALLOW_INSECURE=true   local development only
 *   FB_LOG_FORMAT=json      one JSON line per log entry, for a log collector
 */
const apiUrl = process.env.FB_API_URL;
if (!apiUrl) {
  console.error('Set FB_API_URL');
  process.exit(1);
}
const json = process.env.FB_LOG_FORMAT === 'json';
startAgent({
  apiUrl,
  log: json ? (message) => console.log(JSON.stringify({ at: new Date().toISOString(), level: 'info', service: 'gateway', message })) : undefined,
  registrationToken: process.env.FB_GATEWAY_TOKEN,
  secretFile: process.env.FB_GATEWAY_SECRET_FILE ?? './gateway.secret',
  credentialsFile: process.env.FB_CREDENTIALS_FILE ?? './connectors.json',
  allowInsecure: process.env.FB_GATEWAY_ALLOW_INSECURE === 'true',
  // Revoked: nothing left to do, and open database connections would otherwise keep the process alive.
  // Exit cleanly so a supervisor set to restart on failure does not bring it back.
  onRevoked: () => process.exit(0),
}).catch((e: Error) => {
  console.error(`[gateway] ${e.message}`);
  process.exit(1);
});
