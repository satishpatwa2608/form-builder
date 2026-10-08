# Form Builder — guide for organisation admins

This covers setting up your organisation. Designers and records workers can
skip to the sections they need.

## 1. People and access

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

## 2. Building forms

- **Forms → New form**: start blank or from a template (including process
  templates such as a complaint register).
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

### Versions

On the Forms list, the clock icon opens a form's versions. **What changed
since** lists, in words, everything that differs between that version and
the newest one. **Restore** brings an earlier version back as the draft; if a
draft is already open you are asked before it is replaced. Nothing changes
for the public until the restored draft is published.

## 3. Sharing forms

- Public link: `https://<forms host>/f/<your org id>/<FORM_CODE>`.
- Embed: add `?embed=1` inside an iframe; the page reports its height
  (`form-builder:resize`) and submission (`form-builder:submitted`) to the parent.
- **Your own domain** (Team plan and above): Organisation → Custom domains.
  Add `forms.yourcompany.com`, create the TXT record shown, press **Verify**,
  then point a CNAME at the address shown. Forms are then at
  `https://forms.yourcompany.com/<FORM_CODE>`.
- **Branding**: logo, brand colour; hide "Powered by Form Builder" on paid plans.
- **Save and continue later**: respondents get a private link valid for 30
  days (attachments must be added again when they come back).

## 4. Responses and work

- **Submissions** (inbox icon on a form): table of responses, CSV export,
  print / save as PDF per response, and analytics — opened, started,
  submitted, with rates, for 7/30/90 days.
- Forms with a workflow create **work items**: Work inbox, Dashboard,
  statuses, actions, approvals, SLA with working time, emails and webhooks.

## 5. Your data (connectors)

- **Connectors → New connector** (Connector managers): MongoDB, PostgreSQL,
  MySQL, Supabase, REST API, Amazon S3, CloudWatch Logs.
- Credentials are encrypted and never shown again. **Test**, **Expose** the
  tables/fields/operations forms may use (nothing is usable until exposed),
  and keep it read-only unless forms must write.
- Use a database user with only the rights forms need.
- **Databases on a private network**: create a **Gateway**, run the agent on a
  machine that can reach the database (it only connects out), then create the
  connector with "Where it runs" = that gateway and put the credentials in the
  agent's `connectors.json`. See `apps/gateway/README.md`.

## 6. Plan and usage

Organisation → **Plan & usage** shows your plan and what's used this month.
When a limit is reached the action says so; public forms stop accepting
responses at the monthly response quota (respondents see a neutral message).
