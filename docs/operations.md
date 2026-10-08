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

## Gateways

Agents connect to `wss://<api>/gateway/connect`. The load balancer must allow
WebSocket upgrades and an idle timeout above 30 s (the API pings every 30 s).
With more than one API instance, a gateway is connected to one of them: until
routing between instances is added, run a single API instance or pin
`/gateway/connect` and connector calls with sticky routing.

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
