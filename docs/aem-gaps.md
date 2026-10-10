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
| Forward a task with a note; the receiver can send it back | To-do lists | Built (10 Oct): "Hand over with a note", and "Send it back" for whoever it was handed to |
| Consult a colleague without giving the task away | To-do lists | Built (10 Oct): "Ask a colleague" on a record. They see it, answer, and lose sight of it; they cannot change it |
| Share my list with a colleague | To-do lists | Built (10 Oct): "Share my work list" on Account & security; the colleagues ticked see and open what I hold under "Shared with me" |
| A manager sees and moves their people's tasks | Manager view | Built (10 Oct): "My team's work" |
| Finish several like tasks at once | Workspace overview, To-do lists | Built (10 Oct): tick items in the inbox, then give them to someone, set their priority, take them, or approve or reject them. Named actions (such as Resolve) are still one record at a time |
| Staff attach files and notes to a task | To-do lists, Starting processes | Built (10 Oct): a Files tab on the record lists what came with the form and what staff added; staff add files, checked like any upload |
| Answer a task from the email | To-do lists | Built (10 Oct): "Let approvers answer from the email" on an approval. Each approver's email has their own link; the page it opens asks them to press Approve or Reject. Off unless switched on |
| A workflow drawn as a picture (the workflow model editor) | Workflow | Built (10 Oct). The Picture tab is where a workflow is built: click a status, an arrow, a trigger or a step and its settings open beside the picture; drag the dot on a box's edge onto another box to add a move; "+" adds a status, a step or an automation. Everything that can be dragged can also be done from the panel with the keyboard. A published form's picture only shows. An approval's two outcomes are drawn as branches in the automation's own diagram |
| Branches that run side by side (AND split) | OSGi and JEE | Built (10 Oct). An approval can "Ask at the same time" up to five more approvals. Steps that send or call something (email, notification, webhook, automation tool, custom step) can be switched to start "At the same time as the step before": what follows waits for all of them, and a failure in one lets the others finish before the flow stops. A step that changes the record (status, assignee) never joins such a group, so two steps cannot change it under one another |
| Jump back to an earlier step; typed variables | Variables | Built (10 Oct). A step "Go back to an earlier step" carries the flow on from a step before it, at most a set number of times (1 to 10, three unless said), so a flow can never go round for ever; after an approval it starts as "if rejected, ask again". Typed variables: the results of earlier steps, by name, in conditions and messages |
| A calendar of what is due | Inbox | Built (10 Oct): the Work inbox has a third layout, Calendar: the same view as a month, each record on the day it is due |
| History of a task | To-do lists | Built: the History tab |
| Saved searches; follow what I started | Tracking | Built: saved views; the requests portal |
| Email, PDF, signature and "call my system" steps | Step reference | Built |
| Print streams, PDF/A, watched folders | Step reference, Workflow | Not for us yet: print-room features, asked for by nobody on the pilot |
| Rebuild the workspace screens in code | Backbone, Render and submit | Not for us: customers never get product source. The inbox has themes and layouts |

## 2. Data (form data model)

| AEM capability | Where | Form Builder |
|---|---|---|
| Databases, REST, OData, Salesforce, Dynamics, Azure storage | Data model 1, Data sources | Built |
| SOAP services, Oracle, DB2 | Data sources | Built (10 Oct). **Oracle Database**: through Oracle's own driver in thin mode (nothing of Oracle's to install); tested against a real Oracle 23. **SOAP web services**: reads the WSDL (and the schema files it names) and offers each document/literal operation, SOAP 1.1 and 1.2, with basic or WS-Security user-name sign-in; tested against a real SOAP server run by an independent library; the old rpc/encoded style is refused in words. **IBM Db2**: through IBM's own driver, which IBM does not make for ARM Linux, so on our hosted servers a Db2 connector runs through a gateway installed near the database; tested against a real Db2 11.5 with IBM's driver (IBM's driver has no way of taking a password with a semicolon in it, so such a password is refused in words) |
| REST that signs in with OAuth | Data sources | Built (10 Oct). A REST connector signs in as an application (client credentials) or as a person (authorization code): "Sign in" on the connector sends them to the other system to agree, and the lasting sign-in that comes back is sealed with the connector's other credentials. Tested against a real identity provider (Keycloak): its sign-in page, its codes, its tokens and its own API. A token that stops working sooner than it said (seconds-long, or withdrawn) is replaced and the call made once more |
| Show only chosen tables and services | Data model 1, 2 | Built |
| One model over several sources, with "a customer has many orders" | Data model 2 | Built (10 Oct). On a connector's table an admin says which rows of another table belong to each of its rows ("Related rows": a customer's orders), on the same system or another of the organisation's. A look-up that finds a few rows brings them along, and fills a repeating section from them; a long list (a dropdown's options) brings nothing |
| Worked-out values kept on the model | Data model 2 | **Part.** Calculations are per form (a fragment can carry them) |
| Try a read or write with typed-in values and see the answer | Data model 2 | Built (10 Oct). "Try it" on a connector reads an exposed table with typed filters and shows the rows a form would get. "Try adding a row" does the same for a write, for whoever manages the connector, after a tick that it really adds a row |
| Sample data to preview a form | Data model 2, 3 | Built (10 Oct): the builder's Preview has "Fill with example answers": made-up answers of the right kind for every question, so rules, totals and later steps can be seen without typing |
| Required, lowest, highest and pattern taken from the source | Data model 2 | Built (10 Oct). A database connector reads each table's own rules (CHECK constraints) and the room a column's type has: required, shortest and longest length, lowest, highest and pattern. OData reads MaxLength, Precision and the standard validation remarks; Salesforce reads length, digits and what it fills in itself. Only a rule about one column made of plain comparisons is understood; anything else gives no limit, never a guessed one. Tested against real PostgreSQL, MySQL, SQL Server and Oracle |
| Start a form from a model | Data model 3 | Built: from a table, JSON Schema, a spreadsheet, a fillable PDF |
| Fill the whole form from a record as it opens | Data model 3, prefill | Built (10 Oct). "Opens with a record" (form settings): the server reads the record and the form opens filled from it, found by a link made for that one record (signed: it cannot be guessed, changed or used on another form) or by who is signed in. Only the answers chosen reach the browser, never the rest of the record. Answers marked "Keep" are shown greyed and are read from the record again when the form is sent; a form can be set to open only from such a link. Links are made from the Forms list. A look-up in the browser (on opening, on a button, when an answer changes) is still there for the rest |
| Call a service from a rule when an answer changes | Data model 3, rule editor | Built (10 Oct): events have a third moment, "When an answer changes", that looks up and fills in (or sets a value) just after the person stops typing |
| Write an upload into the source | Data model 3 | Built (10 Oct). Files go to a folder or bucket (SharePoint, OneDrive, S3, Azure), and a write step can also put an uploaded file into a field: as bytes in a database column (MongoDB, PostgreSQL, MySQL, SQL Server, Oracle, Db2), as base64 where a web API takes binary fields. Its name and kind can go in fields beside it; all three are matched by name. Up to 10 MB (3 MB through a gateway). Rows read back show that a file is there and its size, never its bytes |

## 3. The form itself (rule editor, drafts, themes, languages)

| AEM capability | Where | Form Builder |
|---|---|---|
| Show, hide, enable, set a value, validate, otherwise | Rule editor | Built |
| Clear a value; add or remove a row; set focus; display formats | Rule editor | Built (10 Oct). "Clear the answer to" in the rules dialog. Rows can follow an answer (a repeating section's setting, "As many as the answer to..."), and the server insists on the count too. The cursor can be put in a question from an event. A text question can keep its letters as CAPITALS, small letters or a name's capitals ("Letters"), and its spacing in a shape ("Spacing": in fours, in threes, like a phone number, or a shape of the designer's own such as ##-####) |
| Save, submit or reset the form from a rule | Rule editor | Built (10 Oct). A button can "Send the form", "Start the form again" or "Save the answers for later", and a button, a changed answer or the form opening can "Put the cursor in" a question |
| Functions written by the customer for rules | Rule editor | Not for us in the builder: authoring stays dropdowns and plain words. Extensions cover checks |
| Answers save themselves as people go | Drafts and portal | Built (10 Oct): the form setting "Save answers as people go"; kept every 30 seconds and found again on the same device, with "Start again". Off unless the form's owner turns it on |
| The portal lists a person's unfinished forms | Drafts and portal | Built (10 Oct): forms saved while signed in to the portal appear under "Started and not sent", with Continue and Discard |
| Themes: states (hover, focus, error) and screen sizes | Theme editor | Built (10 Oct). A form's look takes the colour of mistakes, how round its corners are, and how much room is between questions (tighter on a phone), each from a short list. Focus follows the brand colour. The style library has its own page (Styles): each look is made from colours, sizes and picks, with a live example beside it, and can change its background while the mouse is over it |
| Translation by file exchange | Translation | Built (10 Oct): a spreadsheet for all languages, or an XLIFF 1.2 file for one language (what translation tools exchange), out and back in. Machine translation is not for us (no AI) |
| reCAPTCHA, embedding, JSON for other apps, analytics | Edge Delivery | Built |
| Adobe's marketing products as submit targets | Submit actions | Not for us |

## 4. Documents and signatures

| AEM capability | Where | Form Builder |
|---|---|---|
| A PDF of each response with logo, title, footer | Document of record | Built |
| Leave chosen fields out; a disclaimer; a font; page breaks | Document of record | Built (10 Oct). "Leave out of the PDF" (questions or whole sections), a closing note, and sections that start on a new page. The typeface can be plain or a serif for Latin text; Indian scripts keep their own fonts either way |
| Fill the customer's own PDF with the answers | Forms service | Built (10 Oct): "Use your own PDF" in form settings. A fillable PDF is added once to the organisation's library; each response is written into it. A box named like a question is matched by itself, any other is pointed at a question from a list |
| Many documents in one run | Communications | Built (our layout only) |
| PDF/A, locked PDFs, certified PDFs | Communications | Built (10 Oct). "Archival PDF (PDF/A)" writes the response's PDF to PDF/A-2b, and veraPDF (the PDF Association's validator) passes it in CI: plain, serif, sealed, and the signed copy with its page of signatures. "Seal the PDF" certifies the PDF with the organisation's certificate, allowing no changes: a reader shows who sealed it, will not edit it, and says if a byte was altered. That is both the lock and the certificate. Every organisation gets a certificate made for it; its own, from a certificate authority, can be added under Organisation settings. Seals are checked in CI by poppler's pdfsig |
| Several signers, in order or together, with an end date | Adobe Sign | Built |
| Check the signer by a code to their phone or email | Adobe Sign | Built (10 Oct). The "Send for signature" step can ask for a code emailed to the signer at the moment they open the document (a forwarded or intercepted link is then not enough), or for something they know (an answer from the response, such as a policy number). Until it is given, neither the document nor the signing form opens. Wrong tries are counted and the link stops working. A code by text message waits for a text-message service to be connected for signers |

## Where this stands (10 October 2026, evening)

Everything on the list that could be built has been built, each with its tests.

**Built since the morning's count**: the workflow picture as the place a workflow is built; steps that start together; going back to an earlier step, a set number of times; ranges, shortest lengths and patterns taken from a source; related rows ("a customer has many orders"), across systems too; a form that opens filled from a record the server reads; an uploaded file written into a field; a code, or something they know, asked of signers; PDFs sealed with a certificate (the lock and the certificate in one); Oracle, SOAP and Db2 connectors; signing a connector in as a person.

**How each was proven.** Beside the product's own tests, each of these is checked against something that is not ours: real PostgreSQL, MySQL, SQL Server and Oracle databases; a real Db2 with IBM's driver; a SOAP server run by an independent library; Keycloak for signing in as a person; veraPDF for archival PDFs; poppler's pdfsig for seals. CI has a job for each of them (the real databases in one, Db2 in another, the rest with the product's own tests).

**What is still narrower than Adobe's, and why**, said in its row:

- Db2 runs through a gateway on our hosted servers: IBM makes its driver for Intel/AMD machines, not for the ARM machines we host on.
- A certificate made here for an organisation proves a sealed document has not changed; only a certificate from a certificate authority, which the organisation adds itself, also tells a stranger's PDF reader who the organisation is.
- A code for signers goes by email, or is something they know. By text message, it waits for a text-message service for signers.
- SOAP's old rpc/encoded style is refused in words, not spoken.
- A table's rule is turned into a form's limit only when it is about one column and made of plain comparisons. Anything else gives no limit (the database still refuses a wrong value when it is saved).
- Worked-out values are kept on the form (a fragment can carry them), not on the data source.

**Not built, on purpose**: Adobe's marketing products, customer-written functions in rules, rebuilding the inbox in code, print-room output (print streams, watched folders) and machine translation.

## Not from Adobe's pages, asked for by us

| Capability | Form Builder |
|---|---|
| Answers encrypted in the database, question by question | Built (10 Oct): the "Sensitive" switch on a question. See [sensitive-answers.md](sensitive-answers.md) |
