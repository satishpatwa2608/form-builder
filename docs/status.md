# Form Builder — status and next steps

_Last updated: 9 October 2026_

**In one line:** the product works end to end on one machine and is well
tested; it is not launch-ready, because the code is not in a remote
repository, nothing runs in a real cloud, and there is no billing.

Choices made on 9 October are recorded in [decisions.md](decisions.md).

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

### AEM parity and beyond (Phases 4, 5, 6 and 8; see [aem-parity.md](aem-parity.md))
- **Rules and events:** formulas, conditional behaviour, calculated fields checked again by the server, events on load, click and submit.
- **Background work:** a job queue with retries and a separate worker.
- **Components:** repeating sections, tabs, accordion, switch, tick boxes, stepper, signature, consent, picture.
- **Authoring:** opening and closing dates, scheduled publishing, save-and-continue switch per form, compare and restore versions, start a form from a spreadsheet or JSON Schema, **fragments**, **review before publish**.
- **Shared workflows:** one workflow in a library, used by many forms.
- **Documents:** a PDF of every response made by the server (no browser), kept with the response, a generation API and batches of up to 1,000.

### Customers' own code
- **Extensions:** a customer's service, written against our SDK, offering workflow steps, dropdown lists, checks before a submission is accepted, and fields of their own (in a locked frame). See [extensions.md](extensions.md).
- **Hosting on Docker, both ways:** shared (their code in a container beside one installation) and dedicated (an installation of their own), with a delivery pipeline that rolls back a version that does not start, and outbound calls only to agreed addresses. See [hosting.md](hosting.md).
- **Plans** count extensions.

### Tests
See the figures in the last hand-over message for the run of 9 October. Suites: engine, connectors, SDK, API (unit and end-to-end on an in-memory database), studio, runtime, the outbound proxy, 17 browser scenarios files (`pnpm e2e`) and the Docker hosting suite (`pnpm e2e:docker`). CI is written and has never run, because the code has not been pushed anywhere.

## What needs to be done

### Needs you
| Item | Why it's blocked |
|---|---|
| A private git repository | No GitHub access on the build machine. The work is on `main` locally, with copies in `~/Documents/form-builder-backup/`. |
| AWS account | Separate from Sangam recommended. `infra/terraform/` is written and validated, never applied. |
| MongoDB Atlas, domain names, certificates | Inputs the Terraform expects. |
| Billing provider (Razorpay / Stripe) | Needs the account and prices. Until then plans are set by hand: `pnpm --filter @fb/api set-plan <orgId> <PLAN>` |
| Plan limits and pricing | Numbers in `apps/api/src/plans/plans.ts` are placeholders, including which plans include extensions. |
| Market / brand name | "Form Builder" is the working name |

### Please confirm these choices
- Everything in [decisions.md](decisions.md).
- SSO sign-ins count as two-factor (the customer's identity provider handles it).
- Local `.env` uses the Business plan so the demo isn't capped; new orgs elsewhere start on Free.

### Engineering work remaining
- **AEM parity:** e-signature (Phase 7), languages and accessibility (Phase 9), portal, headless API and deeper analytics (Phase 10), more connectors (Phase 11). In Phase 6: designed document templates, attaching the PDF to an email, PDF operations, more scripts. In Phase 8: a form from a connector entity or a fillable PDF.
- **Production hosting:** apply and correct the Terraform; a registry for the SDK and customers' images; a build service for customers' repositories; a secrets manager in place of `infra/.state/`.
- **Gateways with several API servers:** sticky routing or routing between instances.
- SAML sign-in (only OpenID Connect today).
- Email for review requests; per-field drop-off analytics; onboarding tour.
- Minor hardening: unique index on SSO domains; DNS-rebinding protection in the outbound fetch helper.

### Before launch
- External penetration test.
- DPDP documents: privacy policy, data processing agreement, retention policy.
- Backup and restore drill, incident runbook, uptime target.
- First CI run on the pushed repository, and fixing whatever it finds.

## Running locally
- API `http://localhost:4100` · Studio `http://localhost:5173` · Public forms `http://localhost:5174` · MongoDB on port 27029.
- Start-up steps are in `README.md` → Getting started.
