# Hardening plan

_11 October 2026. Written after an outside review of [architecture.md](architecture.md). Each point of the review was checked against the code; this says what is already true, what is not, and what to do about it, in order._

## 1. The review, point by point

| The review says | What the code does today | Verdict |
|---|---|---|
| Tenant isolation must be enforced centrally and tested | Every query carries `orgId`, but by convention: about 400 call sites, each written by hand, with no single place that refuses a query without one. Eight suites have an "another organisation cannot..." test; there is no test that walks every endpoint. | **Agree. Real gap.** Nothing is known to leak, but nothing would catch a new query that forgot. |
| Organisation → Business → Forms should be explicit | `businessId` is a plain text on a form and its responses. It is not a thing anyone can be given rights on. What does separate teams today is **folders**: roles are granted on a folder or a form. | **Partly.** Decide: either folders are the business level (and `businessId` goes), or business becomes a real level. |
| Separate form, workflow, automation and document definitions | Fields, rules and events, and workflow and automations are separate types with their own validators, inside one stored document. A workflow can live in the library and be shared by forms; publishing copies it into that version, so work in progress never moves onto a changed process. But all the validators sit in one 1,220-line file, and the document settings are an inline block with no type or validator of their own. | **Mostly so.** A tidy-up, not a redesign: phase 7. |
| Jobs need states, leases, backoff, a failed state | All there: `PENDING / RUNNING / DONE / FAILED`, a five-minute lease taken over when a worker dies, 30 s doubling to an hour, a kept `FAILED` state, de-duplication by key. | **Mostly done.** Three real gaps, below. |
| A crash after a connector succeeded must not repeat it | A retried job reads the record's timeline and skips steps already logged. A crash **between** the outside call and the log line repeats that one step. Nothing tells the other system "this is the same request". | **Agree. Real gap.** |
| Workflow transitions must be deterministic and server-side | One function moves a record (`moveTo`), and it writes only if the record is still in the status it was read in, so two people cannot both move it. Buttons, who may press them, required fields and approvals are checked on the server and validated when the form is published. | **Already so.** |
| Observability: correlation IDs, metrics, alerts | None. `/health` answers "ok" without looking at the database or the queue. A failed job is found by querying the database by hand. Each organisation has its own log of what its workflows did, which is for them, not for us. | **Agree. Largest operational gap.** |
| Backups, restore, key recovery | The pilot backs the database up nightly to S3 (30 days). Restoring has never been tried or written down. Losing `SECRET_KEY` or the KMS key loses every sealed credential and sensitive answer; that is not written down either. | **Agree.** |
| Data protection: retention and deletion | Drafts and sign-in state expire. Responses and the audit log are kept for ever; there is no way to delete or export one person's data. `operations.md` lists this as an open decision. | **Agree. Needs a decision from you first.** |
| Public form security | Rate limits (kept in the database, so they hold across servers), CAPTCHA checked on the server, upload size and type checks, optional virus scan, public pages can read only what a published form binds. | **Already so.** Worth one abuse test pass. |
| Load tests | One: a thousand PDFs in a batch while the API stays responsive. Nothing for submissions, the inbox or the queue. | **Agree.** |

Two things the review did not find, which the check did:

- **A gateway step does not work from the worker.** A gateway connects to the API process; an automation step that calls a connector through a gateway only works if the job runs in that same process. The pilot runs a separate worker, and Db2 only works through a gateway. Today that combination fails.
- **A job that runs longer than five minutes can be started twice.** The lease is fixed at five minutes and is never extended while the job is still working.

## 2. The plan

Each phase ships with its tests, and nothing here needs new AWS spend. The phases are in the order I would do them.

### Phase 1: Tenant isolation, provable

1. **A guard in one place.** A Mongoose plugin on every organisation-owned collection that refuses a read or write whose filter has no `orgId` (with a short, named list of collections that are truly global: users, sessions, jobs). A new query that forgets fails in tests, not in production.
2. **A cross-organisation test that walks the API.** Two organisations with data in every feature; for every route the application registers, organisation B asks for organisation A's things by ID and must get nothing. The route list comes from the application itself, so a new endpoint is covered without anyone remembering.
3. **Files and links.** The same for uploads, PDFs, signed documents, batch documents and every signed link (draft, signing, opens-with-a-record, approval by email): a link made for one organisation is refused by another.
4. **Business level: a decision, then the work.** My recommendation is to make folders the business level in name as well as in fact (a top-level folder per business, roles granted on it, as now) and remove the unused `businessId`. The alternative, a real Business entity, is larger and I would only do it if a customer needs things folders cannot give (separate branding or separate connectors per business).

### Phase 2: Jobs and side effects

1. **Extend the lease while working**, so a long job is never taken by a second worker; and stop a job that has lost its lease from writing its result.
2. **Each outside call carries a key that is the same on a retry** (run, step, attempt-independent). Mail: a sent-marker checked before sending. Webhooks and REST/OData/Salesforce writes: an `Idempotency-Key` header. Database inserts: where the table has a unique column mapped, the insert becomes "insert unless there"; otherwise the step is marked "may have run" before the call and a retry of such a step is flagged on the timeline for a person, never silently repeated.
3. **Gateway calls from the worker.** Route a gateway call to whichever process holds that gateway's socket (through the database, which both already share), so the worker can run gateway steps.
4. **Failed work is visible.** A page for operators and a card for organisation admins: what failed, why, "run again". A flow stopped by a failed step can be resumed from that step.
5. **Tests:** kill the worker mid-step and prove each kind of step ran exactly once; two workers on one queue; a job longer than the lease.

### Phase 3: Seeing what is happening

1. **A request ID** on every request, carried into the jobs it queues, the gateway calls and the extension calls they make, and written on every log line, so one response can be followed end to end.
2. **Structured logs** (one JSON line each) from API, worker and gateway.
3. **`/health` that looks**: database reachable, oldest waiting job, failed jobs in the last hour, gateways connected. A second, private endpoint with numbers a monitor can read: request counts and times, submissions accepted and refused, jobs by state, connector and extension errors.
4. **Alerts** on the pilot, by email, from those numbers: jobs waiting too long, jobs failing, the API not answering. (CloudWatch alarms on the existing server; a few rupees a month. I will say the exact cost before creating anything.)

### Phase 4: Getting it back

1. **A restore, done for real and written down**: last night's backup into a clean database, the product started on it, a form opened and a sealed credential used. Then on a schedule.
2. **Keys**: write down what is lost with each key and how each is backed up; add rotation of the installation key (re-seal with the new key while the old still opens).
3. **Rollback**: releasing the previous version is one command and is tested.

### Phase 5: Keeping and deleting data (needs your decision first)

1. You decide the policy: how long responses, files and the audit log are kept by default, and whether each organisation or each form can choose its own.
2. Then: a retention setting per form, a nightly job that removes what is past it (response, files, PDFs, signed copies), "delete this person's data" and "export this person's data" for an admin, and an audit entry for each.

### Phase 6: Load

1. A repeatable load test: sustained submissions with automations, an inbox over a large collection, a queue under backlog, on a machine the size of the pilot.
2. Fix what it shows (most likely indexes and the inbox queries) and write the measured limits into `operations.md`.

### Phase 7: The definition's parts, each in its own place

Small, and can be done at any point; it changes how the code is laid out, not what is stored or how anything behaves.

1. **Split the one schema file** (`packages/engine/src/definition.schema.ts`) into four modules that match the four models: form (fields, rules, events, data sources), workflow (statuses, moves, approvals, time limits), automation (triggers and steps) and document (the PDF's settings). The form definition's own schema composes them.
2. **Give the document settings a type and validator of their own**, like the other three, instead of an inline block.
3. **Say who owns what, in one place**: a short note at the top of each module on what it may refer to in the others (a workflow names fields by name; an automation names statuses and steps; the document names fields), and one check that runs those references together when a form is published, as now.
4. **Tests:** the existing engine tests pass unchanged, and a test that every published form in the fixtures and industry templates validates exactly as before.

### Phase 8: What a complaint-handling customer would miss

These came from scoring the product against one scenario used to compare it with others (a resident reports a leak, maintenance fixes it, a manager watches overdue work). They are features, not hardening, so they sit after it; any of them can be pulled forward if a customer or a comparison needs it.

1. **A file required before a record can move.** Staff can attach files to a record today, but a button cannot insist on one. Add "A file must be attached first" to a button's settings, beside "Work fields that must be filled first" and "Ask for a comment": how many, and (optionally) pictures only. It can carry an "Only when..." condition, like an approval does, so evidence is asked for one complaint type and not another. Checked on the server when the button is pressed, whatever the screen showed; said in words to the person pressing it.
2. **A QR code for a form.** On the Forms list beside "Copy link": show and download the QR code of the form's address, and of a link made for a record where the form opens with one (a code on a door or a machine that opens the form already knowing which). Made in the browser; nothing new on the server.
3. **Business and location as named levels.** The same decision as phase 1, item 4, and worth asking customers about before building: do they think in businesses and locations, and do they need different people to see different ones? What holds whichever way it goes: organisations stay strictly apart, and who may see a record is decided on the server (it is today: by the form's team and by roles on its folder, never by what a screen hides or a hidden answer says). If interviews say yes, the build is a Business level with Locations under it, forms and people attached to them, and records limited by them; the cross-organisation test of phase 1 is extended to walk business against business.
4. **Reports.** The dashboard counts and the inbox filters. Add: a "Team" filter on the inbox and dashboard (the form's team or the queue a record is in); and a Reports page that shows, for a chosen period, records opened, overdue and resolved and the median time to resolve, grouped by any one choice question (property, location, complaint type), by team or by priority, side by side so locations and teams can be compared, with the same filters as the inbox and a CSV of what is shown. Before building the charts, ask two or three buyers which of these numbers they actually look at, and build those first.
5. **The staff side on a phone.** The public form is responsive; the inbox and a record's page have not been checked on a phone. Check them at phone width in the browser tests, fix what breaks (taking a record, moving it, adding a comment and a photo must all work one-handed), and add those checks to the suite.
6. **Timed setup, by someone who has not seen the product.** Not code, and to be done before items 3 and 4 are built, because it says what to build. Someone unfamiliar with the product sets up the comparison scenario on the pilot with nobody helping: the maintenance form, assignment by complaint type, deadlines and escalation, and a view of overdue work. Written down for each part: the minutes (against the 60-minute target), each mistake, and each point where they got stuck or asked. Whatever costs the most time or help becomes the next thing to simplify.

### Phase 9: Standing out

From comparing the product with the others a buyer would look at (form builders, process platforms, helpdesks, facilities tools). Its strength is depth after the form is sent, data that stays in the customer's own systems, and documents that stand up to audit. Where it is behind is the time from nothing to a working process. These three close that.

1. **Describe it, and the form is drafted (AI).** In "New form": a box to say in plain words what the form is for ("a maintenance complaint for our properties: which property, what kind of problem, a photo, how urgent"), and a draft comes back in the builder: questions with the right kinds, choices, which are required, and rules that show extra questions. Later the same for a workflow ("goes to maintenance, due in two days, tell the resident when it is closed").
   - It makes a **draft only**. What comes back is checked by the same validation every form goes through, and anything that does not pass is dropped, never published. A person reads it, changes it and publishes it, as with a template.
   - Only the description is sent to the AI service: never responses, records, connector data or credentials.
   - Each organisation switches it on for itself (off unless an admin turns it on), with a monthly allowance by plan, and each use in the audit log.
   - The service's key is the installation's, kept with the other secrets; an installation without one simply does not show the box.
   - Tests: the service is stood in for in the suite (a fixed answer, a broken answer, a slow one, one that tries to smuggle in a workflow step it was not asked for); a small set of real descriptions is run against the real service by hand before each release and the drafts read.
2. **Whole processes from a template.** Today's templates give a form. Add scenario templates that give a working process in one step: the form, its statuses and buttons, assignment, deadlines and escalation, the emails to the requester, and a saved view of overdue work. Start with the comparison scenario (maintenance complaint), then the ones the industry templates already cover. This and item 1 are the two answers to "how long until it works".
3. **Tell the requester where they are: WhatsApp and text message.** Email is the only way a requester is told today. Add "Send a WhatsApp message" and "Send a text message" as automation steps, to the phone number in an answer, with approved message templates where the service insists on them. The text-message service already used for one-time codes carries the texts; WhatsApp needs a provider account. Both cost money per message, so each organisation connects its own account, as it does its own mail server.

## 3. What I would not do

- **No microservices and no separate message broker.** The review says the same. The queue in the database is enough until measurements say otherwise.
- **No splitting of the stored form definition.** The code is split into its four parts (phase 7), but a form stays one versioned document: that is what makes "a record belongs to the version it was submitted to" simple, and the review itself says they can be stored and versioned together.
- **No change to the production infrastructure plan** (Terraform, Atlas): that is on hold by your decision, and nothing above depends on it.

## 4. Decisions needed from you

1. **Business level**: folders as the business level (recommended), or a real Business entity?
2. **Retention**: how long are responses and the audit log kept, and who may change that?
3. **Alerts on the pilot**: may I add CloudWatch alarms there (small cost, quoted before I create them)?
4. **AI drafting**: which service (I would use Anthropic's Claude, through its API), and who pays for it: included in a plan up to an allowance, or the customer's own key? It costs a small amount per draft; I will give a figure from real drafts before it is switched on anywhere.
5. **WhatsApp**: which provider, and is it wanted for the first customers, or only text messages to begin with?

Phases 1 to 3, phase 7, most of phase 8 (all but the business level) and the scenario templates of phase 9 need none of these and can start now.
