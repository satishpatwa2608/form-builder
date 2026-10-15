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

Health: `GET /health` (see "Seeing what is happening" below).

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

## Who may start an organisation

`SIGNUP=open` (the default) lets anyone sign up and get an organisation of their own on `DEFAULT_PLAN`.
`SIGNUP=closed` is for an installation sold to named customers:

- Nobody can sign up, except the addresses in `OPERATOR_EMAILS` (comma-separated), who are the people
  running the installation. The sign-in page then offers no account to create.
- An operator adds each customer on the **Customers** page (see below): the customer's name, the plan bought
  and their owner's email. The owner gets an invitation; the operator is never a member of the customer.
- Everyone else joins an organisation by invitation or through its single sign-on, as before.
- A customer cannot add organisations or choose a plan.

An operator is otherwise an ordinary user: being one gives no sight of any customer's organisation.

### The Customers page

Operators have **Customers** in the menu (`/customers`). It lists every organisation on the installation with
its plan, its owners (and anyone invited to own it who has not accepted), how many people, forms and
responses this month it has, and when something was last done in it. From it an operator adds a customer,
changes a customer's plan (recorded in the customer's own audit trail as changed by the operator), and sends
an owner invitation again or to someone else.

It shows size and activity only. It does not open a customer's forms, responses, members or settings, and to
anyone who is not an operator the page and its routes (`/operator/customers`) answer "not found".
Suspending or deleting a customer is not on the page yet.

## Each organisation's log

Organisations read their own log in the studio (Logs). Nothing to operate,
three things to know:

- Lines live in the `org_logs` collection and are removed by a TTL index when
  the organisation's chosen number of days (1 to 30, 14 by default) is up.
- An organisation writes at most 600 lines a minute; beyond that the rest of
  the minute is dropped and one line says so. Debug, the only level that
  writes a lot, switches itself back to Info after at most 24 hours.
- Writing a line never fails or delays the work it describes. A line that
  cannot be written is lost and the server log says `a log line was not
  written`. The server's own log (stdout) is separate and unchanged: it is
  for you, and is not shown to customers.

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

A worker holds a job it took for `JOBS_LEASE_MS` (five minutes by default)
and renews that every third of it while the job runs, so a long job is never
started by a second worker; a worker that lost its lease (paused too long,
say) writes no result and starts no further automation step.

A gateway step works from the worker too: a call for a gateway connected to
another process is handed over through the database (`gateway_calls`).

Outside steps are not silently done twice when a job is taken again after its
worker died between doing a step and recording it: webhook and automation-tool
steps send the same `Idempotency-Key` on every try, an email step skips whoever
it already went to, and a connector write stops with "this may have been done
already" for a person to check (steps are marked in `form_step_marks`, kept 30
days).

**Failed work.** Forms admins see what failed in the last 30 days on the
Overview page ("Work that failed"): jobs that gave up after their tries and
flows that stopped on a failed step, each with "Run again" (a stopped flow
runs again from the step that failed). Operators see a count per customer on
the Customers page. From the shell: `db.jobs.find({ status: 'FAILED' })`.

## Seeing what is happening

**Request IDs.** Every answer carries `x-request-id` (the caller's own when it
sent a sensible one, else a new one). The same ID is stored on the jobs a
request queues, sent on the webhooks, extension calls and gateway calls they
make, and written on every log line, so one response can be followed end to
end. The gateway agent names it when a call fails.

**Logs.** `LOG_FORMAT=json` (the default in production) writes one JSON line
per entry from the API and the worker: `at`, `level`, `service`, `context`,
`message`, `requestId`, `orgId`, plus one `request` line per request with the
method, the route as written in the code (never the address itself: some carry
a token), the status and the time taken. The gateway agent does the same with
`FB_LOG_FORMAT=json`.

**`GET /health`** looks before it answers: the database, how long the oldest
due job has waited, jobs that gave up in the last hour, gateways connected.
It answers 503 only when the database cannot be reached; the rest is reported
for a person or an alert. Counts only, nothing of any organisation's.

**`GET /metrics`** (Prometheus text) needs `Authorization: Bearer
<METRICS_TOKEN>`; without the setting there is no such page. Request times by
method, route and status; responses accepted and refused (and why); jobs by
state, finished by type and outcome, the oldest waiting, failed in the last
hour; connector and extension errors; gateways connected. Labels are fixed
words, never customer data. Counters are per process.

What to alert on first: `/health` not answering or 503; the oldest waiting job
above a few minutes; jobs failing in the last hour.

## Drafting forms with AI

Off unless the installation sets `AI_DRAFT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` (kept with the other
secrets); without them the choice is not shown anywhere. `AI_DRAFT_MODEL` picks the model (default
`claude-opus-5-5`; a smaller model costs less per draft). Then each organisation's admin turns it on under
Organisation settings, and the plan sets a monthly allowance (`aiDraftsPerMonth` in `plans.ts`, placeholder
numbers). Only the description someone types is sent; the answer is read as questions only (anything else is
dropped and said so), checked like any form, and becomes a draft to read and change. A draft that comes back
empty, or a service that fails or takes over a minute, does not count. Each use is in the audit trail
(`form.ai_drafted`, with the description).

## Data retention

- Drafts (save & resume): deleted 30 days after the last save (TTL index), or on submit.
- SSO sign-in state: 10 minutes (TTL index).
- Usage and analytics: daily counts only, no personal data.
- Submissions and audit log: kept until a retention policy is decided (open question in docs/plan.md).

## Getting it back

**Restore drill.** `infra/pilot/restore-drill.sh` (on the Mac) takes the pilot's newest nightly backup (or one
named), restores it into a clean throwaway database, starts the product on it and opens a published form as the
public sees it, then removes everything it made. Nothing on the pilot is touched. First run, 16 October 2026,
on the backup of the 15th: 2 organisations, 4 people, 180 form versions, 45 responses came back; the product
started; "Workshop booking" opened; 15 seconds. Run it monthly, and after any change to backups.

It starts the product with throwaway keys, so it shows the data comes back, not that sealed values open. To
show those too, run it with `DRILL_SECRET_KEY` and `DRILL_KMS_KEY_ID` set to the pilot's own (someone who may
handle them), then open a connector and test it, and sign in with two-factor.

**Keys.** What each one protects, and what losing it costs:

| Key | Where it is kept | Protects | If it is lost |
|---|---|---|---|
| `SECRET_KEY` | parameter store `/fb-pilot/SECRET_KEY` (encrypted) | two-factor secrets, sealed answers, the organisation's SMS / WhatsApp / mail / payment / single-sign-on secrets | all of those are unreadable: people set up two-factor again, admins re-enter those secrets, sealed answers are gone |
| KMS key `alias/fb-pilot` | AWS KMS (cannot be exported) | connector credentials, extension secrets, the certificates that seal PDFs | connector credentials are entered again, extensions get new secrets, PDFs are sealed with new certificates (old ones still verify) |
| `JWT_SECRET` | parameter store | sign-ins (and short-lived code proofs) | everyone signs in again; nothing is lost |

Keep a copy of `SECRET_KEY` and `JWT_SECRET` outside the account (a password manager two people can open). A KMS
key cannot be copied: AWS keeps it, and deleting it waits at least 7 days, so a mistaken deletion can be
cancelled. Changing `SECRET_KEY` (rotation) needs everything it seals opened with the old and sealed with the new;
that is not built yet.

**Rollback.** `infra/pilot/rollback.sh` puts the pilot back on the version released before the one running
(or on a tag given), from the images already in the image store: nothing is built, about a minute. The database
is not rolled back: each version only adds to what is stored, so an older one reads it as before. Work queued by
a newer version for a kind of job an older one does not know waits until the newer version is back.

## Incident basics

- Suspected credential leak for a connector: rotate it in the customer's
  system, then **Credentials → Replace** (new data key each time).
- Compromised gateway: **Revoke** in Studio (disconnects immediately), create a
  new one, re-register the agent.
- Session theft: refresh-token reuse already revokes the session; users can
  change password (other sessions end).
