# What AEM Forms has that Form Builder does not (10 October 2026)

This list comes from reading Adobe's pages, not from memory. Each row says where in Adobe's documentation the capability is described and where Form Builder stands. It adds to [aem-parity.md](aem-parity.md) (the phase plan) and [reuse-and-routing.md](reuse-and-routing.md) (lists, saved emails, the Assign step).

**Status words:** *Built* means it is in the product and tested. *Part* means some of it is there; the row says what is missing. *Missing* means none of it is there. *Not for us* means we decided against it, with the reason.

## Pages read

Adobe's site is under `experienceleague.adobe.com/en/docs/`.

| Short name | Page |
|---|---|
| Data model 1 | `experience-manager-65/content/forms/form-data-model/create-form-data-models` |
| Data model 2 | `…/form-data-model/work-with-form-data-model` |
| Data model 3 | `…/form-data-model/using-form-data-model` |
| Data sources | `experience-manager-cloud-service/content/forms/integrate/use-form-data-model/configure-data-sources` |
| Forms service | `experience-manager-65/content/forms/use-document-services/forms-service` |
| Workflow | `experience-manager-65/content/forms/workflows/aem-forms-workflow` |
| Step reference | `…/workflows/aem-forms-workflow-step-reference` |
| Variables | `…/workflows/variable-in-aem-workflows` |
| Out of office | `…/workflows/configure-out-of-office-settings` |
| OSGi and JEE | `…/workflows/capabilities-osgi-jee-workflows` |
| To-do lists | `…/use-aem-forms-workspace/todo-lists` |
| Starting processes | `…/use-aem-forms-workspace/starting-processes` |
| Tracking | `…/use-aem-forms-workspace/tracking-processes` |
| Manager view | `…/use-aem-forms-workspace/tasks-organizational-hierarchy-using-manager` |
| Workspace overview | `…/use-aem-forms-workspace/html-workspace-overview` |
| Backbone | `…/use-aem-forms-workspace/backbone-interaction` |
| Render and submit | `…/use-aem-forms-workspace/new-render-submit-service` |
| Inbox | `…/publish-process-aem-forms/manage-applications-inbox` |
| Cloud overview | `experience-manager-cloud-service/content/forms/forms-overview/home`, and from it: rule editor, submit actions, document of record, prefill, drafts and portal, theme editor, translation, Adobe Sign, Communications |
| Edge Delivery | `www.aem.live/developer/forms` |

**Not read, so not judged:** portal search and lister options, Adobe Analytics, Automated Forms Conversion, review forms, the workspace mobile app, the Flex-only workspace pages. Adobe's core Inbox page and three links on the Cloud overview returned "not found"; the same subjects were read at the addresses above. Every page was read through a tool that summarises, so small options on a page may have been dropped.

## 1. People and queues (Workspace, Inbox, workflow steps)

| AEM capability | Where | Form Builder |
|---|---|---|
| Buttons on a task choose what happens next | Step reference | Built: statuses and actions |
| The person is chosen while the workflow runs | Step reference | Built: the Assign step's five ways |
| A task goes to a group; one member claims it | To-do lists, Inbox | Built (10 Oct): a form's team sees its unassigned records as "My team's queue" and presses "Take it" |
| Out of office: from, until, who gets my work | Out of office | Built (10 Oct): the Away card; chains are followed, loops leave the work in place |
| A task's deadline is acted on; reminders before it | Step reference, To-do lists | Built (10 Oct): an approval's time to answer ends in a reminder, the manager, or a refusal. One reminder, not a series |
| The same task goes to several people and all must answer | To-do lists, Tracking | Built (10 Oct): "Every one of them" must approve |
| Forward a task with a note; the receiver can send it back | To-do lists | **Part.** Built (10 Oct): "Hand over with a note". No one-press "send it back" |
| Consult a colleague without giving the task away | To-do lists | **Missing** |
| Share my list with a colleague | To-do lists | **Missing** (team queues cover most of the need) |
| A manager sees and moves their people's tasks | Manager view | Built (10 Oct): "My team's work" |
| Finish several like tasks at once | Workspace overview, To-do lists | **Missing.** No ticking of rows in the inbox |
| Staff attach files and notes to a task | To-do lists, Starting processes | **Part.** Comments yes; files no |
| Answer a task from the email | To-do lists | **Missing.** Emails link to the record |
| Branches that run side by side (AND split) | OSGi and JEE | **Missing.** "Everyone must approve" covers the common case |
| Jump back to an earlier step; typed variables | Variables | **Part.** "Run only if" on each step and the results of earlier steps; no jumping back |
| A calendar of what is due | Inbox | **Missing** |
| History of a task | To-do lists | Built: the History tab |
| Saved searches; follow what I started | Tracking | Built: saved views; the requests portal |
| Email, PDF, signature and "call my system" steps | Step reference | Built |
| Print streams, PDF/A, watched folders | Step reference, Workflow | Not for us yet: print-room features, asked for by nobody on the pilot |
| Rebuild the workspace screens in code | Backbone, Render and submit | Not for us: customers never get product source. The inbox has themes and layouts |

## 2. Data (form data model)

| AEM capability | Where | Form Builder |
|---|---|---|
| Databases, REST, OData, Salesforce, Dynamics, Azure storage | Data model 1, Data sources | Built |
| SOAP services, Oracle, DB2 | Data sources | **Missing** |
| REST that signs in with OAuth | Data sources | **Part.** REST offers none, bearer, API key and basic. OAuth exists on OData and Salesforce only |
| Show only chosen tables and services | Data model 1, 2 | Built |
| One model over several sources, with "a customer has many orders" | Data model 2 | **Missing.** A look-up reads one row of one table |
| Worked-out values kept on the model | Data model 2 | **Part.** Calculations are per form (a fragment can carry them) |
| Try a read or write with typed-in values and see the answer | Data model 2 | **Part.** A connection can be tested and its tables listed; one operation cannot be tried |
| Sample data to preview a form | Data model 2, 3 | **Missing** |
| Required, lowest, highest and pattern taken from the source | Data model 2 | **Part.** Types are worked out; limits are not brought in |
| Start a form from a model | Data model 3 | Built: from a table, JSON Schema, a spreadsheet, a fillable PDF |
| Fill the whole form from a record as it opens | Data model 3, prefill | **Part.** A look-up on open runs in the browser, reads one row and cannot fill repeating rows |
| Call a service from a rule when an answer changes | Data model 3, rule editor | **Part.** Look-ups run when the form opens or a button is pressed, not when an answer changes |
| Write an upload into the source | Data model 3 | **Part.** Files go to a folder or bucket, not into a database column |

## 3. The form itself (rule editor, drafts, themes, languages)

| AEM capability | Where | Form Builder |
|---|---|---|
| Show, hide, enable, set a value, validate, otherwise | Rule editor | Built |
| Clear a value; add or remove a row; set focus; display formats | Rule editor | **Missing** |
| Save, submit or reset the form from a rule | Rule editor | **Missing** |
| Functions written by the customer for rules | Rule editor | Not for us in the builder: authoring stays dropdowns and plain words. Extensions cover checks |
| Answers save themselves as people go | Drafts and portal | Built (10 Oct): the form setting "Save answers as people go"; kept every 30 seconds and found again on the same device, with "Start again". Off unless the form's owner turns it on |
| The portal lists a person's unfinished forms | Drafts and portal | **Missing.** It lists what they sent |
| Themes: states (hover, focus, error) and screen sizes | Theme editor | **Part.** A style library with fixed choices |
| Translation by file exchange | Translation | **Part.** Spreadsheet in and out; no XLIFF. Machine translation is not for us (no AI) |
| reCAPTCHA, embedding, JSON for other apps, analytics | Edge Delivery | Built |
| Adobe's marketing products as submit targets | Submit actions | Not for us |

## 4. Documents and signatures

| AEM capability | Where | Form Builder |
|---|---|---|
| A PDF of each response with logo, title, footer | Document of record | Built |
| Leave chosen fields out; a disclaimer; a font; page breaks | Document of record | **Missing** |
| Fill the customer's own PDF with the answers | Forms service | **Missing.** A fillable PDF can start a form; answers cannot be put back into it |
| Many documents in one run | Communications | Built (our layout only) |
| PDF/A, locked PDFs, certified PDFs | Communications | **Missing** |
| Several signers, in order or together, with an end date | Adobe Sign | Built |
| Check the signer by a code to their phone or email | Adobe Sign | **Missing.** The code service exists and is not used for signers |

## Order of work

Chosen by how often a team working a queue, or a person filling a form, would meet the gap. Each item ships with its tests and is used on the pilot before the next begins.

1. Away (out of office) with "give my new work to".
2. Approvals: everyone must approve, and deadlines that remind and then act.
3. Team queues with "Take it", and "My team's work" for managers.
4. Hand over with a note; ask a colleague.
5. Tick several records and act on all of them.
6. Answers that save themselves, and unfinished forms on the portal.
7. Rule actions: clear a value, add or remove a row.
8. PDF choices: leave a field out, a disclaimer.
9. Fill a form from a record on the server, including repeating rows and on a change of answer.
10. Staff files on a record; approve from the email.
11. Try a connector operation; related tables; OAuth for REST; SOAP and Oracle.
12. Fill the customer's own PDF; PDF/A; a code for signers.
