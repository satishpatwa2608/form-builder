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
