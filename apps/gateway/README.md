# Gateway agent

Runs inside a customer's network, next to databases Form Builder's cloud cannot
(and should not) reach. It connects **out** to the API over a WebSocket (TLS),
so no inbound firewall rules are needed, and it keeps connector credentials on
the customer's machine: the cloud only ever stores non-secret settings.

## Run

1. In Studio → Connectors → Gateways, create a gateway. Copy the one-time token.
2. On the machine that can reach the database:

   ```bash
   FB_API_URL=https://api.example.com FB_GATEWAY_TOKEN=fbreg_... node dist/main.js
   ```

   The first run trades the token for a long-lived secret stored in
   `gateway.secret` (mode 0600). Later runs need only `FB_API_URL`.
3. Create a connector with "Where it runs" = this gateway. The card shows its
   credentials key; add the credentials to `connectors.json` (chmod 600):

   ```json
   { "ab12cd34ef": { "host": "db.internal", "port": "5432", "user": "forms_ro", "password": "..." } }
   ```

   **Where it connects is decided here, not in the cloud:** `host`, `port`,
   `ssl`, `verifyCertificate`, `url`, `baseUrl`, `auth` and `apiKeyHeader` are taken from this file.
   If the cloud connector has one of them and this file doesn't, the request is
   refused - so nobody who can edit the connector online can redirect your
   credentials to another server. `allowedHosts` (comma-separated) may be set
   here for REST connectors. AWS connectors don't run through a gateway.

   The file is re-read on every request, so no restart is needed.

| Variable | Default | |
| --- | --- | --- |
| `FB_API_URL` | – | required, https |
| `FB_GATEWAY_TOKEN` | – | first run only |
| `FB_GATEWAY_SECRET_FILE` | `./gateway.secret` | |
| `FB_CREDENTIALS_FILE` | `./connectors.json` | |
| `FB_GATEWAY_ALLOW_INSECURE` | `false` | local development only (http/ws) |

## Security

- Only the operations and fields exposed in Studio are ever requested; the same
  checks (read-only, row limits, timeouts) also run on the agent.
- Private network addresses are allowed here (that is the point); the cloud
  path still blocks them.
- Revoking the gateway in Studio disconnects it immediately (close code 4001)
  and the agent stops.
- Driver errors are reduced to their kind before being sent back, so
  credentials in error messages never leave the network.
