# Extensions: your own code in Form Builder

_For developers at a customer organisation, and for whoever deploys their code._

Most things are set up on screen: rules, formulas, workflows, approvals,
connectors. An **extension** is for the rest: logic only code can express. It
is a small service that belongs to one organisation. You write it against the
Form Builder SDK; it runs in a container of its own beside the product, never
inside it; and what it offers appears in the builder for your organisation
only.

You never receive or change Form Builder's own code, and your code never runs
inside Form Builder's servers.

## What an extension can offer

| You declare | A designer uses it | It runs |
|---|---|---|
| A **workflow step** | Workflow → Automations → add a step → Custom API | In the background, after a submission or a status change |
| A **list** | A dropdown's settings → Options come from → An API | When someone opens the dropdown |
| A **check** | Form settings → Checks from your extension | Before a submission is accepted, while the person waits |
| A **field** | The palette → Your extension → Custom field | In the person's browser, in a locked frame |

## Writing one

Start from `examples/extension-starter` (`pnpm stack ext init <directory>`
makes a copy that stands on its own). It is a complete project: one step,
one list, one check.

```ts
import { createExtension } from '@fb/sdk';

const ext = createExtension({ name: 'Acme rules' });

ext.step({ key: 'risk-score', label: 'Score the risk', outputs: ['score', 'band'] }, async ({ values, record }) => {
  const score = Math.min(100, Math.round(Number(values.amount) / 1000));
  return { summary: `Risk ${score}`, data: { score, band: score >= 70 ? 'HIGH' : 'LOW' } };
});

ext.list({ key: 'branches', label: 'Branches', params: ['city'] }, async ({ params }) =>
  BRANCHES.filter((b) => !params.city || b.city === params.city),   // rows of { value, label, ... }
);

ext.check({ key: 'gstin', label: 'GST number is genuine' }, async ({ values }) =>
  isGstin(values.gstin) ? undefined : { errors: { gstin: 'This is not a valid GST number.' } },
);

ext.listen();   // PORT (default 8080), FB_EXTENSION_SECRET
```

### Steps

- You receive the record (`id`, `ref`, `status`, `priority`, `assigneeId`,
  `submittedAt`), the answers (`values`), what the team filled in on the work
  item (`work`), the form, what started the flow (`trigger`) and what earlier
  steps returned (`steps`).
- Return a line for the record's timeline, or `{ summary, data }`. The fields
  of `data` you list in `outputs` are offered to the steps after yours: in a
  message as `{{$steps.<step>.<field>}}`, and in conditions ("band equals
  HIGH").
- Throw to fail the step. Your message is shown on the record's timeline.
- You have 15 seconds. The step runs from a queue; nobody is waiting on it.

### Lists

- Return rows with `value` and `label`. Other properties are allowed.
- `params` are names of answers the form may pass in, for a dropdown that
  depends on another field. Only parameters you declared reach your code, and
  one that is not answered yet is left out.
- The server asks your list again when a form is submitted, to make sure the
  chosen value is one you offered.
- You have 5 seconds. A person is looking at the dropdown.

### Checks

- A check runs only after the form's own rules have passed.
- Return nothing to accept. Return `{ errors: { fieldName: 'message' } }` to
  put a message under a field (`lines.0.qty` for a row of a repeating
  section), or `{ message }` to refuse with one message for the whole form.
- You have 5 seconds. **If your check cannot be reached or fails, the
  submission is refused**, and the person is asked to try again. Nothing is
  let through unchecked.
- A check must not change anything: it may run for a submission that is then
  refused for another reason. Do work in a step.

### Fields

A field of your own is a small web page that you supply and the form shows in
a frame. Use `fieldPage` to build it:

```ts
import { fieldPage } from '@fb/sdk';

ext.field(
  { key: 'stars', label: 'Star rating', height: 48 },
  fieldPage({
    body: '<div class="stars"></div>',
    style: '.stars button { font-size: 26px }',
    script: `
      fb.onInit(function (state) { /* state.value, state.readOnly, state.label, state.required */ });
      // ...draw, and when the person answers:
      fb.setValue('4');`,
  }),
);
```

- **The answer is text**, up to 10,000 characters. For something richer, store
  JSON as text. An empty string means "not answered", which is what a
  required field checks.
- `fb.onInit` gives you the value to show (the saved answer when someone comes
  back to a draft). `fb.onReadOnly` tells you when a rule switches the field
  off or on. The frame's height follows your content.
- **The frame is locked.** Your page cannot read the form around it, cannot
  use cookies or storage, and **cannot load or send anything over the
  network**: no scripts, styles, images or fonts from elsewhere, and no calls
  to any server. Everything it needs must be inside the page (images and
  fonts as `data:`). A page may be up to 200 KB.
- To look something up for a field, use a list (for options) or a step or
  check (for anything else); those run on the server.
- To judge what was entered, add a check. The form itself only knows the
  answer is text.
- Form Builder keeps a copy of your page each time it reads what you offer,
  and serves forms from the copy. A form does not stop working if your
  extension is down, and a new version of the page reaches forms when the
  extension is next read (each deployment does this).

### Rules for keys

Keys (`risk-score`) are stored in the forms and workflows that use them. Use
lower-case letters, digits and `-`. Never rename a key that is in use: add a
new one and move forms over.

## How it is deployed

1. You keep your extension in a repository of your own. It contains only your
   code: `package.json`, `tsconfig.json` and `src/`.
2. We build it and run it beside Form Builder, in a container that only Form
   Builder can reach: not the internet, not other customers. It cannot reach
   Form Builder's database, and it starts with no outbound access (see
   "Calling your own systems" below).
3. The first delivery installs it for your organisation and issues its
   secret, which the container is started with. You never handle it.
4. What you declared appears under **Administration → Extensions** and in the
   builder. Each later delivery replaces the running version and updates what
   is offered. If a new version does not start, the previous one keeps
   running.

### Deploying it yourself

Where your installation offers it, **Administration → Extensions** has a part
called **Deploy your own code**, and you do not wait for us:

1. Choose **Show the push commands**. You get a sign-in to your
   organisation's own image space. It works for an hour, for that space
   alone, and is not shown again.
2. In your repository (the starter kit comes with the `Dockerfile` to use),
   build for the kind of machine shown, and push, giving each version a name
   of its own:

   ```sh
   docker login <image space> -u AWS -p <password>
   docker build --platform linux/arm64 -t <image space>/fb-ext/<your organisation>:v1 .
   docker push <image space>/fb-ext/<your organisation>:v1
   ```
3. Choose the version and press **Deploy**. Within a minute it is running,
   and its steps, lists, checks and fields are offered in the builder. The
   page shows how it went; if the version did not start it says why, shows
   what your code printed, and the version before keeps running.

The simplest way is **Deploy from your repository** on the same page: link the
repository, add the read-only key it shows, choose the branch, and press
**Deploy now** or tick **Deploy on every commit**. Nothing to install.

If you build the image yourselves and want that on every commit, make a **deploy key** on the same page and
give it to your pipeline: the starter kit's `pipeline-examples/github-actions-deploy.yml` does
the rest (see [extension-deploy-guide.md](extension-deploy-guide.md)).

Only your organisation's administrators can do this, each request is in your
audit trail and your log (area *Extensions*), and the last ten versions you
pushed are kept. Whatever the image contains, it runs as an ordinary user,
cannot write to its own disk, has a fixed share of memory and processor, and
is on a network with Form Builder and nothing else.

Your plan must include extensions. The same repository works whether you are
on the shared installation or one of your own. For how we run this, see
[hosting.md](hosting.md).

## Calling your own systems

Your extension starts with no outbound access. Tell us which addresses it
needs (host and port); once they are agreed, your code calls them with an
ordinary `fetch` and nothing else changes:

```ts
ext.step({ key: 'erp-customer', label: 'Look up the customer in ERP', outputs: ['creditLimit'] }, async ({ values }) => {
  const res = await fetch(`https://erp.acme.com/customers/${encodeURIComponent(String(values.customer))}`);
  if (!res.ok) throw new Error(`ERP answered ${res.status}`);
  return { data: { creditLimit: (await res.json()).creditLimit } };
});
```

A call to an address that has not been agreed fails. If a call fails that you
expect to work, ask us: every attempt is recorded on our side with the reason.

## Security

- **Every request is signed.** Form Builder signs the method, path, body and
  time with your extension's secret (`X-FB-Signature`). The SDK refuses
  anything unsigned, altered, or more than five minutes old, before your code
  sees it. Only `/fb/health` answers without a signature, and it says nothing.
- **One organisation.** With `FB_ORG_ID` set, the SDK refuses requests made
  for any other organisation.
- **Nothing about the extension is shown** to the public or to your own
  users: not its address, not its secret, not its error messages on public
  forms.
- The secret is shown once, when the extension is installed. To replace it,
  the extension is removed and installed again.
- Requests and replies are limited to 1 MB.

## Testing your code

`ext.handle({ method, path, headers, body })` answers one request without a
server, and `sign(secret, { method, path, body })` produces the header, so a
unit test can call a step exactly as Form Builder would:

```ts
const body = JSON.stringify({ orgId: 'o1', values: { amount: 90000 }, record: { ref: 'LN-1' } });
const res = await ext.handle({ method: 'POST', path: '/fb/steps/risk-score', headers: { 'x-fb-signature': sign(SECRET, { method: 'POST', path: '/fb/steps/risk-score', body }) }, body });
```

## The contract (version 1)

For anyone writing an extension without the SDK, in any language.

| Request | Body | Reply |
|---|---|---|
| `GET /fb/health` (unsigned) | – | `{ "ok": true }` |
| `GET /fb/manifest` | – | `{ contract: 1, name, steps: [{ key, label, description?, outputs? }], lists: [{ key, label, description?, params? }], checks: [{ key, label, description? }], fields: [{ key, label, description?, height? }] }` |
| `POST /fb/steps/<key>` | `{ orgId, trigger, form, record, values, work, steps, stepKey, runKey }` (`runKey` is the same each time this step of this run is tried: use it so the work is done once) | `{ summary?, data? }` |
| `POST /fb/lists/<key>` | `{ orgId, params }` | `{ rows: [{ value, label, ... }] }` |
| `POST /fb/checks/<key>` | `{ orgId, form, values }` | `{ errors: { field: message }, message }` |
| `GET /fb/fields/<key>` | – | `{ html }`: a complete page, at most 200 KB |

Signature header: `X-FB-Signature: t=<unix seconds>,v1=<hex>` where `v1` is
HMAC-SHA256, keyed with the secret, of `<t>.<METHOD>.<path>.<body>`. A failure
is any status of 400 or above with `{ "error": "message" }`.

A field's page talks to the form with `postMessage`. Every message is an
object with `fb: 1`. The page sends `{ type: 'ready' }` once, then
`{ type: 'change', value: '<text>' }` and `{ type: 'height', height: <px> }`;
the form sends `{ type: 'init', value, readOnly, required, label }` in answer
to `ready`, and `{ type: 'readOnly', readOnly }` afterwards. The page is
served with `Content-Security-Policy: sandbox allow-scripts; default-src
'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;
font-src data:`.
