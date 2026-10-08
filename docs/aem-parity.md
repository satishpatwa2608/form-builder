# Form Builder: AEM Forms parity plan (Phases 4–12)

**Status:** draft for review · **Date:** 2026-10-08 · Continues [plan.md](plan.md) (Phases 0–3)

## 1. Scope

Bring Form Builder level with AEM Forms as a Cloud Service, then past it, in the areas where we are behind today: rules, components, documents, signatures, authoring lifecycle, languages, portal, headless delivery and connectors.

**Out of scope for this plan:** anything AI (form generation from a prompt, document extraction, conversational filling, machine translation). Scanned-PDF conversion is out for the same reason; fillable-PDF import is in because it needs no AI.

Week numbers are rough estimates for 2–3 full-time engineers, like plan.md. They are not based on measured velocity and should be re-planned after Phase 4.

## 2. Order and why

| # | Phase | Weeks | Depends on |
|---|---|---|---|
| 4 | Foundations: repository, worker, rule engine v2 | 4 | — |
| 5 | Components | 4 | 4 (calculations, repeat model) |
| 6 | Documents | 5 | 4 (worker), 5 (repeat sections in the PDF) |
| 7 | E-signature | 3 | 6 |
| 8 | Authoring lifecycle | 3 | 4 (worker for scheduling) |
| 9 | Languages and accessibility | 3 | 5 (all components exist) |
| 10 | Portal, headless and analytics | 4 | 9 for the portal's language switch |
| 11 | Connectors and submit targets | ongoing | — (driven by pilots) |
| 12 | Beyond AEM | 6+ | 5, 10 |

Three things decide the order:

- **The worker comes first.** PDF generation, batch jobs, e-sign callbacks and scheduled publishing must not run inside the API process. status.md already lists the worker as required before a second API server.
- **Rules before components.** Tables and repeatable sections are only useful with calculations, and the review step and signature need the "navigate" and "validate" actions.
- **Repeatable sections before documents.** They change the shape of the submitted payload; the PDF templates should be written once, against the final shape.

Phases 8 and 11 have few dependencies and can run alongside 5–7 if a third engineer is free.

## 3. Testing rule for every phase

A phase is not done until its tests are written and pass. Testing is part of each phase, not a phase of its own.

- New engine logic gets unit tests; new endpoints get e2e tests on in-memory MongoDB; new screens get component tests.
- Anything a browser sends is tested from the API side as hostile input.
- The full suite, typecheck and lint pass in CI before a phase is closed. Baseline on 8 October 2026: 219 tests (engine 68, connectors 15, API 60, studio 74, runtime 2). On 9 October 2026: 420 (engine 155, connectors 15, API 101, studio 147, runtime 2) plus 49 browser scenarios.
- Each phase ends with one end-to-end scenario (its "Done when") run against the real apps.
- `pnpm e2e` runs the whole product in a real browser: MongoDB, the API, the builder, the public form app and the gateway agent as real processes. 49 scenarios on 9 October 2026, all passing; the table in README.md lists what each file covers. New screens get a scenario there.

Not covered in the browser, and why:

- Single sign-on and custom domains: they need an identity provider and DNS. Covered by API tests with stand-ins.
- A live hCaptcha, reCAPTCHA or Turnstile widget: needs real keys. The verification call is covered by API tests; the browser run uses the built-in test mode.
- A real ClamAV daemon: not installed here. The client and the upload flow are tested against a stand-in that speaks its protocol.
- Webhook delivery to a real receiver: only public https addresses are allowed, so nothing local can receive one. Delivery and retries are covered by API tests.
- The API and the worker as two processes: checked by hand on 8 October, not part of the suite (it runs one process with rate limits off).

What the first browser run found that the other tests had not (all fixed):

| Found | Why the other tests missed it |
|---|---|
| A click was lost whenever an error message appeared or went as the person clicked away from a field: the page moved between mouse-down and mouse-up. A consent tick and a Submit were both swallowed. | The component tests run without a page layout, so nothing moves. |
| With a review step, the list of mistakes at the top never appeared. | The component test checked the message beside the field, not the list. |
| "Next" on a stepped form flagged a closed accordion panel or another tab but did not open it. | Not covered. |
| A revoked gateway agent stopped reconnecting but its process stayed alive. | The agent was tested inside the test process, not as its own. |
| A dialog component logged a React warning on every confirm. | Warnings are not failures in the component tests. |
| The supplier registration template made a form that could never be published in a new organisation: it used a style the organisation's library did not have. | No test created a form from a template and published it. |

## 4. Phases

### Phase 4 – Foundations (4 weeks)

- Commit the code, add CI (lint, typecheck, tests, dependency and secret scanning). Nothing is committed today.
- **Worker app:** move SLA sweeps, automations and webhooks out of the API onto a queue with retries.
- **Rule engine v2** in `packages/engine`, replacing today's three separate mechanisms (`visibility`, `requiredWhen`, `dependency`) with one model, while still reading the old ones:
  - Actions: show/hide, enable/disable, set value, calculate, validate with a custom message, set options, navigate to a step, call a connector operation.
  - When / then / else, nested all/any conditions (the condition model already supports nesting).
  - Expression language with a function library: maths, text, date, list (sum/count/min/max over rows).
  - Events: field change, form load, step change, before submit, submit success, submit error.
- The server re-runs every calculation and validation on submit. A calculated value sent by the browser is never trusted.
- Builder: a visual rule editor with a list of all rules and events on the form.

**Testing:** Engine unit tests for every action, operator and function, including cycles, division by zero and wrong types. API e2e: tampered calculated value rejected, rule validation enforced without a browser. Worker: a job is retried after a failure and is not run twice. Studio: rule editor creates, edits and deletes each action type. The old `visibility` / `requiredWhen` / `dependency` forms still pass their existing tests unchanged.

**Done when:** a form computes a total from other fields, the API stores its own total whatever the browser sent, and automations survive an API restart mid-run.

**Status, 8 October 2026: complete, apart from the two items marked below.**

| Item | State |
|---|---|
| First commit, CI workflow (lint, typecheck, tests, build, dependency audit, secret scan) | Done. The workflow has not run yet: the repository has no remote. Lint passes with no errors; 42 warnings remain in code that predates this phase (mostly `any`). |
| Worker and queue | Done. Jobs are kept in MongoDB in every environment (SQS was not needed to get retries and a separate worker; revisit if volume calls for it). The worker is a second entry point of the API app (`node dist/worker`), so the empty `apps/worker` skeleton was removed. |
| Rules: show/hide, enable/disable, require, set value, error, narrow options; when / then / otherwise; expression language and function library | Done, in the engine, the API, the live form and the builder. |
| Server recomputes calculations and re-checks rules | Done. A sent value for a calculated field is replaced, not rejected. |
| Events: when the form opens, a button is clicked, a submit succeeds or fails → set a value, go to a step, look a row up from a data source, show a message, redirect | Done. Events run in the browser only; the server trusts nothing they do. A public form can read a data source through a look-up only if a published event binds it, with only the parameters that event declares. |
| Rule and event editor in the builder | Done as a Rules dialog with Rules and Events tabs. The per-field visibility and required-when editors are unchanged and still work. |
| Renaming a field updates the rules and events that mention it; deleting one warns which rules use it | Done. References hold steady while a key is empty, half-typed or the same as another field's. |
| A form-level time zone | Done (Form settings → Time zone). Left empty, `today()` uses the browser's zone, which the server accepts from the request. |
| Customer-written functions | Deferred (section 5). |
| Look-ups that write, or that run on the server | Not built. A look-up only reads, and only in the browser; saving to a connector stays an automation step. |
| Checked in a real browser | Done on 9 October 2026: see section 3 and `e2e/`. |

Tests added in this phase: engine 68 → 125, API 60 → 80, studio 74 → 111; 333 in total, all passing.

### Phase 5 – Components (4 weeks)

- **Repeatable section** and **table** (add/remove rows, min/max rows, row and column totals). Payload becomes an array of objects for that section.
- Containers: accordion, horizontal and vertical tabs.
- Fields: switch, checkbox group, numeric stepper, image, form title/header/footer, uploaded-file list, signature (draw or type), terms and consent.
- **Review step** before submit, with "edit" links back to each step.
- hCaptcha as a third provider.
- File rules: allowed types and size per field through the rule engine; a virus-scan hook that holds the file until it passes.
- Chart component is deferred to Phase 10 (it is used on the portal and dashboards more than in forms).

**Testing:** Engine tests for the repeat payload shape, row limits and totals. Component tests for each new field (keyboard use included). API e2e: rows beyond the limit rejected, a file that fails the scan is never stored. Runtime: review step shows exactly what is submitted. CSV export of repeated rows.

**Done when:** an expense claim with line items, a computed total, a review step and a signature runs end to end and exports correctly to CSV.

**Status, 9 October 2026: built and tested.**

| Item | State |
|---|---|
| Repeating section, with an optional table layout and column totals | Done. Rows are a list of objects in the payload. Rules run row by row; outside the section a row field reads as the whole column, so `sum(lineTotal)` totals it. At most 200 rows. |
| Accordion, horizontal and vertical tabs | Done. Each holds Sections. The one with a mistake is flagged, and opens when its field is focused. |
| Switch, tick-box group, numeric stepper, picture, signature (drawn or typed), terms and consent | Done. |
| Review step before submit, with a way back to each answer | Done (Form settings → Review before sending). |
| hCaptcha | Done, beside reCAPTCHA and Turnstile. |
| File rules | Types, size and count per field already existed; a rule can now fault a file field (`length(receipt) < 1`). |
| Virus-scan hook | Done: `FILE_SCANNER=clamav` sends each upload to a ClamAV daemon before it can be attached. A file the scanner cannot check is refused. Default is `none`. |
| Form title, header and footer as separate components | Not built: the form already shows its name, description and logo. |
| Uploaded-file list as a separate component | Not built: the file field lists its own files. |
| Chart | Deferred to Phase 10, as planned. |

Limits to know:

- Inside a repeating section: no uploads, signatures, consent, hidden or system-filled fields, no other sections, and option lists must be fixed (not from a connector).
- An event cannot fill a field inside a repeating section.
- A repeating section with no fields yet, and a picture with no address yet, can be published (they show nothing), in line with how a button with no link already behaves.
- A signature is kept in the submission itself as a small PNG (at most about 110 KB), not as an uploaded file.

### Phase 6 – Documents (5 weeks)

- **Document of record:** server-side PDF for every submission, generated in the worker, stored through the file connector (our S3 or the customer's).
- Document templates: header/footer, logo, which fields appear, page breaks, repeatable sections as tables. A default template needs no setup.
- Email automation step can attach the PDF and the uploaded files.
- **Generation API:** template + JSON data → PDF, single (synchronous) and batch (queued, with a status endpoint and a result location).
- Document operations: merge, split, reorder, PDF/A output, HTML→PDF, PDF→image, password protection.
- New automation step: "Generate document".

**Testing:** Snapshot tests of generated PDFs (text and structure, not pixels) for each template feature. Batch test at 1,000 records with a timing budget. Failure tests: template error, storage unavailable, job retried without duplicate documents. Permission tests on the generation API and on document download links.

**Done when:** a submission produces a stored, branded PDF without a browser, and a batch of 1,000 records produces 1,000 documents without slowing the API.

### Phase 7 – E-signature (3 weeks)

- One signing interface with provider plugins, like connectors. First providers: DocuSign and one Aadhaar eSign provider.
- Automation step "Send for signature": one or several signers, in order or in parallel, with reminders and expiry.
- Signed document and audit trail stored with the record; status visible in the Inbox.
- Certify a generated PDF with the organisation's certificate (tamper evidence).

**Testing:** Provider contract tests against a fake provider; a recorded sandbox run per real provider. Callback tests: forged, replayed and out-of-order callbacks rejected. Flow tests: decline, expiry, reminder, signer order. Tamper test on a certified PDF.

**Done when:** a submission is signed by the requester and then an approver, and the signed PDF is on the record.

### Phase 8 – Authoring lifecycle (3 weeks)

- **Fragments:** save a section as a reusable fragment; forms reference it and pick up changes at their next publish.
- Version history with compare and restore.
- Review before publish: comments on fields, request review, approve.
- Scheduled publish and expiry dates; a "form closed" page.
- Per-form switch for save-and-resume (open item in status.md).
- Create a form from a JSON Schema, a connector entity, a spreadsheet, or a fillable PDF's fields.

**Testing:** Fragment update reaches every form that uses it, and never changes an already-published version. Version restore round-trip. Scheduled publish and expiry with a fake clock, including time zones. Import tests with malformed schemas, spreadsheets and PDFs.

**Status, 9 October 2026: started.**

| Item | State |
|---|---|
| Per-form switch for save-and-resume | Done (Form settings → Let people save and continue later). On unless switched off. |
| Opening and closing dates; a "form closed" page | Done (Form settings → Availability). Outside the window the public gets a notice with none of the questions, and the server refuses submissions, uploads and saved drafts. Staff can still raise items from inside. |
| Scheduled publish | Done (Schedule, beside Publish in the builder). The draft is checked when scheduled and again at the time; it publishes with the rights its scheduler holds then; a refusal is recorded on the form. Up to 365 days ahead. |
| Fragments | Not started. |
| Version history with compare and restore | Not started. |
| Review before publish | Not started. |
| Create a form from a JSON Schema, a connector entity, a spreadsheet, or a fillable PDF | Not started. |

**Done when:** an address fragment is changed once and three forms show the change after republishing; a form goes live and closes on set dates.

### Phase 9 – Languages and accessibility (3 weeks)

- Multi-language forms: every label, help text, option, message and email in several languages; language switch on the form; right-to-left layout.
- Translation by export/import (CSV or XLIFF) so a customer's translator can work outside the product.
- Document of record in the language the form was filled in.
- WCAG 2.1 AA audit of the runtime, fixes, and an accessibility check in the builder's issues list.

**Testing:** Every string on the runtime has a key (a test fails on a hard-coded string). Fallback to the default language when a translation is missing. Translation file round-trip. Automated accessibility checks (axe) in CI on every field type, plus the external audit. Right-to-left visual check.

**Done when:** one form runs in English, Hindi and Arabic, and the runtime passes an external accessibility audit.

### Phase 10 – Portal, headless and analytics (4 weeks)

- **Forms portal** for end users: list of forms they may fill, their drafts, their submissions and status, on the customer's domain and branding.
- **Headless:** published form as JSON over a public API, plus a React package and a web component built on `packages/engine`; script-tag embed besides the iframe.
- Visual flow designer for automations (branches, parallel steps, variables) on top of the existing step model.
- Analytics: drop-off per field and per step, time per field, error rates; export to GA4 and Segment. Chart component.

**Testing:** Portal: a user sees only their own drafts and submissions (tenant and user isolation tests). SDK: the same definition gives the same validation result in the SDK, the runtime and the API. Flow designer: each branch type executes as drawn. Analytics: event counts reconcile with submissions.

**Done when:** a customer renders one of our forms in their own React app, and a requester sees their open requests in the portal.

### Phase 11 – Connectors and submit targets (ongoing)

Ordered by what pilot customers ask for, not all at once:

- Databases: MS SQL, Oracle.
- Protocols: SOAP, OData.
- Business systems: Salesforce, Microsoft Dynamics, SAP (OData).
- Files: SharePoint, OneDrive, Azure Blob, Google Drive.
- Automation: Power Automate, Zapier, Make.
- Sheets: Google Sheets, Excel.
- SAML sign-in (open item in status.md).

Each one follows the existing connector contract and security rules in plan.md section 5.3.

**Testing:** Each connector passes the shared contract suite (discover, read, write off by default, limits, error mapping) and the SSRF and injection tests from plan.md section 5.3, against a real instance in a container where one exists.

### Phase 12 – Beyond AEM (6+ weeks, pick by demand)

- Payment field (Razorpay, Stripe).
- OTP-verified phone and email fields.
- WhatsApp: send form links, notifications and the signed PDF.
- Offline mobile app (PWA): fill without a connection and sync later; GPS, camera, barcode/QR fields.
- A/B testing of form variants with the Phase 10 analytics.
- DPDP controls: consent records, retention periods per form, erase-on-request.
- Developer surface: public API keys, CLI, Git-based promotion of form packages.

**Testing:** Per feature: payment webhooks (forged, replayed, duplicate), OTP rate limits and expiry, offline sync conflicts, A/B assignment stability, retention jobs deleting exactly what the policy says.

## 5. Decisions needed before each phase

| Before | Decision | Recommendation |
|---|---|---|
| 4 | Custom functions written by customers: allow or not | Not in Phase 4. Ship the built-in library first; customer code needs a sandbox and a security review. |
| 4 | Local queue | Decided: MongoDB-backed in every environment for now. |
| 6 | PDF engine | Headless Chromium in the worker for HTML templates (reuses the form's own styling); a PDF library for merge, split and protect. |
| 6 | Where documents are kept by default | Our S3 in Mumbai; the customer's bucket when a file connector is bound. |
| 7 | Signature providers and accounts | DocuSign plus one Aadhaar eSign provider; needs commercial accounts. |
| 9 | Launch languages | English, Hindi, plus one right-to-left language to prove the layout. |
| 12 | Payment provider | Same as the billing provider decision already open in status.md. |

## 6. Carried over from status.md, not replaced by this plan

Billing provider and pricing, AWS account and infrastructure, HTTPS for customer domains, gateways across several API servers, external penetration test, DPDP documents, backup and restore drill. Phases 6 and 7 cannot go live without the infrastructure decisions.
