# Form Builder — status and next steps

_Last updated: 1 October 2026_

## What we did

### Foundation (Phase 1a)
- Sign up, sign in, email confirmation, password reset, account lockout after 5 wrong attempts.
- Two-factor sign-in (authenticator app + recovery codes); an org can require it for everyone.
- Organisations, invitations, roles (Owner, Admin, Connector manager, Designer, Publisher, Records worker, Viewer).
- Folders with permissions inherited downwards; grants per folder or per connector.
- Append-only audit log with secrets removed.

### Product port from Sangam (Phase 1b)
- Visual form builder, preview, versions (draft → published → archived), style library, templates.
- Public form page (`/f/:org/:CODE`), embeddable in an iframe.
- Submissions, file uploads (checked by content), CSV export.
- Work items: inbox, dashboard, statuses, actions, approvals, SLA with working time, emails, notifications, webhooks, automations.

### Connectors (Phase 2a)
- MongoDB, PostgreSQL, MySQL, Supabase, REST API, Amazon S3, CloudWatch Logs.
- Credentials encrypted, never shown again; test, discover, expose only chosen fields and operations; read-only unless allowed; every call logged.
- Used in forms for dropdowns, prefill, saving answers and custom automation steps.
- SSRF protection (https only, no private addresses, no redirects, size cap).

### Gateway agent (Phase 2b)
- Small program the customer runs inside their network; connects out to us, no inbound firewall rules.
- Database passwords **and** the address they're sent to stay on the customer's machine.
- Create / see status / revoke from the Connectors page.

### Productisation (Phase 3)
- **Plans and limits** (Free / Team / Business / Enterprise): forms, monthly responses, seats, connectors, gateways, custom domains; usage page with bars.
- **Form analytics**: opened → started → submitted, with rates and a chart (7/30/90 days).
- **Branding**: logo, brand colour, hide "Powered by Form Builder" on paid plans.
- **Custom domains**: `forms.customer.com/FORM_CODE`, proven by a DNS TXT record.
- **Save and continue later**: private link valid 30 days.
- **Print / save as PDF** of a single submission.
- **Export / import** of forms between orgs or environments (arrives as a draft).
- **Single sign-on (OpenID Connect)**: Entra ID, Okta, Google Workspace, etc.; email domains proven by DNS; can be made mandatory.
- **Docs**: `README.md`, `docs/guide.md` (customer admins), `docs/operations.md` (running the platform), `apps/gateway/README.md`.

### Security review
An independent review of the new code found issues; all were fixed, tested and re-checked:
- **Critical:** SSO trusted any email domain an org typed in, so accounts could be taken over. Domains now need a DNS proof, and SSO sessions only work for that org.
- **High:** whoever could edit a gateway connector could redirect the customer's database password. Connection targets now come only from the customer's machine.
- **Medium/low:** save-and-resume link could be planted to read answers; another website could start an SSO sign-in; response quota could be exceeded under load; unbounded domain cache. All fixed.

### Tests (all passing)
API 60 · Studio 74 · Engine 68 · Connectors 15 · Runtime 2. Production builds of studio, runtime and gateway succeed.

## What needs to be done

### Needs your decision
| Item | Why it's blocked |
|---|---|
| Billing provider (Razorpay / Stripe) | Needs the account and prices. Until then plans are set by hand: `pnpm --filter @fb/api set-plan <orgId> <PLAN>` |
| Plan limits and pricing | Numbers in `apps/api/src/plans/plans.ts` are placeholders |
| AWS account | Separate from Sangam recommended; nothing provisioned yet |
| Domain names | For studio, public forms and API |
| Terraform or AWS CDK | Infrastructure as code choice |
| HTTPS for customer domains | CloudFront + ACM per domain, or an edge proxy with on-demand certificates |
| Market / brand name | "Form Builder" is the working name |

### Please confirm these choices
- SSO sign-ins count as two-factor (the customer's identity provider handles it).
- "Save and continue later" is on for every form (no per-form switch yet).
- Local `.env` uses the Business plan so the demo isn't capped; new orgs elsewhere start on Free.

### Engineering work remaining
- **AEM parity, Phases 4–12**: see [aem-parity.md](aem-parity.md). Phase 4 (rule engine, job queue and worker, CI) is mostly built; its table lists what is left.
- **Gateways with several API servers**: sticky routing or routing between instances.
- **Server-side PDF** stored as the document of record (today it's browser print).
- SAML sign-in (only OpenID Connect today).
- Multi-language forms; per-field drop-off analytics; onboarding tour.
- Per-form switch for save-and-resume.
- Minor hardening: unique index on SSO domains; DNS-rebinding protection in the outbound fetch helper.

### Before launch
- External penetration test.
- DPDP documents: privacy policy, data processing agreement, retention policy.
- Backup and restore drill, incident runbook, uptime target.
- CI pipeline (lint, typecheck, tests, dependency and secret scanning).
- Commit the code to a repository (nothing is committed yet).

## Running locally
- API `http://localhost:4100` · Studio `http://localhost:5173` · Public forms `http://localhost:5174` · MongoDB on port 27029.
- Start-up steps are in `README.md` → Getting started.
