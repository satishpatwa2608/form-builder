# Form Builder: product plan (Phase 0 and 1, with the connector roadmap)

**Status:** draft for review · **Date:** 2026-09-30 · **Repo:** `form-builder` (new, separate from prism-sangam)

## 1. What we are building

A hosted form platform in the style of AEM Forms:

- Build forms visually.
- Connect them to customers' own data: MongoDB, Postgres/MySQL, Supabase, REST APIs, and AWS for files and logs.
- Run each submission as a work item with SLAs, approvals and automations.
- Control, for every form, folder and connector, who may do what.

It will be sold as a shared cloud service (SaaS).

**Security comes first.** Customer credentials, customer data and access to customer networks are the product's biggest risk and its main selling point. Every design choice below is judged on that first.

### Decisions taken

| Question | Decision |
|---|---|
| Stack | Same as Sangam: NestJS + MongoDB (API and worker), React + Vite + shadcn (web), pnpm monorepo |
| Relation to Sangam | New, separate repository. Sangam is not changed. The code is copied from Sangam, not shared, so fixes needed in both are ported by hand. |
| Delivery | Shared cloud first; each organisation (tenant) isolated by `orgId` everywhere |
| First connectors | MongoDB, PostgreSQL, MySQL, Supabase, REST, AWS S3 (files), AWS CloudWatch (logs) |
| Customer networks | Allow-listing from one fixed outbound IP at launch, then the gateway agent (section 5.4) straight after the first connectors |

## 2. Architecture

```
form-builder/
  apps/
    studio/      React: builder, connectors, users & roles, work inbox/dashboard, admin
    runtime/     React (small bundle): public / signed-in form filling, served on its own domain
    api/         NestJS: forms, submissions, records, connectors, permissions, audit
    worker/      NestJS (no HTTP): automations, SLA sweeps, connector jobs, webhooks, emails
    gateway/     (Phase 2b) Go or Node agent customers run inside their network
  packages/
    engine/      form + workflow rules (ported from Sangam; used by api, worker, studio, runtime)
    connectors/  one plugin per connector type, behind one interface
    ui/          design system (tokens, themes, components)
  infra/         IaC (Terraform/CDK), Docker images
  docs/
```

**Why split studio and runtime (AEM's Author/Publish):**

- The public form bundle stays small and fast.
- It carries no builder or admin code, so there is less to attack.
- It scales on its own, and it runs on a separate domain (for example `forms.<brand>.com`), so designer cookies never reach public pages.

**Why a separate worker:**

- Connector calls, automations, SLA sweeps and webhooks never block API requests.
- They are retried from a queue. This also solves the retry item Sangam deferred.

**Hosting** (AWS Mumbai, `ap-south-1`, for the DPDP Act):

- Containers on ECS Fargate, and MongoDB Atlas in Mumbai.
- S3 for files and SQS for the job queue.
- Secrets Manager for platform secrets, and KMS to encrypt customer connector credentials.
- CloudWatch for logs and metrics.
- A NAT gateway with **one fixed outbound IP** that customers allow-list.

## 3. Porting from Sangam (what to bring and what to leave)

Source: `prism-sangam/apps/api/src/apps/form-platform` (about 7.6k lines) and `apps/web/src/modules/form-platform` + `work-app` (about 13.9k lines).

| Area | Sangam files | Action |
|---|---|---|
| Engine | `engine/*` (schema, conditions, layout, workflow, working-time, zod builder) | **Port as is** into `packages/engine`; it already has no framework code |
| Forms | `form-definition.service`, `form-version.schema`, `form-master.*` (pages, styles, data sources) | Port; add folders and per-form permissions |
| Submissions and runtime | `form-submission.service`, `form-upload.service`, `security/*` (payload guard, file sniffing), captcha, throttler | Port; move uploads to the S3 connector interface |
| Work items | `form-record.service`, `sla.ts`, `form-calendar.service`, `work-portal.service`, `work-item.service` | Port; visibility goes through the new permission service |
| Automations | `form-automation.service`, `workflows/*` registries, `webhook-client` | Port; run in the worker from a queue, with retries |
| Webhooks | `form-webhook.service` | Port; add a delivery queue with retries |
| Web: builder, runtime, work | `builder/*`, `runtime/*`, `pages/*` (Inbox, Dashboard, Drawer), `styles/*` | Port into studio / runtime |
| **Replace** | Sangam `AuthGuard`, `ModuleAccessGuard`, the `users`/`organizations` collections, `MailService`, notification events, the Tasks-app link, `apiResponse` | Product's own auth, orgs, roles, mailer (SES), in-app notifications |
| **Drop** | `example.data-sources.ts` (Sangam denim data), the hiring or other module ties, Sangam navigation | — |

The copy script from Sangam (`apps/api/scripts/form-transfer.js`) becomes the built-in **form export/import package** used to move forms between environments.

## 4. Users and permissions

### 4.1 Model

- **Organisation (tenant):** holds the plan, limits, branding, domains and security policy (password rules, SSO, IP allow-list for the studio).
- **User:** belongs to one or more organisations through a **membership**, which carries a **role** in each.
- **Role:** a named set of permissions. The built-in roles below can't be deleted; custom roles come later.
- **Folder:** forms live in folders. A permission can be granted per folder (like AEM), for example "Quality designers: edit forms in /Quality".
- **Grant:** `{ subject: user | group, role, scope: org | folder | form | connector }`.

| Role | Main permissions |
|---|---|
| Owner | everything, billing, delete the organisation |
| Admin | users, roles, settings, audit log, all connectors |
| Connector manager | create connectors, edit or rotate credentials, test them |
| Designer | create and edit forms and automations in granted folders; *use* granted connectors (never see their credentials) |
| Publisher | publish, unpublish, export/import |
| Records worker | work the items assigned to them (the Sangam rule: admins see everything, others only their own and the approvals waiting on them) |
| Viewer | read-only |

### 4.2 Rules

- One `PermissionService.can(user, action, resource)` used by every controller. No ad-hoc checks.
- Deny by default; `orgId` always comes from the token.
- Using a connector and managing it are separate permissions: a designer can bind "Customers (Postgres)" to a dropdown without ever seeing its password.
- Every change to users, roles, grants, connectors, forms (publish) or settings writes an **audit log** entry (who, what, when, IP, before and after). The log can't be edited and can be exported.
- Login:
  - email and password (argon2id) with email verification
  - optional TOTP two-factor, which the organisation can make mandatory
  - Google/Microsoft sign-in in Phase 1, SAML/OIDC single sign-on in Phase 3
  - sessions in short-lived JWTs plus refresh tokens that rotate and can be revoked

## 5. Connectors (the "Form Data Model")

### 5.1 Concepts

- **Connector:** a configured connection, e.g. "Sales DB (Postgres)". It holds the type, the non-secret settings (host, port, database, region), **encrypted credentials**, a status and when it was last tested.
- **Entity:** something exposed from a connector (a collection, table, view, REST resource or S3 prefix), with discovered fields and types. The customer chooses which entities to expose; nothing is exposed by default.
- **Operation:** a named, parameterised action on an entity: `list`, `get`, `lookup`, `insert`, `update`, `upload`, `log`. Each has an input and output schema, limits (timeout, maximum rows) and a flag saying whether it writes.
- **Binding** (in the builder), one of:
  - dropdown options ← operation
  - prefill a section ← operation (keyed by a field)
  - on submit → operation (field mapping)
  - automation step → operation
  - file field → S3 upload

### 5.2 Connector types in the first release

| Connector | What it offers | Notes |
|---|---|---|
| MongoDB | Discover collections and fields (sampled); list, find by filter, insert, update | Filters are built from a whitelisted operator set; never raw `$where` or JavaScript |
| PostgreSQL / MySQL | Discover tables and views; list, get, lookup, insert, update | Queries are built by us with parameters only; no free SQL in the first release (a later "custom query" is admin-only, read-only and runs in a read-only transaction) |
| Supabase | Postgres connection (as above) **or** the PostgREST API with a service key; Supabase Storage for files | Recommend a restricted database role, not the service-role key |
| REST | Import an OpenAPI file or define endpoints by hand; auth by API key, Bearer, Basic or OAuth2 client credentials | SSRF protection (section 5.3); response mapping to fields |
| AWS S3 | File fields upload into the customer's bucket (or ours); signed download links | Customer bucket through an **IAM role with an external ID** (cross-account), not access keys |
| AWS CloudWatch | Send submission, audit and automation events into the customer's log group | Also through a cross-account IAM role |

Later: MS SQL, Oracle, Google Sheets, Excel/CSV, SAP (OData), Salesforce, WhatsApp Business, SMTP relay.

### 5.3 Security (non-negotiable for the first release)

1. **Credentials:**
   - Encrypted per organisation with AWS KMS envelope encryption; one data key per connector, the key id stored with the record.
   - Decrypted only inside the worker or API, only while a call is being made.
   - Never logged, never returned by any endpoint (the API returns only "configured ✓"), never sent to a browser.
   - Rotating them is an audited action.
2. **Least privilege:**
   - Connectors are **read-only unless writes are switched on** by a connector manager.
   - The setup screen tells customers to create a dedicated database user with only the rights it needs.
3. **No injection:**
   - Every query is built by the connector from a template with typed parameters.
   - Values from form fields are always bound as parameters, never concatenated into a query.
4. **Server-side request forgery (SSRF):** REST and webhook calls get:
   - DNS resolution with private, loopback and link-local ranges blocked (checked again after DNS resolves)
   - no redirects
   - https only in production
   - response size cap and timeout
   - an optional host allow-list per connector
5. **Network:**
   - All outbound calls leave through the fixed NAT IP.
   - TLS is required, with certificate checks on; custom CA upload for self-signed databases.
6. **Isolation and limits:**
   - Connector calls run in the worker with timeouts, row caps and per-organisation limits, so one noisy tenant can't starve the others.
   - Results are checked against the declared output schema before use.
7. **Audit and visibility:**
   - Every connector call is logged: who, form, operation, duration, row count, success or error. The values themselves are not logged unless the organisation turns that on.
   - A connector health page shows the last test, error rate and latency.
8. **Public forms:**
   - A public form can only use operations a designer bound to it explicitly.
   - The browser never talks to a connector directly; it goes through the runtime, which checks the binding.

### 5.4 Gateway agent (Phase 2b)

For databases that must never be opened to the internet:

- A small agent the customer runs inside their network (Docker image or single binary).
- It opens an **outbound** mutually-authenticated TLS connection to us, so the customer opens no inbound ports.
- It holds or reads the database credentials locally, so the credentials never leave the customer's network.
- It runs only the operations the platform sends, and only against the connectors registered to it.
- It is registered with a one-time token, can be revoked, and reports its health.

## 6. The rest of the product (carried over or planned)

- **Builder** (ported): layout, conditions, validation, versions, themes and styles, templates, CAPTCHA.
- **Work** (ported): statuses, actions, work fields, SLA with working hours, escalation, approvals, email to the requester, Inbox (table/cards), Dashboard, webhooks.
- **New:**
  - Document of record: a PDF of each submission, stored through the file connector.
  - Save and resume for long forms.
  - Form export/import packages (dev → test → production).
  - Multi-language forms (Phase 3).
  - Analytics: views, starts, completions, drop-off per field (Phase 3).

## 7. Phases

**Status, 1 October 2026:** 1a, 1b, 2a, 2b built and tested. Phase 3 built except the billing provider (needs an account and pricing), server-side PDF storage, SAML and the docs *site* (docs are Markdown in `docs/`). Infrastructure and "Before launch" not started. Details in README.md → Status.


| Phase | Weeks | Scope | Done when |
|---|---|---|---|
| **0 – Define** | 1–2 | Customer interviews (8–10), comparison with AEM Forms / Jotform / Kissflow / Zoho, first-release scope, brand name, domain, pricing hypothesis, threat model for connectors and tenancy | Scope and threat model signed off |
| **1a – Foundation** | 3–5 | New repo and CI; `packages/engine` ported with its tests; api/worker/studio/runtime skeletons; orgs, users, sign-up/login/2FA; roles, grants, folders, `PermissionService`; audit log; infrastructure (ECS, Atlas, S3, KMS, SES, CloudWatch) with dev and stage environments | A user signs up, creates an org, invites someone with a role; every action is audited |
| **1b – Port the product** | 6–8 | Builder, runtime, submissions, uploads, work items, SLA, automations (queued in the worker, with retries), Inbox, Dashboard, webhooks, templates | Sangam's complaint-register process runs end to end on the new product |
| **2a – Connectors v1** | 9–13 | Connector framework, KMS credentials, discovery, operations, bindings in the builder; MongoDB, Postgres, MySQL, Supabase, REST, S3, CloudWatch; health page; SSRF and injection tests | A form's dropdown, prefill and submit use a customer Postgres and an S3 bucket; security tests pass |
| **2b – Gateway agent** | 14–16 | Agent, registration, mTLS tunnel, running operations remotely | A private-network database works with no inbound ports opened |
| **3 – Productise** | 17–22 | Plans and limits, billing (Razorpay/Stripe), branding and custom domains, PDF of submissions, save and resume, export/import, SSO (SAML/OIDC), analytics, docs site, onboarding | 2–3 pilot customers live |
| **Before launch** | — | External penetration test, DPDP documents (privacy policy, data processing agreement, retention), backup and restore drill, incident runbook, uptime target | Go-live sign-off |

The week numbers are estimates for 2–3 full-time engineers. They will be re-planned at the end of Phase 0.

## 8. Phase 0 checklist (start now)

- [ ] Brand name and domain. "Form Builder" is the working and repository name; the market name needs to be searchable and ownable.
- [ ] 8–10 interviews with target buyers: which systems they need to connect, and their security requirements.
- [ ] Feature comparison matrix: AEM Forms, Jotform Enterprise, Kissflow, Zoho Creator, Microsoft Forms + Power Automate.
- [ ] First-release scope signed off (this document's Phases 1–2a).
- [ ] Threat model (STRIDE) for: tenant isolation, connector credentials, public forms, file uploads, webhooks, the gateway.
- [ ] AWS account structure (separate prod/stage accounts), Atlas project in Mumbai, KMS keys.
- [ ] Create the `form-builder` repository with the layout from section 2, CI (lint, typecheck, tests, dependency and secret scanning) and branch protection.
- [ ] Team: owner, 2–3 engineers, a designer (part-time), a security reviewer.

## 9. Open questions

1. Brand name for the market.
2. Pricing unit: per user, per submission, per connector, or tiers.
3. Should the first release also let customers self-host the runtime only (forms served from their own domain and infrastructure), or is that a later enterprise add-on?
4. Data retention defaults (for example, submissions kept for 2 years unless the customer sets otherwise).
