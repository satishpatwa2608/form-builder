# Operations runbook

For whoever runs the hosted platform. Nothing here is provisioned yet — see
`infra/README.md` for the decisions that come first.

## Services

| Service | Build | Run | Notes |
|---|---|---|---|
| API | `pnpm --filter @fb/api build` | `node dist/main.js` | Stateless; MongoDB holds sessions, rate limits, drafts, usage |
| Studio | `pnpm --filter @fb/studio build` | static `dist/` | `VITE_API_URL`, `VITE_RUNTIME_HOST` |
| Runtime | `pnpm --filter @fb/runtime build` | static `dist/` | `VITE_API_URL`, `VITE_STUDIO_URL`; serve `index.html` for every path (SPA) |
| Gateway agent | `pnpm --filter @fb/gateway build` | customer-side | `apps/gateway/README.md` |

Health: `GET /health`.

## Configuration (API)

All settings are validated at start-up (`apps/api/src/config.ts`); a bad value
stops the process. Production refuses to start without `COOKIE_SECURE=true`,
`MAIL_PROVIDER=ses`, `STORAGE_PROVIDER=s3`, `KMS_KEY_ID`. See
`apps/api/.env.example` for the full list. Development-only switches
(`CONNECTOR_ALLOW_PRIVATE_NETWORK`, `SSO_ALLOW_INSECURE_ISSUER`,
`FORM_ALLOW_MOCK_CAPTCHA`) are ignored or refused in production.

Secrets (`JWT_SECRET`, `SECRET_KEY`) come from Secrets Manager; AWS access is
by IAM role only — never access keys in env.

## Plans

Until a billing provider is connected, put an org on a plan with:

```bash
MONGODB_URL=... pnpm --filter @fb/api set-plan <orgId> <FREE|TEAM|BUSINESS|ENTERPRISE>
```

The change is written to the org's audit log as `operator:<your user>` and
takes effect within a minute. Limits live in `apps/api/src/plans/plans.ts`
(placeholder numbers until pricing is decided). `DEFAULT_PLAN` applies to orgs
with no plan set.

## Custom domains

The API only proves ownership (TXT `_formbuilder.<host>`) and maps host → org.
Serving HTTPS on a customer host needs, at the edge:

- a CNAME target for customers (e.g. `forms-edge.<our domain>`), and
- certificates issued per verified host (CloudFront + ACM with a Lambda to
  request/validate certificates, or a proxy with on-demand TLS such as Caddy
  that asks the API `GET /public/domains/:host` before issuing).

Decision pending (infra/README.md). The runtime then resolves the org from its
own host name, and the API allows CORS for verified hosts on `/public/*` only.

## Single sign-on

Nothing to operate: each org configures its provider. The callback URL is
`<API_URL>/auth/sso/callback`. Provider calls use the same SSRF protection as
connectors (https, public addresses only).

SAML 2.0 is the other choice. Each organisation has its own addresses:
`<API_URL>/auth/sso/saml/<org>/metadata` (also its identifier) and
`<API_URL>/auth/sso/saml/<org>/acs`, where the provider posts its answer
through the person's browser. Three things to know when hosting it:

- The API must be served over **https**. The cookie that ties an answer to
  the browser that asked is `SameSite=None; Secure`, because the provider
  posts from its own site; a browser will not keep it on plain http (apart
  from localhost).
- Our server never calls the provider: nothing to allow outbound.
- An answer is accepted only if its statement is signed with the certificate
  the organisation saved, names that provider and this organisation's
  identifier, is in time (two minutes of clock difference are allowed, so
  keep the servers' clocks set), and answers the request that browser made.
  Answers nobody asked for (provider-started sign-in) are refused. Requests
  are not signed and encrypted statements are not accepted: neither is set up.

## An organisation's own mail server

Each organisation sets this up itself (Organisation → Email sending). What
the hosting has to allow:

- The API and the worker connect **out** to the organisation's mail server
  on port 587, 465, 25 or 2525, and to `login.microsoftonline.com` and
  `graph.microsoft.com` on 443. Many cloud networks block outbound port 25
  by default; 587 is the one nearly everyone uses.
- The server's name is looked up and checked before connecting: private and
  loopback addresses are refused, the connection is always encrypted, and
  the certificate must be valid. `MAIL_ALLOW_INSECURE=true` lifts those
  three for a mail server on a developer's machine; it is ignored when
  `NODE_ENV=production`.
- Passwords and client secrets are sealed with `SECRET_KEY`, like connector
  credentials, and never returned by the API.
- A failed send is logged as `own mail failed for org <id>: <reason>` with a
  reason word only (`SIGN_IN`, `CONNECT`, `SECURITY`, `REFUSED`, `ADDRESS`),
  never the message or the server's reply.

## Gateways

Agents connect to `wss://<api>/gateway/connect`. The load balancer must allow
WebSocket upgrades and an idle timeout above 30 s (the API pings every 30 s).
With more than one API instance, a gateway is connected to one of them: until
routing between instances is added, run a single API instance or pin
`/gateway/connect` and connector calls with sticky routing.

**Several API servers.** An agent holds one connection, to whichever API server
it reached. A request that lands on another server, or a job in the worker, is
passed to that server through the database (`gateway_calls`, emptied as calls
are answered) and adds about a tenth of a second. No sticky routing is needed
at the load balancer. A gateway shows as connected on every server while its
agent has been heard from in the last 75 seconds.

## Extensions (a customer's own code)

A customer's custom code never runs inside the API. It is a container of its
own, written against `@fb/sdk` ([docs/extensions.md](extensions.md)), that the
API calls over the private network.

- **Network:** the container must be reachable from the API and the worker,
  and from nothing else. It must not be able to reach MongoDB, the object
  store or other customers' containers. Give it outbound access only to what
  that customer has agreed.
- **Install** (issues the secret, shown once):
  ```
  pnpm --filter @fb/api extension install <orgId> http://<host>:<port>
  ```
  Start the container with the `FB_EXTENSION_SECRET` and `FB_ORG_ID` it
  prints, then `extension sync <orgId> <ref>` (or the customer's admin chooses
  Read again on the Extensions page).
- **List / remove:** `extension list <orgId>`, `extension remove <orgId> <ref>`.
  After a removal, forms that name its steps or checks cannot be published,
  and live forms that run one of its checks refuse submissions.
- The address is set only by this command, never by the customer: it points
  inside our network. The command uses the API's own environment
  (`MONGODB_URL`, `SECRET_KEY` or `KMS_KEY_ID`) and is recorded in the
  customer's audit log.
- **Health:** `GET /fb/health` on the container. The API records
  `UNREACHABLE` on the extension when a call fails; the customer's admins see
  it on their Extensions page.
- **Limits:** 15 s for a workflow step (retried by the job queue like any
  step), 5 s for a list or a check, 1 MB per request and reply.
- **Docker:** `pnpm stack ext deploy <project> <orgId> <repository>` builds a
  customer's repository, runs it locked down on a private network, installs it
  and reads what it offers, for a shared or a dedicated installation. See
  [hosting.md](hosting.md). A production orchestrator, registry and build
  service are still to do and wait on the hosting decisions in status.md.
- **Plans:** `extensions` in `apps/api/src/plans/plans.ts` says how many an
  organisation may have. Installing one past the limit is refused.

## Uploads and malware scanning

Every upload is checked by its real content type before it can be attached.
Set `FILE_SCANNER=clamav` (with `CLAMAV_HOST`, `CLAMAV_PORT`, default 3310)
to also send each file to a ClamAV daemon:

- a clean file is attached as usual;
- an infected file is deleted and refused;
- if the daemon is down, slow (30 s) or gives an unexpected answer, the
  upload is refused with "could not be checked" and can be retried.

The default is `none`: no malware scan. The daemon must be reachable from
the API only; it needs no access to storage, because the API streams each
file to it. Scanning reads the whole file into memory (uploads are capped at
25 MB each).

CAPTCHA secrets: `FORM_RECAPTCHA_SECRET`, `FORM_TURNSTILE_SECRET`,
`FORM_HCAPTCHA_SECRET`. A form whose provider has no secret set is refused,
never waved through.

## Background work

Automations and webhook deliveries are stored as jobs in the `jobs` collection
before they are attempted, so they survive a restart. A job is retried with a
growing delay (30 s, 1 min, 2 min ... up to 1 hour) when it fails or its
process dies: automations get 3 attempts, webhook deliveries 5. After that it
stays in the collection as `FAILED` with its last error for 30 days; finished
jobs are removed after 7 days.

`JOBS_ROLE` decides which process runs them:

| Value | Use |
|---|---|
| `all` (default) | One process stores and runs jobs. Development, or a single API server. |
| `enqueue` | The API only stores jobs. Needs a worker beside it. |
| `run` | Set by the worker itself. |

The worker is the same build as the API, started with `node dist/worker`
(`pnpm dev:worker` locally). It has no HTTP port. It also runs the SLA sweep.
Several workers can run at once; each job is claimed by one of them.

Before splitting the API and the worker, note one limit: an automation step
that calls a connector through a gateway only works in the process the
gateway is connected to, which is the API. Until gateway calls are routed
between processes, keep `JOBS_ROLE=all` if any form uses such a step.

To see what is stuck: `db.jobs.find({ status: 'FAILED' })`. To run one again,
set its `status` to `PENDING`, `attempts` to 0 and `runAt` to now.

## Data retention

- Drafts (save & resume): deleted 30 days after the last save (TTL index), or on submit.
- SSO sign-in state: 10 minutes (TTL index).
- Usage and analytics: daily counts only, no personal data.
- Submissions and audit log: kept until a retention policy is decided (open question in docs/plan.md).

## Incident basics

- Suspected credential leak for a connector: rotate it in the customer's
  system, then **Credentials → Replace** (new data key each time).
- Compromised gateway: **Revoke** in Studio (disconnects immediately), create a
  new one, re-register the agent.
- Session theft: refresh-token reuse already revokes the session; users can
  change password (other sessions end).
