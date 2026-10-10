# Form Builder — guide for organisation admins

This covers setting up your organisation. Designers and records workers can
skip to the sections they need.

## 1. People and access

### Logs and the audit trail

Two places say what happened, and they are for different questions.

- **Logs** is what the product did for you, line by line, each with a level
  (Debug, Info, Warning, Error): a response arriving, each workflow step,
  each connector call, each email, signatures, sign-ins. Use it to find out
  why something did not happen.
  - **Show** narrows to a level and above; **From** to one part of the
    product; **Find** to words, a form code or a reference.
  - **Following** keeps new lines appearing by themselves. **Download**
    gives what is shown as a `.log` file.
  - Press a line to see its details.
  - **What is recorded** sets a level for each part. *Info* is the usual.
    *Debug* records far more (every connector call, each response sent back
    with mistakes) and is for finding a fault: you choose 1, 4 or 24 hours
    and it goes back to Info by itself. Choose also how long lines are kept
    (1 to 30 days; 14 unless changed).
  - A line never holds what people answered, a password or a key. Email
    addresses are shown as `r***@example.com`.
- **Audit trail** is what people changed, who did it and from where. It
  cannot be edited or deleted, and has no levels to set.

Admins and owners read both; only someone who manages the organisation
changes what the log records.

- **Members → Invite** with a role. Roles: Owner, Admin, Connector manager,
  Designer, Publisher, Records worker, Viewer.
- **Folders & access**: forms live in folders. Give someone a role *on a
  folder* (e.g. Designer on "Quality") and it applies to everything inside it.
- **Organisation → Security**: require two-factor sign-in for everyone.
- **Organisation → Single sign-on** (Business plan): connect Entra ID, Okta,
  Google Workspace or any OpenID Connect provider.
  1. In your provider, create a web app. Redirect URI: the one shown on the card.
     Scopes: `openid email profile`.
  2. Paste the issuer URL, client ID and secret; list your email domains and
     prove each one with the DNS TXT record shown (press Verify).
  3. Optionally add people automatically on first sign-in, with a role.
  4. Turn it on, sign out, and use **Sign in with SSO** once.
  5. Then you may **Require SSO**: password sign-in is refused for those domains.
- If your provider speaks **SAML 2.0** instead, choose it under **My identity
  provider uses**:
  1. In your provider, add a SAML application and give it the **metadata
     address** the card shows (or the reply address and identifier under it).
     Have it send the person's email address as the name ID.
  2. Download your provider's metadata file and choose it with **Fill in from
     your provider's metadata file**. That fills in its sign-in address,
     identifier and signing certificate; you can also type them. The file
     stays on your computer.
  3. Save, prove your email domains and turn it on, as above.
  The card shows when the provider's certificate runs out: paste the new one
  before then. Changing between OpenID Connect and SAML turns single sign-on
  off until the new one has worked once.

## 2. Building forms

- **Forms → New form**: start blank or from a template (including process
  templates such as a complaint register).
- Or start from a file: **A JSON Schema** gives one field for each property
  (nested objects become sections, lists of objects become repeating
  sections); **A spreadsheet** saved as CSV gives one field per column, with
  types guessed from the example rows under the header. Anything that could
  not be carried over is listed before the form is created.
- The builder saves drafts. **Publish** makes a version live; a published
  version never changes — edit by starting a new version.
- Styles (Organisation admins) are frozen into a version when it's published.
- **Export** (download icon) saves a form as a package file. **Import** on the
  Forms page brings it into another organisation or environment as a draft —
  missing styles are created (admins), and connectors it uses are listed so you
  can re-bind them.

### Fields added in this release

- **Repeating section**: people add a copy of the fields inside for every row
  ("add another line"). Set the fewest and most rows, the add-button text,
  whether rows show as cards or as a table, and which number fields to total.
  Uploads, signatures and other sections cannot go inside one.
- **Tabs** and **Accordion**: each Section dropped inside is a tab or a panel.
- **Switch**, **Tick boxes**, **Stepper**, **Picture**, **Signature** (drawn or
  typed) and **Terms & consent**.
- **Form settings → Review before sending** shows people all their answers,
  with a way back to each, before anything is submitted.
- CAPTCHA can use **hCaptcha** as well as reCAPTCHA and Turnstile.

### Rules

**Rules** in the builder's top bar holds the form's calculations and
conditional behaviour. Each rule is: *when* (always, a set of conditions, or a
formula that is true) → *then* one or more actions → optionally *otherwise*.

| Action | What it does |
|---|---|
| Show / Hide | The field or section appears only while the rule holds (or only while it does not). Hidden answers are not submitted. |
| Make required | Required while the rule holds. |
| Enable / Disable | Shown but not editable. |
| Set the value of | Fills the field from a formula, e.g. `round(quantity * unitPrice * 1.18, 2)`. The field becomes read-only. |
| Show an error on | Blocks submission with your message, e.g. when `endDate < startDate`. |
| Limit the options of | Offers only some of a fixed option list. |

Formulas use field names, numbers, text in quotes, `+ - * / %`, `&` to join
text, comparisons and `&&` `||` `!`. Functions include `sum`, `round`, `min`,
`max`, `if`, `concat`, `today`, `dateAdd` and `dateDiff`; the full list is
under "Writing formulas" in the dialog. A blank field counts as 0 in sums.

In a repeating section a rule works row by row: `qty * price` uses that
row's quantity and price. Outside the section the same name means the whole
column, so `sum(lineTotal)` adds up every row and `count(lines)` is the
number of rows.

Every rule is applied again on the server when the form is submitted: a
calculated value is always the server's own result, whatever was sent.

### Events

The **Events** tab of the same dialog is for things that happen once, at a
moment:

| When | What it can do |
|---|---|
| The form opens | Fill a field from a formula (e.g. a visit date of `dateAdd(today(), 7)`); look a row up and fill fields from it. |
| A button is clicked (add a Button field first) | The same, and open another step of a stepped form. |
| After a successful submit | Show a different message, or go to an address, for some answers (e.g. "A manager will call you" above 5,000). |
| When a submit fails | Show your own text instead of the standard error. |

A look-up reads the first row of a data source, sending the parameters you
list (`{{fieldName}}` for an answer), and copies the properties you choose
into fields. People can change what an event filled in. Events only help
the person filling in the form: anything that must hold belongs in a rule,
which the server checks.

### Time zone

**Form settings → Time zone** fixes what "today" means in rules, e.g.
`Asia/Kolkata`. Leave it empty to use the zone of whoever is filling in the
form.

### When a form is open, and publishing later

- **Form settings → Availability**: set when the form opens and closes, and
  the message people see once it has closed. Outside those times the public
  sees a notice instead of the questions. Staff can still raise items from
  inside.
- The same section has **Let people save and continue later**; switch it off
  for forms that should be finished in one go.
- **Schedule** (beside Publish) sets a draft to go live by itself at a time
  you choose, up to a year ahead. Until then the version that is live stays
  live. If the draft cannot be published when the time comes, the reason is
  shown on the form and nothing changes.

### Languages

- **Form settings → Languages and translations.** Choose the language the form
  is written in, then add the languages it should also be offered in.
- **Translate on screen:** each piece of the form's wording is listed with a
  box for its translation, and each language shows how much is done.
- **Or hand it to a translator:** *Export for a translator* gives a spreadsheet
  with a row for each piece of wording and a column for each language;
  *Import translations* reads it back.
- People pick their language on the form. A link can ask for one
  (`…?lang=hi`). Arabic and other right-to-left languages are laid out right
  to left.
- Whatever is not translated yet is shown in the form's own language, so a
  form can go live before every word is done.
- The form's own buttons and messages ("Submit", "is required") are built in
  for English, Hindi and Arabic. For any other language they appear in the
  same list to be translated.
- Answers are stored the same whatever language they were given in. Each
  response records its language, and its PDF is in that language.
- Use **Preview → Preview in** to see the form in each language.

### Review before publishing

- In the builder, **Review** shows where a draft stands and holds its
  comments.
- **Anyone who designs the form** can *Ask for a review*, with a note for the
  reviewer. Save the draft first, so the reviewer sees your changes.
- **Anyone who may publish it** can *Approve* or *Ask for changes* (with a
  reason). They are told by email when a review is asked for, the author is
  told when it is decided, and the Forms list shows which drafts are waiting.
- **Comments** can be about the whole form or about a field: select the field
  first. A comment links back to its field. Either side resolves or reopens
  a comment.
- By default review is advice: a form can be published without it.
- **Organisation → Security → Review before publishing** makes it a rule:
  - a form is published (or scheduled) only once it is approved;
  - the person who approves must be someone other than the one who asked for
    the review or last changed the form, so you need at least two people who
    can publish;
  - an approval covers exactly what was approved. Any change afterwards needs
    a new review.
- A new version starts with no review of its own.

### Versions

On the Forms list, the clock icon opens a form's versions. **What changed
since** lists, in words, everything that differs between that version and
the newest one. **Restore** brings an earlier version back as the draft; if a
draft is already open you are asked before it is replaced. Nothing changes
for the public until the restored draft is published.

## 3. Sharing forms

- Public link: `https://<forms host>/f/<your org id>/<FORM_CODE>`.
- Embed on your own website: on a published public form, **Embed** copies one
  line of HTML. Paste it where the form should appear. It sizes itself, and
  your page can listen for when it is sent:
  `document.addEventListener('submitted', (e) => …e.detail.submissionId)`.
  The same form as an element, in a chosen language:
  `<form-builder-form org="…" code="…" lang="hi"></form-builder-form>`.
- Draw the form yourself (headless): `GET /public/forms/CODE?org=ORG` returns
  the published form as JSON; `POST /public/forms/CODE/submissions?org=ORG`
  with `{ "values": { … } }` stores a response, or answers 422 with the
  faults field by field. Send an `idempotencyKey` (a UUID) so a retry is not
  stored twice. From a browser this needs your site's address added under
  Organisation → Custom domains.
- Embed by hand: add `?embed=1` inside an iframe; the page reports its height
  (`form-builder:resize`) and submission (`form-builder:submitted`) to the parent.
- **Your own domain** (Team plan and above): Organisation → Custom domains.
  Add `forms.yourcompany.com`, create the TXT record shown, press **Verify**,
  then point a CNAME at the address shown. Forms are then at
  `https://forms.yourcompany.com/<FORM_CODE>`.
- **Branding**: logo, brand colour; hide "Powered by Form Builder" on paid plans.
- **Save and continue later**: respondents get a private link valid for 30
  days (attachments must be added again when they come back).

### Sending emails from your own address

Emails to the people who fill in your forms (workflow emails, messages to a
requester, signing invitations, portal links) come from Form Builder unless
you set up your own mail server under **Organisation → Email sending**.

1. Choose where they go through:
   - **Microsoft 365:** in Microsoft Entra, register an application, give it
     the *Mail.Send* application permission with admin consent, and create a
     client secret. Paste the directory (tenant) ID, application ID and
     secret, and the mailbox to send from.
   - **Google Workspace or Gmail:** the address, and an *app password* made
     in that Google account (not its own password).
   - **Another mail server (SMTP):** its name, port, user name and password.
     The connection is always encrypted.
2. **Save**, then **Send me a test email**. It goes to your own address
   through your server. If it fails, the card says why in plain words.
3. When it has arrived, **Switch it on**.

Changing any setting switches it off until you have tested again. If your
server later refuses an email, the workflow step that sent it fails and says
why, and the card shows the last failure; nothing is sent from our address
in its place. Emails to your own team (invitations, password resets,
notifications) always come from Form Builder.

### The requests portal

A page where the people you serve start a form and follow what they sent.

1. **Organisation → Requests portal:** switch it on, give it a heading and a
   line of introduction. The card shows its address.
2. On each form to offer there: **Form settings → List on the requests
   portal**, then publish.

People open the page, choose a form, and send it. To see their requests they
enter their email and open the link sent to it. There are no passwords and
no accounts for you to manage. They see the reference, the form, the date and
the status of each response sent from that address, in your own status
names. They do not see the answers.

Which address a response belongs to: the form's contact email field
(Workflow → Requester's email is in), else its first email field.

## 4. Responses and work

### Sending a response to Power Automate, Zapier and the like

Add the step **Send to an automation tool** to an automation. Choose the
tool (Power Automate, Workfront Fusion, Zapier or Make) and paste the
address that tool gave your flow; the step says where to find it. The
response and the outputs of earlier steps are posted there, and what the
flow answers is available to later steps.

Treat the address like a password: anyone who has it can start the flow.
It is stored with the form and never shown in a record's history.

### How fast the form appears

**Responses → Analytics** says how long the form took to appear for the
people who opened it: the average, and the share of visits that had it
within two seconds.

### Where people give up

**Responses → Analytics → Question by question** lists every question with
how many people answered it, how many made a mistake on it, and how many
left the form with it as the last thing they touched. The line above the
table names the question most people stopped at. These are counts only:
nothing about who answered or what they wrote.

### Sending a response to be signed

Add the step **Send for signature** to an automation (Workflow → Automations).

- **Save answers as people go** (form settings, off unless you turn it on):
  nothing to press. Answers are kept every 30 seconds and are there again
  when the person comes back on the same phone or computer, with a **Start
  again** button if they are not theirs. Leave it off for forms filled in on
  a shared computer. Attachments are not kept.
- **Signers:** pick an email field of the form, type an address, or choose a
  member of staff. A new step already has the form's email field.
- **What is being signed:** the name signers see, for example
  `Loan agreement {{$record.ref}}`.
- **When there are several signers:** one after another in the order listed,
  or all at once.
- **Give up after (days):** 14 unless you change it.

Each signer gets an email with a private link. They read the PDF of the
response, type their name, draw a signature (or sign with the typed name),
and tick that they agree. They can also decline and say why.

The automation waits. Steps after it can use **Run only if… → Send for
signature → status** to do different things when it was signed by everyone,
declined, or ran out of time.

Open the record to see who has signed and who is still to sign. Once
everyone has, **Download signed PDF** gives the response with a last page
listing each signature, name, address, time and the document's fingerprint.
Every signer is emailed the same file. Signers who have not signed are
reminded every three days.

### The PDF of a response

Every response can be had as a PDF made by the server: your organisation's
name, logo and colour, the form's title, the reference and status, then every
answer in the order the form asks it. Repeating sections are tables,
signatures are shown as drawn, and choices appear as their labels.

- **Responses → the document icon** on a row downloads it. It is made the
  first time anyone asks and kept, so everyone gets the same file.
- **Form settings → Keep a PDF of each response** makes and stores it as each
  response arrives, without anyone asking.
- The same settings give the PDF its own title, a line at the foot of each
  page, and can list the questions nobody answered.
- A workflow email can carry it: in the email step, switch on **Attach the
  PDF of the response**.
- It is written in Latin scripts and the major Indian ones (Hindi, Bengali,
  Punjabi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam).
- A response's PDF follows the version of the form it was answered on. A
  later change to the form does not rewrite it.
- Only people who can see a form's responses can get its PDFs.

For developers, the same documents can be made from your own data
(designers of the form only):

- `POST /forms/<id>/document` with `{ "values": { ... }, "reference": "..." }`
  returns the PDF. Nothing is stored.
- `POST /forms/<id>/documents/batch` with `{ "items": [ { ... }, ... ] }`
  (up to 1,000) queues them; `GET /documents/batches/<id>` reports progress
  and `GET /documents/batches/<id>/<n>` returns the n-th document.

- **Submissions** (inbox icon on a form): table of responses, CSV export,
  print / save as PDF per response, and analytics — opened, started,
  submitted, with rates, for 7/30/90 days.
- Forms with a workflow create **work items**: Work inbox, Dashboard,
  statuses, actions, approvals, SLA with working time, emails and webhooks.

### Fragments: one section for several forms

A **fragment** is a section of fields kept once in the library and used on
any number of forms: an address, bank details, a declaration.

- **To make one** (admins): in a form, select a section and choose **Save as
  fragment**. That section becomes a copy of it.
- **To use one** (anyone who can design the form): pick it under **Fragments**
  in the palette. It is added as a section at the end; move it where you want.
- **Its fields are the library's.** On a form they are shown but cannot be
  changed, moved or deleted. The section itself is yours: rename it, move it,
  remove it.
- **Twice on one form** (a billing and a shipping address): the second copy is
  given a **prefix**, so its answers are stored apart (`shipping_city`). You
  can change the prefix in the section's settings.
- **To change a fragment** (admins): in any form that uses it, select the
  section, choose **Change this fragment**, edit its fields, then **Save to
  the library**.
- **A change reaches each form the next time that form is published.** Live
  forms are never altered. A draft opened in the builder is brought up to date
  straight away, so you see what will be published.
- **Detach from the library** keeps the fields as that form's own and stops
  following the fragment.
- **Fragments** in the menu lists them with the forms that use each. One in
  use cannot be deleted.
- A field inside a fragment may depend only on other fields of the same
  fragment. Rules on the form may use a fragment's fields like any others.

### One workflow for several forms

A workflow can belong to one form, or sit in the **Workflows** library and be
used by any number of forms, so that a complaint form, a returns form and a
warranty form all follow the same steps.

- **To put one in the library** (admins): either open **Workflows → New
  workflow**, or open a form that already has the workflow you want, choose
  **Workflow → Save to library** and give it a name. That form then uses it
  from the library too.
- **To use one on a form** (anyone who can design the form): open the form's
  **Workflow** and pick it under *Workflow for this form*.
- **Answers it reads.** A workflow may need a few of the form's answers, for
  example the requester's email or how urgent it is. Fields with the same name
  are matched for you. For the rest, you choose the field from a list. The
  form cannot be published until each one has a field, and the message says
  which is missing.
- **Reference prefix** is set per form, so each form keeps its own numbering
  (RET-000001, CMP-000001) while sharing the process.
- **Changing a library workflow** changes nothing that is already live. Each
  form picks the change up the next time it is published. Work items already
  in progress carry on with the version they started with.
- **Copy into this form to change it** gives the form its own copy and stops
  it following the library.
- A workflow that a form uses cannot be deleted; the page says which forms.
- A rule that tests a choice ("Severity is Serious") compares the stored value
  of that choice. Forms that share the workflow should offer the same choices.
- A form exported to another organisation takes its workflow with it as the
  form's own.

## 5. Your own code (extensions)

When something cannot be set up on screen, your developers can write it as an
**extension**: a small service of your own that we run for your organisation
only. See [extensions.md](extensions.md) for developers.

- **Administration → Extensions** shows whether yours is running and what it
  offers. After your developers ship a new version, choose **Read again**.
- **Workflow steps** it offers are picked under Workflow → Automations →
  Custom API, and what a step returns can steer the steps after it.
- **Lists** it offers can be chosen as where a dropdown's options come from.
- **Fields** it draws appear in the builder's palette under *Your extension*.
  They run in a locked frame on the form and store their answer as text.
- **Checks** it offers are ticked in a form's settings. They run before a
  submission is accepted. If a check objects, or cannot be run, the
  submission is refused and the person is asked to try again.

## 6. Your data (connectors)

- **Connectors → New connector** (Connector managers): MongoDB, PostgreSQL,
  MySQL, SQL Server, Supabase, REST API, OData, Salesforce, Google Sheets,
  Excel, SharePoint or OneDrive folder, Azure Blob Storage, Amazon S3,
  CloudWatch Logs.
- **Salesforce:** your Salesforce address (Setup → My Domain), and the
  consumer key and secret of a connected app that has the *client
  credentials flow* switched on and a "run as" user chosen. Leads, contacts,
  cases and your own objects are then found with their fields.
- **Google Sheets:** in Google Cloud create a service account, add a JSON
  key and switch on the Sheets API. Share the sheet with the account's email
  address as an editor. Paste the sheet's address and the key file. Each tab
  is a table; its first row holds the column headings.
- **Excel, and a SharePoint or OneDrive folder:** register an application in
  Microsoft Entra with the *Files.ReadWrite.All* application permission
  (*Sites.ReadWrite.All* for SharePoint) and admin consent. Paste its
  directory ID, application ID and secret, and the link from **Share → Copy
  link** on the workbook or folder. A workbook needs a table (Insert →
  Table).
- **Azure Blob Storage:** the container's address and a shared access
  signature for that container allowing Create, Write and List.
- **Saving a response:** expose a table's *insert* (or a folder's *upload*)
  on the connector, then add it to an automation as **Run a custom API**.
  Under **What goes into each field** the builder shows which answer fills
  each column, matched by name; change any that are wrong. A folder,
  container or bucket receives the answers as a file, the PDF beside it, and
  what the respondent uploaded in a folder next to them
  (`FORM/REF.json`, `FORM/REF.pdf`, `FORM/REF-files/…`).
- **When a table gains columns:** a form started from a connected table
  remembers it. Once the connector manager has exposed the new columns, the
  builder shows a line naming them, with **Add them to the form** and
  **Leave them out**.
- **OData** reaches Dynamics 365, SAP and other systems that offer an OData
  service. Give the service's address and how it signs in; its tables, fields
  and each table's key are then found for you. For Dynamics, sign in **as an
  application**: the token address, client ID and secret come from an app
  registration in Microsoft Entra, and the scope is your Dynamics address
  followed by `/.default`.
- Credentials are encrypted and never shown again. **Test**, **Expose** the
  tables/fields/operations forms may use (nothing is usable until exposed),
  and keep it read-only unless forms must write.
- Use a database user with only the rights forms need.
- **Databases on a private network**: create a **Gateway**, run the agent on a
  machine that can reach the database (it only connects out), then create the
  connector with "Where it runs" = that gateway and put the credentials in the
  agent's `connectors.json`. See `apps/gateway/README.md`.

## 7. Plan and usage

Organisation → **Plan & usage** shows your plan and what's used this month.
When a limit is reached the action says so; public forms stop accepting
responses at the monthly response quota (respondents see a neutral message).
