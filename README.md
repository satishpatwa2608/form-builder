# Form Builder

A hosted form platform: build forms, connect them to your own data (MongoDB, Postgres, MySQL, Supabase, REST, AWS — directly or through a gateway inside your network), and run every submission as a work item with SLAs, approvals and automations. Security first.

- Plan and reasoning: [docs/plan.md](docs/plan.md)
- For customer admins: [docs/guide.md](docs/guide.md)
- For whoever runs the platform: [docs/operations.md](docs/operations.md)
- Infrastructure and the decisions it waits on: [infra/README.md](infra/README.md)

## Layout

| Path | What |
|---|---|
| `apps/api` | NestJS API: auth, orgs, permissions, forms, submissions, work items, connectors, gateways, plans, branding, domains, SSO, audit (port 4100). Also the worker: the same app without HTTP, running queued jobs (`pnpm dev:worker`) |
| `apps/studio` | React designer app: builder, forms, work inbox & dashboard, connectors, members, access, audit, organisation settings (port 5173) |
| `apps/runtime` | React public form page: `/f/:org/:CODE`, or `/:CODE` on a customer's own domain (port 5174) |
| `apps/gateway` | Agent that runs inside a customer network and runs connector operations there ([README](apps/gateway/README.md)) |
| `packages/engine` | Form + workflow rules shared by all apps (ported from Sangam form-platform) |
| `packages/connectors` | Connector contract, registry, plugins, gateway protocol |
| `packages/ui` | Design tokens |
| `infra` | AWS plan (nothing provisioned) |

## Getting started

Node 20+ and pnpm 9 (`corepack enable`).

```bash
pnpm install
pnpm --filter @fb/engine --filter @fb/connectors build   # packages the api uses at runtime
cp apps/api/.env.example apps/api/.env                    # fill JWT_SECRET, SECRET_KEY, MONGODB_URL
pnpm dev:api       # http://localhost:4100/health
pnpm dev:studio    # http://localhost:5173
pnpm dev:runtime   # http://localhost:5174/f/<orgId>/<FORM_CODE>
pnpm test          # engine, connectors, api (unit + e2e on in-memory MongoDB), studio, runtime
pnpm typecheck
```

Emails are printed in the API log until `MAIL_PROVIDER=ses`.

## API

Every route needs a signed-in session unless marked public. The guard re-checks the session and membership on every request; permissions are checked per route and, for forms, per folder.

| Area | Endpoints |
|---|---|
| Auth (public) | `POST /auth/signup`, `/verify-email`, `/resend-verification`, `/login`, `/refresh`, `/forgot-password`, `/reset-password`; `POST /auth/sso/start` (studio origin only), `GET /auth/sso/callback` |
| Auth | `GET /auth/me`, `POST /auth/logout`, `/switch-org`, `/password`, `/2fa/setup`, `/2fa/enable`, `/2fa/disable` |
| Organisation | `GET/PATCH /org`, `POST /orgs`, `GET /org/usage`, `GET/PUT /org/branding`, `GET/POST /org/domains`, `POST /org/domains/:host/verify`, `DELETE /org/domains/:host`, `GET/PUT /org/sso` |
| Members | `GET /members`, `PATCH/DELETE /members/:userId`, `GET/POST /invitations`, `DELETE /invitations/:id`, `POST /invitations/accept` (public) |
| Access | `GET/POST /folders`, `PATCH/DELETE /folders/:id`, `GET /folders/:id/permissions`, `GET/POST /grants`, `DELETE /grants/:id` |
| Forms | `GET/POST /forms`, `POST /forms/import`, `GET/PUT/DELETE /forms/:id`, `GET /forms/:id/versions`, `/export`, `/stats`, `/submissions`, `/submissions/:sid/files/:uploadId`; `POST /forms/:id/publish`, `/new-version`, `/archive`; `PATCH /forms/:id/folder` |
| Styles | `GET /styles`, `PUT/DELETE /styles/:key` |
| Work | `/work-forms`, `/records/...` (inbox, record detail, actions, approvals, comments, files, dashboard, views, working time, webhooks), `/notifications` |
| Connectors | `GET /connectors`, `/connectors/types`, `/connectors/sources`, `POST /connectors`, `/connectors/query`, `PATCH/DELETE /connectors/:id`, `PUT /connectors/:id/secrets`, `/entities`, `POST /connectors/:id/test`, `/discover`, `GET /connectors/:id/calls` |
| Gateways | `GET/POST /gateways`, `DELETE /gateways/:id`, `POST /gateways/register` (agent, public); WebSocket `/gateway/connect` |
| Public form page | `GET /public/forms/:code`, `POST /public/forms/:code/submissions`, `/uploads`, `/events`, `/drafts`; `GET/DELETE /public/forms/:code/drafts/:token`; `POST /public/uploads/:id/verify`, `/public/data-sources/query`; `GET /public/orgs/:org/branding`, `/public/domains/:host` |
| Health | `GET /health` |

### Security behaviour

- **Passwords:** argon2id, ≥10 characters; 5 wrong attempts lock for 15 minutes; answers never reveal whether an account exists.
- **Sessions:** 15-minute access tokens held in memory; refresh token in an httpOnly SameSite=strict cookie, rotated on every use, replay revokes the session.
- **Two-factor:** TOTP with replay protection and 10 recovery codes; an org can require it. SSO sessions count as two-factor (the provider does the authentication) and are valid for that org only.
- **SSO:** OpenID Connect code flow with PKCE and a confidential client; started only by a POST from a studio origin and bound to the starting browser by a cookie (no login CSRF); identity from the provider's userinfo endpoint; trusted only for email domains the org has proven with a DNS TXT record (one org per domain); requiring SSO unlocks only after one successful SSO sign-in.
- **Access:** deny by default; org roles plus folder/connector grants inherited downwards; nobody can give a role they don't hold.
- **Audit log:** append-only at the model level, secrets redacted, logo bytes never logged.
- **Connectors:** credentials envelope-encrypted (KMS in production); SSRF protection (https only, private addresses blocked, no redirects, 2 MB cap); parameterised queries; only exposed entities/fields/operations; read-only unless allowed; every call logged without values. Gateway connectors keep credentials — and the host/URL they are sent to — on the customer's machine.
- **Public forms:** rate-limited (MongoDB-backed limiter, safe across instances), payload shape checks, uploads verified by content, CAPTCHA, monthly response quota per plan (reserved atomically). Save-and-resume tokens are rotated on every save and sent to the API in request bodies, not URLs.
- **Custom domains:** proven by a DNS TXT record; such origins get CORS on `/public/*` only, never with credentials.

## Status (1 October 2026)

Done and tested (API 60 e2e/unit tests, studio 74, runtime 2, engine 68, connectors 15):

- **Phase 1a** foundation: auth, two-factor, orgs, invitations, roles, folders, grants, audit.
- **Phase 1b** product port: builder, versions, styles, runtime, submissions, uploads, work items (inbox, dashboard, SLA, approvals, automations, webhooks, notifications).
- **Phase 2a** connectors: MongoDB, Postgres, MySQL, Supabase, REST, S3, CloudWatch; discovery, exposure, dropdown/prefill/submit bindings, custom automation steps.
- **Phase 2b** gateway agent: registration, outbound WebSocket, remote operations, revoke.
- **Phase 3** productisation: plans & limits with a usage page; form analytics (opened/started/submitted); branding (logo, colour, "Powered by"); custom domains (TXT verification, runtime + CORS); save & resume; print / save-as-PDF of a submission; form export/import packages; OIDC single sign-on; docs.

Not done — needs a decision, an account or more time:

- **Billing provider** (Razorpay/Stripe): needs the account and pricing. Until then plans are set with `pnpm --filter @fb/api set-plan <orgId> <PLAN>`; the limits in `apps/api/src/plans/plans.ts` are placeholders.
- **Infrastructure** (AWS account, domains, Terraform vs CDK, TLS for custom domains): see infra/README.md.
- **PDF as document of record**: a submission prints to PDF from the browser; server-side generation and storage through a file connector is not built.
- SAML (only OIDC), multi-language forms, per-field drop-off analytics, onboarding tour, external penetration test, DPDP documents.
